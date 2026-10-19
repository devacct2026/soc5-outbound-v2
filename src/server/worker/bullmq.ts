// BullMQ scheduling for the outbox worker. Redis is only the scheduler/lock layer:
// the transactional outbox in PostgreSQL stays the source of truth (retries,
// backoff, dead-letter, audit), so losing Redis never loses or duplicates work.
// Not exercised against a live Redis in this repository (none available here).
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { runWorkerOnce, type ChannelHandler, type Channel, type OutboxPort, type TickResult, type WorkerConfig } from "./outbox-worker.ts";

export const TICK_QUEUE = "soc5-outbox";

export interface TickDeps {
  port: OutboxPort;
  handlers: Partial<Record<Channel, ChannelHandler>>;
  config?: Partial<WorkerConfig>;
  onAlert?: (m: string) => void;
  housekeeping?: () => Promise<unknown>;
  now?: () => Date;
}

/** The job processor: one outbox tick. Throwing marks the BullMQ job failed (visible in monitoring). */
export function makeTickProcessor(deps: TickDeps) {
  return async function processTick(): Promise<TickResult> {
    const result = await runWorkerOnce({
      port: deps.port,
      handlers: deps.handlers,
      now: (deps.now ?? (() => new Date()))(),
      config: deps.config,
      onAlert: deps.onAlert,
    });
    await deps.housekeeping?.();
    return result;
  };
}

export interface BullHandle {
  close(): Promise<void>;
}

/**
 * Registers one repeatable "tick" (at most one scheduler regardless of how many
 * processes start) and a concurrency-1 worker. Multiple worker processes are
 * safe: BullMQ hands each tick to one of them, and the DB claim uses SKIP LOCKED.
 */
export async function startBullWorker(opts: {
  connection: ConnectionOptions;
  intervalMs: number;
  deps: TickDeps;
  prefix?: string;
}): Promise<BullHandle> {
  const prefix = opts.prefix ?? "soc5";
  const queue = new Queue(TICK_QUEUE, { connection: opts.connection, prefix });
  await queue.upsertJobScheduler("outbox-tick", { every: opts.intervalMs }, { name: "tick", opts: { removeOnComplete: 100, removeOnFail: 500, attempts: 1 } });
  const process = makeTickProcessor(opts.deps);
  const worker = new Worker(TICK_QUEUE, async () => process(), { connection: opts.connection, prefix, concurrency: 1 });
  worker.on("failed", (_job, err) => opts.deps.onAlert?.(`outbox tick failed: ${err.message.slice(0, 200)}`));
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
