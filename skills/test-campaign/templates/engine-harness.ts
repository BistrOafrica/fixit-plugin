/**
 * Drive an async job-based engine in-process and deterministically.
 *
 * Production enqueues jobs (BullMQ, Sidekiq, SQS…) that a worker runs later.
 * Here the dispatcher is swapped for an in-memory queue with a virtual clock:
 * `drain()` runs everything due, `advanceTime(ms)` moves the clock. Timers run
 * through the REAL worker handler. Every advance is traced.
 *
 * ADAPT: setDispatcher / advance / handleTimer imports and the job payload.
 */
import { after } from "node:test";
import { setEngineDispatcher, handleTimer, type TimerPayload } from "../src/engine/queues"; // ADAPT
import { advance, readInstance } from "../src/engine/runner";                              // ADAPT

interface Job { kind: "advance" | "timer"; dueAt: number; seq: number; instanceId?: string; payload?: TimerPayload }
export interface Trace { instanceId: string; fromNode: string | null; toNode: string | null; fromStatus: string | null; toStatus: string | null }

export class InlineEngine {
  private queue: Job[] = [];
  private seq = 0;
  private clock = 0;
  readonly trace: Trace[] = [];

  constructor() {
    setEngineDispatcher({
      advance: async (instanceId: string, o?: { delayMs?: number }) => this.push({ kind: "advance", instanceId, dueAt: this.clock + (o?.delayMs ?? 0) }),
      timer: async (payload: TimerPayload, delayMs: number) => this.push({ kind: "timer", payload, dueAt: this.clock + delayMs }),
    });
  }
  private push(j: Omit<Job, "seq">) { this.queue.push({ ...j, seq: this.seq++ }); }
  private nextDue(): Job | undefined {
    let best = -1;
    this.queue.forEach((j, i) => {
      if (j.dueAt > this.clock) return;
      const b = this.queue[best];
      if (!b || j.dueAt < b.dueAt || (j.dueAt === b.dueAt && j.seq < b.seq)) best = i;
    });
    return best >= 0 ? this.queue.splice(best, 1)[0] : undefined;
  }
  async drain(maxJobs = 500): Promise<number> {
    let ran = 0;
    for (let job = this.nextDue(); job; job = this.nextDue()) {
      if (++ran > maxJobs) throw new Error(`engine did not settle within ${maxJobs} jobs — a workflow is looping`);
      if (job.kind === "timer") await handleTimer(job.payload!);
      else {
        const before = await readInstance(job.instanceId!);
        await advance(job.instanceId!);
        const after_ = await readInstance(job.instanceId!);
        this.trace.push({ instanceId: job.instanceId!, fromNode: before?.node ?? null, toNode: after_?.node ?? null, fromStatus: before?.status ?? null, toStatus: after_?.status ?? null });
      }
    }
    return ran;
  }
  async advanceTime(ms: number) { this.clock += ms; return this.drain(); }
  pending() { return [...this.queue]; }
  uninstall() { setEngineDispatcher(null); }
}

/** Install for the current test file; uninstalls when the file finishes. */
export function useInlineEngine(): InlineEngine {
  const e = new InlineEngine();
  after(() => e.uninstall());
  return e;
}
