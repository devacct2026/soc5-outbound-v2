// Minimal PostgREST/Supabase client over fetch (no extra dependencies).
// Uses the SERVICE ROLE key: server-only, never imported from client code and
// never logged. Authorization is enforced by the services before any call.
export class RestError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface RestConfig {
  url: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class Rest {
  private cfg: RestConfig;
  constructor(cfg: RestConfig) {
    this.cfg = cfg;
  }

  private async call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(`${this.cfg.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.cfg.serviceKey,
        authorization: `Bearer ${this.cfg.serviceKey}`,
        "content-type": "application/json",
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      cache: "no-store",
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = (parsed ?? {}) as { code?: string; message?: string };
      throw new RestError(res.status, e.code ?? null, e.message ?? `HTTP ${res.status}`);
    }
    return parsed;
  }

  select<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
    return this.call("GET", `${table}?${query}`) as Promise<T[]>;
  }
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    return this.call("POST", `rpc/${fn}`, { body: args }) as Promise<T>;
  }
  insert(table: string, rows: unknown, prefer = "return=minimal"): Promise<unknown> {
    return this.call("POST", table, { body: rows, headers: { prefer } });
  }
  patch(table: string, query: string, values: unknown): Promise<unknown> {
    return this.call("PATCH", `${table}?${query}`, { body: values, headers: { prefer: "return=minimal" } });
  }
}

/** PostgREST filter value quoting for uuid/text equality (rejects injection characters). */
export function q(v: string): string {
  // "/" is legitimate (request paths); ",", "(", ")" and operators are not. The value is also URL-encoded.
  if (!/^[A-Za-z0-9_.:@+/\- ]*$/.test(v)) throw new Error("unsafe filter value");
  return encodeURIComponent(v);
}
