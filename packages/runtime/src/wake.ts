import { createHmac } from "node:crypto";
import fs from "node:fs";
import type { AgentCallback, WakeFile } from "@selfbuilding/core";
import { exists, readJson, sleep, writeAtomic, writeJsonAtomic } from "./fsutil.js";
import type { RuntimeLog } from "./log.js";
import type { AttemptLayout } from "./paths.js";

// Wake callbacks (spec §6.6): only critical events wake the host, at most one successful send per armed wait
// `(launchId, rearm)`, and a wake with no usable target waits as `wake.pending` for the next wake.json.

export type WakeStatus = AgentCallback["status"];

/** The domain separator signed together with the body. */
export const CALLBACK_KIND = "agent.callback";
export const SIGNATURE_HEADER = "x-selfbuilding-signature";
export const KIND_HEADER = "x-selfbuilding-kind";

/** HMAC-SHA256 over `kind + body` (spec §6.6), hex, prefixed "v1=": what `createCallbackHandler` verifies. */
export function signCallback(token: string, kind: string, body: string): string {
  return `v1=${createHmac("sha256", token).update(`${kind}${body}`).digest("hex")}`;
}

export interface WakeContext {
  runId: string;
  stepKey: string;
  launchId: string;
  callbackToken?: string;
}

interface PendingWake {
  status: WakeStatus;
  at: string;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export class WakeSender {
  #busy: Promise<boolean> | undefined;

  constructor(
    private readonly attempt: AttemptLayout,
    private readonly ctx: WakeContext,
    private readonly log: RuntimeLog,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
    /** Overall retry deadline for one wake (spec §6.6: 10 min). */
    private readonly deadlineMs = 10 * 60_000,
  ) {}

  /** Records a critical event and tries to deliver it. Resolves true once a wake was delivered. */
  notify(status: WakeStatus): Promise<boolean> {
    writeJsonAtomic(this.attempt.wakePending, { status, at: new Date().toISOString() } satisfies PendingWake);
    return this.flush();
  }

  hasPending(): boolean {
    return exists(this.attempt.wakePending);
  }

  /** Sends the pending wake if there is a target that has not been spent yet. Never throws. */
  flush(): Promise<boolean> {
    if (this.#busy) return this.#busy.then(() => this.flush());
    this.#busy = this.#send().finally(() => {
      this.#busy = undefined;
    });
    return this.#busy;
  }

  async #send(): Promise<boolean> {
    try {
      const pending = readJson<PendingWake>(this.attempt.wakePending);
      if (!pending) return false;
      const wake = readJson<WakeFile>(this.attempt.wake);
      if (!wake || typeof wake.rearm !== "number" || !wake.target) return false;
      const sentMarker = this.attempt.wakeSent(wake.launchId, wake.rearm);
      if (exists(sentMarker)) return false;
      const callback: AgentCallback = {
        v: 1,
        runId: this.ctx.runId,
        stepKey: this.ctx.stepKey,
        launchId: this.ctx.launchId as AgentCallback["launchId"],
        status: pending.status,
        rearm: wake.rearm,
        source: "runtime",
        at: pending.at,
      };
      const delivered = await this.#post(wake, callback);
      if (!delivered) return false;
      writeAtomic(sentMarker, new Date().toISOString());
      // Only clear the pending wake if nothing newer replaced it meanwhile.
      const current = readJson<PendingWake>(this.attempt.wakePending);
      if (current && current.at === pending.at && current.status === pending.status) {
        fs.rmSync(this.attempt.wakePending, { force: true });
      }
      return true;
    } catch (error) {
      this.log.warn(`wake failed: ${String(error)}`);
      return false;
    }
  }

  async #post(wake: WakeFile, callback: AgentCallback): Promise<boolean> {
    const target = wake.target;
    const body =
      target.kind === "url" ? JSON.stringify(callback) : JSON.stringify({ eventKey: target.eventKey, callback });
    const url = target.kind === "url" ? target.url : target.endpoint;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [KIND_HEADER]: CALLBACK_KIND,
      ...(target.kind === "url" ? (target.headers ?? {}) : { authorization: `Bearer ${target.token}` }),
    };
    if (this.ctx.callbackToken) headers[SIGNATURE_HEADER] = signCallback(this.ctx.callbackToken, CALLBACK_KIND, body);
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < this.deadlineMs) {
      try {
        const response = await this.fetchImpl(url, { method: "POST", headers, body });
        if (response.ok) {
          this.log.info(`wake ${callback.status} delivered (rearm ${wake.rearm})`);
          return true;
        }
        this.log.warn(`wake ${callback.status} answered ${response.status}`);
        // A 4xx other than 408/429 will not change on retry.
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)
          return false;
      } catch (error) {
        this.log.warn(`wake ${callback.status} failed: ${String(error)}`);
      }
      attempt++;
      // Full jitter backoff.
      const cap = Math.min(60_000, 500 * 2 ** attempt);
      await sleep(Math.min(Math.random() * cap, Math.max(0, this.deadlineMs - (Date.now() - started))));
    }
    return false;
  }
}
