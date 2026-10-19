// Outbox ports for the in-memory and Supabase stores.
import type { MemoryStore } from "../memory.ts";
import type { Rest } from "../supabase/rest.ts";
import type { Channel, OutboxPort, OutboxRow, OutboxStats } from "./outbox-worker.ts";

export class MemoryOutboxPort implements OutboxPort {
  private store: MemoryStore;
  private maxAttempts: number;
  constructor(store: MemoryStore, maxAttempts = 5) {
    this.store = store;
    this.maxAttempts = maxAttempts;
  }

  async claim(channels: Channel[], limit: number, lockTimeoutSeconds: number): Promise<OutboxRow[]> {
    const now = this.store.now().getTime();
    const due = this.store.outbox
      .filter(
        (o) =>
          channels.includes(o.channel) &&
          ((o.status === "PENDING" && o.availableAt <= now) ||
            (o.status === "PROCESSING" && now - o.availableAt > lockTimeoutSeconds * 1000)),
      )
      .slice(0, limit);
    return due.map((o) => {
      o.status = "PROCESSING";
      o.attempts += 1;
      o.availableAt = now; // lock time
      return {
        id: o.id, idempotencyKey: o.idempotencyKey, channel: o.channel, eventType: o.eventType,
        payload: o.payload, attempts: o.attempts, maxAttempts: this.maxAttempts,
      };
    });
  }
  private row(id: string) {
    const o = this.store.outbox.find((x) => x.id === id);
    if (!o) throw new Error("unknown outbox row");
    return o;
  }
  async complete(id: string) {
    this.row(id).status = "COMPLETED";
  }
  async retryLater(id: string, availableAt: Date, error: string) {
    const o = this.row(id);
    o.status = "PENDING";
    o.availableAt = availableAt.getTime();
    o.lastError = error;
  }
  async deadLetter(id: string, error: string) {
    const o = this.row(id);
    o.status = "DEAD_LETTER";
    o.lastError = error;
  }
  async stats(now: Date): Promise<OutboxStats> {
    const o = this.store.outbox;
    const due = o.filter((x) => x.status === "PENDING" && x.availableAt <= now.getTime());
    return {
      pending: o.filter((x) => x.status === "PENDING").length,
      processing: o.filter((x) => x.status === "PROCESSING").length,
      deadLetter: o.filter((x) => x.status === "DEAD_LETTER").length,
      oldestDueAgeSeconds: due.length ? Math.round((now.getTime() - Math.min(...due.map((x) => x.availableAt))) / 1000) : null,
    };
  }
}

export class SupabaseOutboxPort implements OutboxPort {
  private rest: Rest;
  constructor(rest: Rest) {
    this.rest = rest;
  }

  async claim(channels: Channel[], limit: number, lockTimeoutSeconds: number): Promise<OutboxRow[]> {
    const rows = (await this.rest.rpc("claim_outbox", {
      p_limit: limit,
      p_lock_timeout_seconds: lockTimeoutSeconds,
      p_channels: channels,
    })) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      idempotencyKey: String(r.idempotency_key),
      channel: r.channel as Channel,
      eventType: String(r.event_type),
      payload: (r.payload as Record<string, unknown>) ?? {},
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
    }));
  }
  async complete(id: string, acknowledged: boolean) {
    const now = new Date().toISOString();
    await this.rest.patch("workflow_outbox", `id=eq.${id}`, {
      status: "COMPLETED", completed_at: now, locked_at: null, last_error: null,
      ...(acknowledged ? { provider_ack_at: now } : {}),
    });
  }
  async retryLater(id: string, availableAt: Date, error: string) {
    await this.rest.patch("workflow_outbox", `id=eq.${id}`, {
      status: "PENDING", available_at: availableAt.toISOString(), locked_at: null, last_error: error,
    });
  }
  async deadLetter(id: string, error: string) {
    await this.rest.patch("workflow_outbox", `id=eq.${id}`, {
      status: "DEAD_LETTER", dead_lettered_at: new Date().toISOString(), locked_at: null, last_error: error,
    });
  }
  async stats(now: Date): Promise<OutboxStats> {
    const rows = await this.rest.select("workflow_outbox", "status=in.(PENDING,PROCESSING,DEAD_LETTER)&select=status,available_at&limit=5000");
    const due = rows.filter((r) => r.status === "PENDING" && Date.parse(String(r.available_at)) <= now.getTime());
    return {
      pending: rows.filter((r) => r.status === "PENDING").length,
      processing: rows.filter((r) => r.status === "PROCESSING").length,
      deadLetter: rows.filter((r) => r.status === "DEAD_LETTER").length,
      oldestDueAgeSeconds: due.length
        ? Math.round((now.getTime() - Math.min(...due.map((r) => Date.parse(String(r.available_at))))) / 1000)
        : null,
    };
  }
}
