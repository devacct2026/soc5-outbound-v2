"use client";

// Live data overlay for the approved dashboard. Signed out: the existing mock data
// is shown unchanged. Signed in: real requests, pipeline counts and KPI cards from
// /api/v1, refreshed every 30 s (polling until a Supabase Realtime client is added).
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { apiGet, clearToken, getToken, signIn } from "@/lib/api-client";
import { buildKpis, buildPipeline, mapRequest, type ApiMetrics, type ApiRequest } from "@/lib/live-data";
import type { LinehaulRequest } from "@/lib/dashboard-data";

type Live = {
  requests: LinehaulRequest[];
  pipeline: ReturnType<typeof buildPipeline>;
  kpis: ReturnType<typeof buildKpis>;
  updatedAt: Date;
};

const REFRESH_MS = 30_000;

function subscribe(cb: () => void) {
  window.addEventListener("soc5-auth-change", cb);
  return () => window.removeEventListener("soc5-auth-change", cb);
}

export function useLiveDashboard() {
  const signedIn = useSyncExternalStore(subscribe, () => getToken() !== null, () => false);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [list, metrics, intraday] = await Promise.all([
        apiGet<{ data: ApiRequest[] }>("/requests?limit=100"),
        apiGet<ApiMetrics>("/requests/metrics"),
        apiGet<{ data: { orderQty: number }[] }>(`/dispatch/intraday?date=${today}`).catch(() => null),
      ]);
      setLive({
        requests: list.data.map(mapRequest),
        pipeline: buildPipeline(metrics),
        kpis: buildKpis(metrics, intraday ? intraday.data.reduce((s, r) => s + r.orderQty, 0) : null),
        updatedAt: new Date(),
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load live data");
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [signedIn, refresh]);

  return { signedIn, live: signedIn ? live : null, error: signedIn ? error : null, refresh };
}

export function LiveConnect({ signedIn, error }: { signedIn: boolean; error: string | null }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (signedIn) {
    return (
      <span className="live-connect">
        <small role={error ? "alert" : undefined}>{error ? `Live data error: ${error}` : "Connected to live API"}</small>{" "}
        <button type="button" className="text-link" onClick={() => clearToken()}>Sign out</button>
      </span>
    );
  }
  if (!open) {
    return <button type="button" className="text-link" onClick={() => setOpen(true)}>Connect live data</button>;
  }
  return (
    <form
      className="live-connect"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage(null);
        try {
          await signIn(email, password);
          setPassword("");
          setOpen(false);
        } catch (err) {
          setMessage(err instanceof Error ? err.message : "Sign-in failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span className="sr-only">Email</span>
        <input type="email" required autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>{" "}
      <label>
        <span className="sr-only">Password</span>
        <input type="password" required autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>{" "}
      <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>{" "}
      <button type="button" className="text-link" onClick={() => setOpen(false)}>Cancel</button>
      {message && <small role="alert"> {message}</small>}
    </form>
  );
}
