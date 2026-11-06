// Acceptance 17 (release-prep §7.2 #6, #7): an agent's contract default size. An agent whose contract sets
// `defaults.size: "medium"` gets a medium box on tmpdir, a call option overrides it, and a provider that cannot give
// it refuses with SizeUnavailableError naming the fix. Calls on a shared handle count the handle's box time,
// weighted by the handle's vCPU, in `sandboxVcpuMs`.
//
// Every agent call runs the real runtime in a tmpdir box; the scripted harness prints Claude Code's native stream.
import fs from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  factory,
  fileArtifacts,
  run,
  type SelfbuildingConfig,
  SizeUnavailableError,
  sandbox,
  type Usage,
} from "@selfbuilding/core";
import { createLocalRemote, scripted, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

let dir: string;
let sized: TmpdirProvider;
let unsized: TmpdirProvider;
let repo: string;

const Ok = z.object({ ok: z.literal(true) });
type Sized = Awaited<ReturnType<typeof Agent.fromSkill<unknown, z.infer<typeof Ok>>>>;
let Medium: Sized;

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-contract-size-");
  sized = tmpdirProvider({ id: "tmpdir-sized", root: path.join(dir, "sized") });
  unsized = tmpdirProvider({ id: "tmpdir-plain", root: path.join(dir, "plain"), sizing: false });
  repo = (await createLocalRemote(path.join(dir, "remote"), { files: { "README.md": "# sizes\n" } })).url;
  const skill = path.join(dir, "skills", "measure");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: measure\ndescription: Measures the box it runs in.\n---\n\nLook around and submit ok.\n",
  );
  Medium = await Agent.fromSkill(skill, { output: Ok, workspace: { repo: "optional" }, defaults: { size: "medium" } });
});

afterAll(async () => {
  await sized?.close();
  await unsized?.close();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function runWith(name: string, body: () => Promise<unknown>, config: Partial<SelfbuildingConfig> = {}) {
  const events = recorder();
  const out = await run(
    factory({ name, input: z.object({}) }, body),
    {},
    {
      config: {
        deployment: "acceptance",
        sandbox: sized,
        harness: scriptedClaude(() => [scripted.submit({ ok: true })]),
        artifacts: fileArtifacts(path.join(dir, "artifacts")),
        ...config,
      },
      events: [events.sink],
    },
  );
  const created = events.of("sandbox.created").map((e) => e.data as { size?: string; vcpu?: number });
  return { out, events, created };
}

describe("acceptance 17: a contract's default size", () => {
  it("an agent whose contract sets defaults.size medium gets a medium box", async () => {
    let usage: Usage | undefined;
    const r = await runWith("contract-medium", async () => {
      usage = (await Medium({ task: "measure" }, { label: "plain", repo })).usage;
      return null;
    });
    expect(r.out.status).toBe("ok");
    expect(r.created.map((b) => [b.size, b.vcpu])).toEqual([["medium", 4]]);
    expect(usage?.sandboxVcpuMs).toBe((usage?.sandboxMs ?? 0) * 4);
  });

  it("a call option overrides the contract's size", async () => {
    const r = await runWith("contract-override", async () => {
      await Medium({ task: "measure" }, { label: "big", repo, size: "large" });
      await Medium({ task: "measure" }, { label: "small", repo, size: "small" });
      return null;
    });
    expect(r.out.status).toBe("ok");
    expect(r.created.map((b) => [b.size, b.vcpu])).toEqual([
      ["large", 8],
      ["small", 2],
    ]);
  });

  it("a provider that cannot give the contract's size refuses with SizeUnavailableError naming the fix", async () => {
    let settled: Awaited<ReturnType<Sized["settled"]>> | undefined;
    const r = await runWith(
      "contract-refused",
      async () => {
        settled = await Medium.settled({ task: "measure" }, { label: "refused", repo });
        return null;
      },
      { sandbox: unsized },
    );
    expect(r.out.status).toBe("ok");
    expect(settled?.ok).toBe(false);
    if (settled?.ok === false) {
      expect(settled.code).toBe("size_unavailable");
      const error = settled.error as SizeUnavailableError;
      expect(error).toBeInstanceOf(SizeUnavailableError);
      expect(error.size).toBe("medium");
      expect(error.fix.length).toBeGreaterThan(0);
      expect(error.message).toContain(error.fix);
    }
    expect(r.created).toEqual([]);
  });
});

describe("acceptance 17: shared-handle box time in sandboxVcpuMs", () => {
  it("a call on a shared handle adds its box time times the handle's vCPU", async () => {
    const usages: Usage[] = [];
    const r = await runWith("handle-vcpu", async () => {
      await using box = sandbox({ label: "work", repo, size: "large" });
      // The contract's medium is ignored on a shared handle: the handle's size (large, 8 vCPU) is what runs.
      usages.push((await Medium({ task: "measure" }, { label: "a", sandbox: box })).usage);
      usages.push((await Medium({ task: "measure" }, { label: "b", sandbox: box })).usage);
      return null;
    });
    expect(r.out.status).toBe("ok");
    expect(r.created.map((b) => b.size)).toEqual(["large"]);
    for (const u of usages) {
      expect(u.sandboxMs).toBeGreaterThan(0);
      expect(u.sandboxVcpuMs).toBe(u.sandboxMs * 8);
    }
    const total = usages.reduce((sum, u) => sum + (u.sandboxVcpuMs ?? 0), 0);
    expect(r.out.usage.sandboxVcpuMs).toBe(total);
  });
});
