"use client";

// Account banners shown on every page once signed in: awaiting approval, disabled, and the FORCED password change
// (the API blocks every other endpoint until it is done; this screen is how the user completes it).
import { useEffect, useRef, useState } from "react";
import { apiSend, friendlyError } from "@/lib/api-client";
import { Field, useAccount, useIdempotencyKey, useSignedIn } from "./common";

const HEARTBEAT_MS = 30_000;

/**
 * SEA-6 presence: an FTE Ops user with the app open sends a heartbeat every 30 s so approvals can be routed to them.
 * Beats pause while the tab is hidden (the original kept sending), skip while one is in flight, and ignore errors.
 */
function useHeartbeat(active: boolean) {
  const inFlight = useRef(false);
  useEffect(() => {
    if (!active) return;
    const beat = async () => {
      if (inFlight.current || document.visibilityState === "hidden") return;
      inFlight.current = true;
      try {
        await apiSend("POST", "/presence/heartbeat", undefined, crypto.randomUUID());
      } catch {
        /* presence is best effort; routing simply treats a missing beat as absent */
      } finally {
        inFlight.current = false;
      }
    };
    const first = setTimeout(beat, 0);
    const timer = setInterval(beat, HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
}

export function SessionGate() {
  const signedIn = useSignedIn();
  const { state, reload } = useAccount();
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useIdempotencyKey();
  useHeartbeat(signedIn && state.kind === "ready" && state.me.role === "fte_ops" && !state.me.must_change_password);

  if (!signedIn) return null;
  if (state.kind === "pending") return <p className="panel module-content ops-banner" role="status">Your account is awaiting administrator approval. You have no operational access until an administrator approves it and assigns your role.</p>;
  if (state.kind === "disabled") return <p className="panel module-content ops-banner" role="alert">This account is disabled. Contact your administrator.</p>;
  if (state.kind === "error") return <p className="panel module-content ops-banner" role="alert">{state.message}</p>;
  if (state.kind !== "ready" || !state.me.must_change_password) return null;

  const submit = async () => {
    if (pw.length < 12) return setMsg("Password must be at least 12 characters.");
    if (pw !== again) return setMsg("Passwords do not match.");
    setBusy(true);
    setMsg(null);
    try {
      await apiSend("POST", "/auth/password-changed", { password: pw }, key.get());
      key.reset();
      setPw("");
      setAgain("");
      reload();
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel module-content ops-form ops-banner" aria-label="Change password" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>Change your password</h2>
      <p className="module-note">Your password was set by an administrator. Choose a new one (at least 12 characters) to continue.</p>
      <div className="ops-grid">
        <Field label="New password"><input type="password" autoComplete="new-password" required maxLength={200} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="Confirm new password"><input type="password" autoComplete="new-password" required maxLength={200} value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
      </div>
      {msg && <p role="alert" className="ops-error">{msg}</p>}
      <button type="submit" className="ops-btn ops-primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
    </form>
  );
}
