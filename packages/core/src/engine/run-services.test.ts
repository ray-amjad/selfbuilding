import { describe, expect, it } from "vitest";
import { z } from "zod";
import { currentAgentContext } from "../agent/context.js";
import { memoryChannel } from "../ask/memory-channel.js";
import { NoActiveRunError } from "../errors/classes.js";
import { memoryArtifactStore } from "../host-node/stores.js";
import { memoryJournal } from "../journal/index.js";
import { factory } from "./factory.js";
import { run } from "./run.js";
import { notify, redactForRun, runArtifacts } from "./run-services.js";

describe("run services", () => {
  it("redactForRun scrubs secrets the run delivered to a box, outside any event", async () => {
    const f = factory({ name: "services-redact", input: z.unknown() }, async () => {
      currentAgentContext()?.noteSecrets?.(["declared-secret-value-1234"]);
      return redactForRun("server log: key=declared-secret-value-1234 ok");
    });
    const out = await run(f, undefined, { journal: memoryJournal() });
    expect(out.output).toBe("server log: key=[REDACTED] ok");
    expect(() => redactForRun("x")).toThrow(NoActiveRunError);
  });

  it("give factory code the run's artifact store and post one note to the run thread", async () => {
    const artifacts = memoryArtifactStore();
    const ch = memoryChannel({ id: "slack" });
    const f = factory({ name: "services", input: z.unknown() }, async () => {
      const r = runArtifacts();
      const ref = await r.artifacts.put(`runs/${r.runId}/page.html`, "<p>hi</p>");
      const posted = await notify("Summary: all verified.");
      return { runId: r.runId, uri: ref.uri, posted };
    });
    const out = await run(f, undefined, {
      runId: "ns_services",
      config: { artifacts, hitl: { channels: [ch], approvers: [{ slack: "U1" }] } },
      journal: memoryJournal(),
    });
    expect(out.status).toBe("ok");
    const o = out.output as { runId: string; uri: string; posted: { delivered: boolean } };
    expect(o.runId).toBe("ns_services");
    expect(new TextDecoder().decode(await artifacts.read(o.uri))).toBe("<p>hi</p>");
    expect(o.posted.delivered).toBe(true);
    // The note first, then the run's own end summary in the same thread.
    expect(ch.notifications.map((n) => n.notification.kind)).toEqual(["fyi", "run.end"]);
    expect(ch.notifications[0]?.notification.text).toBe("Summary: all verified.");
  });

  it("report an undelivered note in AFK mode, and throw outside a run", async () => {
    const f = factory({ name: "services-afk", input: z.unknown() }, async () => notify("nobody reads this"));
    const out = await run(f, undefined, { config: { hitl: { mode: "afk" } }, journal: memoryJournal() });
    expect(out.output).toMatchObject({ delivered: false });
    expect(() => runArtifacts()).toThrow(NoActiveRunError);
    await expect(notify("x")).rejects.toThrow(NoActiveRunError);
  });
});
