import { describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryChannel } from "../ask/memory-channel.js";
import { memoryJournal } from "../journal/index.js";
import { factory } from "./factory.js";
import { run } from "./run.js";
import { notify } from "./run-services.js";

// release-prep §7.2 #2: AFK means nobody answers asks, not silence. Factory code's notify() still posts its FYI.

describe("notify() in AFK mode", () => {
  it("posts the note to the run's channels", async () => {
    const ch = memoryChannel({ id: "slack" });
    const f = factory({ name: "services-afk-post", input: z.unknown() }, async () => notify("Summary: all verified."));
    const out = await run(f, undefined, {
      config: { hitl: { channels: [ch], mode: "afk" } },
      journal: memoryJournal(),
    });
    expect(out.status).toBe("ok");
    expect(out.output).toMatchObject({ delivered: true });
    const fyis = ch.notifications.filter((n) => n.notification.kind === "fyi");
    expect(fyis.map((n) => n.notification.text)).toEqual(["Summary: all verified."]);
  });
});
