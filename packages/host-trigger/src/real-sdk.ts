import type { Json } from "@selfbuilding/core";
import { idempotencyKeys, runs, schedules, streams, task, tasks, wait } from "@trigger.dev/sdk";
import {
  type TriggerRunView,
  type TriggerScheduleDefinition,
  type TriggerSdk,
  type TriggerTaskDefinition,
  toPeriod,
  WAKE_STREAM_ID,
  type WaitResult,
  type Wake,
} from "./sdk.js";

// The adapter over the installed @trigger.dev/sdk (v4). The SDK's generics are wide; this file is the only place
// that touches them, and nothing from it reaches a public type.

type LooseTask = (def: Record<string, unknown>) => unknown;
type LooseTrigger = (id: string, payload: unknown, opts: Record<string, unknown>) => Promise<{ id: string }>;
type LooseWaitResult = { ok: boolean; output?: unknown; error?: unknown };

function toWaitResult<T>(result: LooseWaitResult): WaitResult<T> {
  if (result.ok) return { ok: true, output: result.output as T };
  const error = result.error instanceof Error ? result.error : new Error(String(result.error ?? "wait timed out"));
  return { ok: false, error };
}

export function realTriggerSdk(): TriggerSdk {
  const wakeStream = streams.input<Wake>({ id: WAKE_STREAM_ID });
  return {
    kind: "trigger.dev",
    task<P, O>(def: TriggerTaskDefinition<P, O>) {
      return (task as unknown as LooseTask)({
        id: def.id,
        ...(def.machine ? { machine: def.machine } : {}),
        ...(def.maxDuration ? { maxDuration: def.maxDuration } : {}),
        ...(def.retry ? { retry: def.retry } : {}),
        run: (payload: P, params: { ctx: { run: { id: string }; attempt?: { number: number } } }) =>
          def.run(payload, { ctx: params.ctx }),
        ...(def.onCancel
          ? {
              onCancel: (params: { ctx: { run: { id: string } }; payload: P }) =>
                def.onCancel?.({ ctx: params.ctx, payload: params.payload }),
            }
          : {}),
      });
    },
    scheduleTask(def: TriggerScheduleDefinition) {
      return (schedules.task as unknown as LooseTask)({
        id: def.id,
        cron: def.cron,
        ...(def.machine ? { machine: def.machine } : {}),
        ...(def.maxDuration ? { maxDuration: def.maxDuration } : {}),
        run: (payload: { timestamp: Date }, params: { ctx: { run: { id: string } } }) =>
          def.run(payload, { ctx: params.ctx }),
      });
    },
    async trigger(taskId, payload, opts) {
      const handle = await (tasks.trigger as unknown as LooseTrigger)(taskId, payload, {
        idempotencyKey: opts.idempotencyKey,
        ...(opts.tags ? { tags: opts.tags } : {}),
      });
      return { id: handle.id };
    },
    async idempotencyKey(key) {
      return String(await idempotencyKeys.create(key, { scope: "global" }));
    },
    async createToken(opts) {
      const token = await wait.createToken({
        idempotencyKey: opts.idempotencyKey,
        timeout: toPeriod(opts.timeoutMs),
        ...(opts.tags ? { tags: opts.tags } : {}),
      });
      return { id: token.id, url: token.url };
    },
    async forToken<T>(tokenId: string) {
      return toWaitResult<T>((await wait.forToken<T>(tokenId)) as LooseWaitResult);
    },
    async completeToken(tokenId, data: Json) {
      await wait.completeToken(tokenId, data);
    },
    async waitWake(opts) {
      return toWaitResult<Wake>((await wakeStream.wait({ timeout: toPeriod(opts.timeoutMs) })) as LooseWaitResult);
    },
    async sendWake(runId, wake) {
      await wakeStream.send(runId, wake);
    },
    async retrieveRun(runId): Promise<TriggerRunView> {
      const run = (await runs.retrieve(runId)) as {
        id: string;
        status: string;
        output?: unknown;
        error?: { message?: string; name?: string };
      };
      return {
        id: run.id,
        status: run.status,
        ...(run.output === undefined ? {} : { output: run.output }),
        ...(run.error ? { error: { message: run.error.message ?? "run failed", name: run.error.name } } : {}),
      };
    },
    async cancelRun(runId) {
      await runs.cancel(runId);
    },
    now: () => Date.now(),
  };
}
