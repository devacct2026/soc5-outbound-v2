"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { setToken } from "@/lib/api-client";
import { parseAuthCallback, type CallbackResult } from "@/lib/auth-callback";

export function AuthCallback() {
  const [result, setResult] = useState<CallbackResult | null>(null);
  const parsed = useRef<CallbackResult | null>(null);
  useEffect(() => {
    // Parsed exactly once: the URL is scrubbed below, so a second effect run (React strict mode) must reuse this result.
    const r = (parsed.current ??= parseAuthCallback(window.location.hash, window.location.search));
    window.history.replaceState(null, "", window.location.pathname); // never leave tokens in the address bar
    if (r.kind === "token") {
      setToken(r.token, r.expiresIn);
      window.location.replace("/");
      return;
    }
    const t = setTimeout(() => setResult(r), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <main className="module-page">
      <section className="panel module-content" aria-live="polite">
        <h1>Signing you in…</h1>
        {result?.kind === "pending" && <p role="status">Your account has been registered and is awaiting administrator approval. You will have access once an administrator approves it and assigns your role.</p>}
        {result?.kind === "error" && <p role="alert">{result.message}</p>}
        {result?.kind === "none" && <p className="module-note">Nothing to complete here.</p>}
        {result && <p><Link href="/">Back to the dashboard</Link></p>}
      </section>
    </main>
  );
}
