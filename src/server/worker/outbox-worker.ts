// Durable outbox worker (OPS-5, NOT-1, NOT-4). Pure orchestration over ports:
// claim due rows -> run channel handler -> complete / retry with exponential
// backoff / dead-letter. Handlers exist only for enabled+verified channels, so
// a disabled provider never burns attempts or dead-letters work.

export type Channel = "SEATALK_ALERT" | "SEATALK_APPROVAL_SYNC" | "SEATALK_APPROVAL_PROVISION" | "GOOGLE_SHEETS";

export interface OutboxRow {
  id: string;
  idempotencyKey: string;
  channel: Channel;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number; // already incremented by claim
  maxAttempts: number;
}

export interface WorkerConfig {
  baseSeconds: number;
  maxSeconds: number;
  batchSize: number;
  lockTimeoutSeconds: number;
  /** Alert when dead letters reach this count, or oldest due row is older than this many seconds. */
  deadLetterAlertThreshold: number;
  lagAlertSeconds: number;
}

/** Approved production values are an open item (10-implementation-readiness); these are sandbox defaults. */
export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  baseSeconds: 30,
  maxSeconds: 3600,
  batchSize: 20,
  lockTimeoutSeconds: 300,
  deadLetterAlertThreshold: 1,
  lagAlertSeconds: 900,
};

export interface HandlerResult {
  /** Provider acknowledged receipt (NOT-3: recorded separately from persistence/read). */
  acknowledged: boolean;
}
export type ChannelHandler = (row: OutboxRow) => Promise<HandlerResult>;

export interface OutboxStats {
  pending: number;
  processing: number;
  deadLetter: number;
  oldestDueAgeSeconds: number | null;
}

export interface OutboxPort {
  claim(channels: Channel[], limit: number, lockTimeoutSeconds: number): Promise<OutboxRow[]>;
  /**
   * Status updates are guarded by the claim: `attempts` is the claim token (each claim
   * increments it), so a slow worker whose lock was reclaimed cannot overwrite the new
   * owner's outcome. A stale update is a silent no-op.
   */
  complete(id: string, claimAttempt: number, acknowledged: boolean): Promise<void>;
  retryLater(id: string, claimAttempt: number, availableAt: Date, error: string): Promise<void>;
  deadLetter(id: string, claimAttempt: number, error: string): Promise<void>;
  stats(now: Date): Promise<OutboxStats>;
}

/** Exponential backoff: base * 2^(attempt-1), capped. attempt is 1-based. */
export function backoffSeconds(attempt: number, baseSeconds: number, maxSeconds: number): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(maxSeconds, baseSeconds * 2 ** exp);
}

/** Errors are persisted for operators: never include secrets or raw provider bodies. */
export function redactError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/(bearer|token|secret|key|authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[jwt]")
    .slice(0, 500);
}

export interface TickResult {
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
  alerts: string[];
}

export async function runWorkerOnce(opts: {
  port: OutboxPort;
  handlers: Partial<Record<Channel, ChannelHandler>>;
  now: Date;
  config?: Partial<WorkerConfig>;
  onAlert?: (message: string) => void;
}): Promise<TickResult> {
  const cfg = { ...DEFAULT_WORKER_CONFIG, ...opts.config };
  const channels = Object.keys(opts.handlers) as Channel[];
  const out: TickResult = { claimed: 0, completed: 0, retried: 0, deadLettered: 0, alerts: [] };
  const rows = channels.length ? await opts.port.claim(channels, cfg.batchSize, cfg.lockTimeoutSeconds) : [];
  out.claimed = rows.length;

  for (const row of rows) {
    const handler = opts.handlers[row.channel];
    try {
      if (!handler) throw new Error(`no handler for ${row.channel}`);
      const res = await handler(row);
      await opts.port.complete(row.id, row.attempts, res.acknowledged);
      out.completed++;
    } catch (e) {
      const error = redactError(e);
      if (row.attempts >= row.maxAttempts) {
        await opts.port.deadLetter(row.id, row.attempts, error);
        out.deadLettered++;
      } else {
        const delay = backoffSeconds(row.attempts, cfg.baseSeconds, cfg.maxSeconds);
        await opts.port.retryLater(row.id, row.attempts, new Date(opts.now.getTime() + delay * 1000), error);
        out.retried++;
      }
    }
  }

  // Recovery monitoring and operator alerts (NOT-4).
  const stats = await opts.port.stats(opts.now);
  if (stats.deadLetter >= cfg.deadLetterAlertThreshold) {
    out.alerts.push(`outbox dead-letter count ${stats.deadLetter} >= ${cfg.deadLetterAlertThreshold}`);
  }
  if (stats.oldestDueAgeSeconds !== null && stats.oldestDueAgeSeconds > cfg.lagAlertSeconds) {
    out.alerts.push(`oldest due outbox row is ${stats.oldestDueAgeSeconds}s old (> ${cfg.lagAlertSeconds}s)`);
  }
  for (const a of out.alerts) opts.onAlert?.(a);
  return out;
}
