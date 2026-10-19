"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ApiError, apiGet, friendlyError, getToken } from "@/lib/api-client";
import { PAGE_SIZES, type Me, type PageSize } from "@/lib/request-ui";

const subscribe = (cb: () => void) => {
  window.addEventListener("soc5-auth-change", cb);
  return () => window.removeEventListener("soc5-auth-change", cb);
};
export const useSignedIn = () => useSyncExternalStore(subscribe, () => getToken() !== null, () => false);

export type AccountState =
  | { kind: "loading" }
  | { kind: "ready"; me: Me }
  | { kind: "pending" }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

/** Who am I? Works for PENDING_APPROVAL/DISABLED identities too (via /auth/status), so they get a clear message. */
export function useAccount(): { state: AccountState; reload: () => void } {
  const signedIn = useSignedIn();
  const [state, setState] = useState<AccountState>({ kind: "loading" });
  const reload = useCallback(async () => {
    try {
      const s = await apiGet<{ account_status: string; role: string | null; must_change_password: boolean }>("/auth/status");
      if (s.account_status === "PENDING_APPROVAL") return setState({ kind: "pending" });
      if (s.account_status === "DISABLED") return setState({ kind: "disabled" });
      const me = await apiGet<Me>("/auth/me");
      setState({ kind: "ready", me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // token cleared by apiGet; the signed-out UI takes over
      setState({ kind: "error", message: friendlyError(e) });
    }
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [signedIn, reload]);
  return { state: signedIn ? state : { kind: "loading" }, reload };
}

export function Notice({ notice }: { notice: { kind: "ok" | "error"; text: string } | null }) {
  if (!notice) return null;
  return (
    <p role={notice.kind === "error" ? "alert" : "status"} className="module-note ops-notice" data-kind={notice.kind}>
      {notice.text}
    </p>
  );
}

export function PageSizeSelect({ value, onChange }: { value: PageSize; onChange: (n: PageSize) => void }) {
  return (
    <label className="ops-inline">
      Rows per page{" "}
      <select value={value} onChange={(e) => onChange(Number(e.target.value) as PageSize)} aria-label="Rows per page">
        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

export function PagerBar({ page, hasMore, onPrev, onNext, busy }: { page: number; hasMore: boolean; onPrev: () => void; onNext: () => void; busy?: boolean }) {
  return (
    <nav className="ops-pager" aria-label="Pagination">
      <button type="button" className="ops-btn" onClick={onPrev} disabled={page === 0 || busy}>Previous</button>
      <span aria-live="polite">Page {page + 1}</span>
      <button type="button" className="ops-btn" onClick={onNext} disabled={!hasMore || busy}>Next</button>
    </nav>
  );
}

export function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <label className="ops-field">
      <span>{label}</span>
      {children}
      {error && <small role="alert" className="ops-error">{error}</small>}
    </label>
  );
}

export const roleLabel = (r: string) => r.replace("_", " ");

/**
 * Lazily minted idempotency key: created on first use inside an event handler (never during render, which must stay
 * deterministic for prerendering), reused for retries of the same submission, and replaced after success.
 */
export function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  return {
    get: () => (ref.current ??= crypto.randomUUID()),
    reset: () => {
      ref.current = null;
    },
  };
}
