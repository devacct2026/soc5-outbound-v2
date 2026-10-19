// WebSocket-first realtime (lead 10): a small client for the Supabase Realtime wire protocol (Phoenix channels,
// JSON v1.0.0) using the browser's native WebSocket, so no extra dependency is needed. RLS remains the visibility
// boundary: the socket authenticates with the signed-in user's access token, never a service key.
//
// Realtime events are best-effort signals (NOT-3), never proof of delivery: every consumer refetches over HTTP when
// notified, and after any reconnect `onRecover` fires so missed events are recovered by a full refresh.
// LIVE-UNVERIFIED: exercised here only against a fake WebSocket (protocol per Supabase Realtime docs).
export type RealtimeStatus = "connecting" | "connected" | "disconnected";

interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RealtimeOptions {
  /** https://<project>.supabase.co */
  url: string;
  anonKey: string;
  getToken: () => string | null;
  tables: string[];
  onChange: (table: string) => void;
  onStatus?: (s: RealtimeStatus) => void;
  /** Fired after a RE-subscription (not the first): events may have been missed, so refetch everything. */
  onRecover?: () => void;
  WebSocketImpl?: new (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  heartbeatMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface RealtimeHandle {
  stop(): void;
  status(): RealtimeStatus;
}

export const backoffMs = (attempt: number, base = 1000, max = 30_000) => Math.min(max, base * 2 ** Math.min(Math.max(attempt, 0), 16));

export function startRealtime(opts: RealtimeOptions): RealtimeHandle {
  const WS = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => SocketLike);
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  let ws: SocketLike | null = null;
  let status: RealtimeStatus = "disconnected";
  let stopped = false;
  let attempts = 0;
  let everConnected = false;
  let ref = 0;
  let hbTimer: unknown = null;
  let retryTimer: unknown = null;
  let awaitingHeartbeat = false;
  let lastToken: string | null = null;
  let joined = new Set<string>();
  const topics = opts.tables.map((t) => ({ topic: `realtime:soc5-${t}`, table: t }));

  const setStatus = (s: RealtimeStatus) => {
    if (s !== status) {
      status = s;
      opts.onStatus?.(s);
    }
  };
  const send = (m: Record<string, unknown>) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...m, ref: String(++ref) }));
  };
  const joinAll = (token: string) => {
    for (const t of topics) {
      send({
        topic: t.topic, event: "phx_join",
        payload: {
          config: { broadcast: { ack: false, self: false }, presence: { key: "" }, private: false, postgres_changes: [{ event: "*", schema: "public", table: t.table }] },
          access_token: token,
        },
      });
    }
  };

  const clearHeartbeat = () => {
    if (hbTimer !== null) clearT(hbTimer);
    hbTimer = null;
  };
  const scheduleReconnect = () => {
    if (stopped || retryTimer !== null) return;
    const delay = backoffMs(attempts++, opts.backoffBaseMs, opts.backoffMaxMs);
    retryTimer = setT(() => {
      retryTimer = null;
      connect();
    }, delay);
  };
  const dropSocket = () => {
    clearHeartbeat();
    const s = ws;
    ws = null;
    joined = new Set();
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    setStatus("disconnected");
    scheduleReconnect();
  };
  const beat = () => {
    if (!ws) return;
    if (awaitingHeartbeat) return dropSocket(); // no reply to the previous heartbeat: the link is dead
    awaitingHeartbeat = true;
    send({ topic: "phoenix", event: "heartbeat", payload: {} });
    // Pick up a refreshed or revoked token without reconnecting.
    const t = opts.getToken();
    if (!t) return stop();
    if (t !== lastToken) {
      lastToken = t;
      for (const x of topics) send({ topic: x.topic, event: "access_token", payload: { access_token: t } });
    }
    hbTimer = setT(beat, heartbeatMs);
  };

  function connect() {
    if (stopped) return;
    const token = opts.getToken();
    if (!token) return stop(); // signed out: nothing to listen for
    lastToken = token;
    awaitingHeartbeat = false;
    setStatus("connecting");
    const base = opts.url.replace(/^http/, "ws").replace(/\/$/, "");
    const sock = new WS(`${base}/realtime/v1/websocket?apikey=${encodeURIComponent(opts.anonKey)}&vsn=1.0.0`);
    ws = sock;
    sock.onopen = () => {
      joinAll(token);
      hbTimer = setT(beat, heartbeatMs);
    };
    sock.onmessage = (ev) => {
      let m: { topic?: string; event?: string; payload?: Record<string, unknown> };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.topic === "phoenix" && m.event === "phx_reply") {
        awaitingHeartbeat = false;
        return;
      }
      if (m.event === "phx_reply" && m.topic && (m.payload as { status?: string } | undefined)?.status === "ok") {
        joined.add(m.topic);
        if (joined.size === topics.length && status !== "connected") {
          setStatus("connected");
          attempts = 0;
          if (everConnected) opts.onRecover?.(); // a re-subscription: anything could have been missed meanwhile
          everConnected = true;
        }
        return;
      }
      if (m.event === "phx_reply" || m.event === "phx_error" || m.event === "phx_close") {
        if ((m.payload as { status?: string } | undefined)?.status === "error" || m.event !== "phx_reply") dropSocket();
        return;
      }
      if (m.event === "postgres_changes") {
        const table = ((m.payload?.data as { table?: unknown } | undefined)?.table ?? "") as string;
        if (opts.tables.includes(table)) opts.onChange(table);
      }
    };
    sock.onclose = () => {
      if (ws === sock) dropSocket();
    };
    sock.onerror = () => {
      if (ws === sock) dropSocket();
    };
  }

  function stop() {
    stopped = true;
    if (retryTimer !== null) clearT(retryTimer);
    retryTimer = null;
    clearHeartbeat();
    const s = ws;
    ws = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    setStatus("disconnected");
  }

  connect();
  return { stop, status: () => status };
}
