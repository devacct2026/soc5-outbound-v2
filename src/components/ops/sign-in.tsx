"use client";

// Sign-in (lead 6): email & password, Ops ID, email one-time code, Google and Login with SeaTalk. The browser only ever
// handles a short-lived access token; account approval state and forced password change are handled by SessionGate.
import { useEffect, useRef, useState } from "react";
import { ApiError, friendlyError, googleUrl, requestEmailCode, seatalkConfig, signIn, signInOpsId, verifyEmailCode } from "@/lib/api-client";
import { Field } from "./common";

type Method = "password" | "ops" | "code" | "google" | "seatalk";
const LABELS: Record<Method, string> = { password: "Email & password", ops: "Ops ID", code: "Email code", google: "Google", seatalk: "SeaTalk" };

/** The SDK is a third-party script: only the documented SeaTalk CDN origin over https is ever loaded. */
export function isAllowedSeaTalkSdkUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.origin === "https://static.cdn.haiserve.com" && !u.username && !u.password;
  } catch {
    return false;
  }
}

function SeaTalkLogin() {
  const host = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState<string | null>("Loading SeaTalk login…");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await seatalkConfig();
        if (cancelled || !host.current) return;
        if (!isAllowedSeaTalkSdkUrl(cfg.sdk_url)) return setMessage("SeaTalk login is misconfigured.");
        host.current.innerHTML = "";
        const info = document.createElement("div");
        info.id = "seatalk_login_app_info";
        info.dataset.appid = cfg.app_id;
        info.dataset.redirect_uri = cfg.redirect_uri;
        info.dataset.response_type = cfg.response_type;
        info.dataset.state = cfg.state;
        const button = document.createElement("div");
        button.id = "seatalk_login_button";
        button.dataset.size = "default";
        button.dataset.copywriting = "Continue with SeaTalk";
        button.dataset.align = "center";
        host.current.append(info, button);
        const script = document.createElement("script");
        script.src = cfg.sdk_url;
        script.async = true;
        script.onload = () => {
          (window as unknown as { SEATALK_LOGIN?: { init?: () => void } }).SEATALK_LOGIN?.init?.();
          setMessage(null);
        };
        script.onerror = () => setMessage("Unable to load SeaTalk login. Try again.");
        host.current.append(script);
      } catch (e) {
        setMessage(e instanceof ApiError && e.status === 503 ? "Login with SeaTalk is not configured." : friendlyError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div>
      <div ref={host} />
      {message && <small role="status"> {message}</small>}
      <small className="ops-hint">New SeaTalk members are registered as pending until an administrator approves them.</small>
    </div>
  );
}

export function SignInPanel({ onClose }: { onClose: () => void }) {
  const [method, setMethod] = useState<Method>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ops, setOps] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      done?.();
    } catch (e) {
      setMessage(e instanceof Error && !(e instanceof ApiError) ? e.message : e instanceof ApiError && e.status === 401 && method === "password" ? e.message : friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="live-connect ops-signin">
      <div role="tablist" aria-label="Sign-in method" className="ops-tabs">
        {(Object.keys(LABELS) as Method[]).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={method === m} className="text-link" data-active={method === m} onClick={() => { setMethod(m); setMessage(null); }}>
            {LABELS[m]}
          </button>
        ))}
      </div>
      {method === "password" && (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await signIn(email, password); setPassword(""); }, onClose); }}>
          <label><span className="sr-only">Email</span><input type="email" required autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>{" "}
          <label><span className="sr-only">Password</span><input type="password" required autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{" "}
          <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
      )}
      {method === "ops" && (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await signInOpsId(ops.trim(), password); setPassword(""); }, onClose); }}>
          <label><span className="sr-only">Ops ID</span><input required pattern="[Oo][Pp][Ss][0-9]+" maxLength={40} autoComplete="username" placeholder="Ops ID (ops12345)" value={ops} onChange={(e) => setOps(e.target.value)} /></label>{" "}
          <label><span className="sr-only">Password</span><input type="password" required autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{" "}
          <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in with Ops ID"}</button>
          <small className="ops-hint">Forgot your password? Ask your FTE to reset it. No Ops ID yet? <RequestAccess /></small>
        </form>
      )}
      {method === "code" && (
        <form onSubmit={(e) => {
          e.preventDefault();
          if (!codeSent) void run(async () => { await requestEmailCode(email.trim().toLowerCase()); }, () => { setCodeSent(true); setMessage("We sent a 6-digit code to your work email."); });
          else void run(async () => { await verifyEmailCode(email.trim().toLowerCase(), code.trim()); }, onClose);
        }}>
          <label><span className="sr-only">Work email</span><input type="email" required autoComplete="email" placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={codeSent} /></label>{" "}
          {codeSent && <label><span className="sr-only">6-digit code</span><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}{" "}
          <button type="submit" disabled={busy}>{codeSent ? "Verify code" : "Email me a code"}</button>
          {codeSent && <button type="button" className="text-link" onClick={() => { setCodeSent(false); setCode(""); }}>Use a different email</button>}
        </form>
      )}
      {method === "google" && (
        <div>
          <button type="button" disabled={busy} onClick={() => void run(async () => { window.location.assign((await googleUrl()).url); })}>Continue with Google</button>
          <small className="ops-hint">Use your work Google account. New accounts wait for administrator approval.</small>
        </div>
      )}
      {method === "seatalk" && <SeaTalkLogin />}
      {message && <small role="alert"> {message}</small>}{" "}
      <button type="button" className="text-link" onClick={onClose}>Cancel</button>
    </div>
  );
}

function RequestAccess() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [opsId, setOpsId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!open) return <button type="button" className="text-link" onClick={() => setOpen(true)}>Request access</button>;
  return (
    <span>
      <input placeholder="Full name" value={name} minLength={2} maxLength={120} onChange={(e) => setName(e.target.value)} aria-label="Full name" />{" "}
      <input placeholder="Ops ID" value={opsId} maxLength={40} onChange={(e) => setOpsId(e.target.value)} aria-label="Ops ID to register" />{" "}
      <button type="button" onClick={async () => {
        try {
          const { apiPublic } = await import("@/lib/api-client");
          await apiPublic("POST", "/access-requests", { name, ops_id: opsId });
          setMsg("Request sent to FTE Ops and FTE MM.");
        } catch (e) {
          setMsg(friendlyError(e));
        }
      }}>Send request</button>
      {msg && <small role="status"> {msg}</small>}
    </span>
  );
}

export { Field };
