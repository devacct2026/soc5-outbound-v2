"use client";

// One realtime socket per tab, shared by every screen. WebSocket-first: while the socket is connected nothing
// polls; while it is not (not configured, connecting, dropped) screens fall back to a 30 s poll. After any
// reconnect every subscriber refetches (missed events are recovered over HTTP, never assumed delivered).
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getToken } from "./api-client";
import { startRealtime, type RealtimeHandle, type RealtimeStatus } from "./realtime";

type Listener = { tables: string[] | null; refresh: () => void };

const REALTIME_URL = process.env.NEXT_PUBLIC_SOC5_REALTIME_URL ?? "";
const REALTIME_KEY = process.env.NEXT_PUBLIC_SOC5_REALTIME_ANON_KEY ?? ""; // public by design; RLS protects the data
const POLL_MS = 30_000;
const DEBOUNCE_MS = 250;

let handle: RealtimeHandle | null = null;
let status: RealtimeStatus = "disconnected";
const listeners = new Set<Listener>();
const statusSubs = new Set<() => void>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(all: boolean) {
  const tables = new Set(pending);
  pending.clear();
  for (const l of [...listeners]) if (all || l.tables === null || l.tables.some((t) => tables.has(t))) l.refresh();
}
function queue(table: string | null) {
  if (table) pending.add(table);
  if (timer) return;
  const all = table === null;
  timer = setTimeout(() => {
    timer = null;
    flush(all);
  }, DEBOUNCE_MS);
}

function ensureStarted() {
  if (handle || typeof window === "undefined" || !REALTIME_URL || !REALTIME_KEY || !getToken()) return;
  handle = startRealtime({
    url: REALTIME_URL,
    anonKey: REALTIME_KEY,
    getToken,
    tables: ["requests", "notifications", "intraday_dispatch"],
    onChange: (t) => queue(t),
    onRecover: () => queue(null),
    onStatus: (s) => {
      status = s;
      statusSubs.forEach((f) => f());
      if (s === "disconnected" && !getToken()) handle = null;
    },
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("soc5-auth-change", () => {
    if (getToken()) ensureStarted();
    else {
      handle?.stop();
      handle = null;
    }
  });
}

/** True when the realtime socket is up (screens then skip polling). */
export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(
    (cb) => {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
    () => status,
    () => "disconnected" as RealtimeStatus,
  );
}

/**
 * Call `refresh` on mount and whenever its identity changes, whenever one of `tables` changes (debounced), after every reconnect, and on a 30 s
 * poll only while the socket is not connected.
 */
export function useLiveRefresh(refresh: () => void, tables: string[] | null, enabled = true) {
  const ref = useRef(refresh);
  useEffect(() => {
    ref.current = refresh; // always call the latest closure without re-subscribing
  });
  const st = useRealtimeStatus();
  const key = tables?.join(",") ?? "*";
  useEffect(() => {
    if (!enabled) return;
    ensureStarted();
    const l: Listener = { tables: tables, refresh: () => ref.current() };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  // Load on mount AND whenever the caller's `refresh` identity changes (filters, page, page size): `refresh` must be
  // memoized with useCallback so it only changes when its inputs do.
  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => ref.current(), 0);
    return () => clearTimeout(first);
  }, [refresh, enabled]);
  useEffect(() => {
    if (!enabled || st === "connected") return;
    const i = setInterval(() => ref.current(), POLL_MS);
    return () => clearInterval(i);
  }, [st, enabled]);
}
