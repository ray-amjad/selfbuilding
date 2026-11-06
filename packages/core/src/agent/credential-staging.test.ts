import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  scriptedHarness,
  type TmpdirProvider,
  tempDir,
  testContext,
  tmpdirProvider,
  useFakeRuntime,
} from "../../test/agent-kit/kit.js";
import type { AuthPlan, Harness, HarnessCredential } from "../types/harness.js";
import type { SandboxProvider, WriteFileEntry } from "../types/sandbox.js";
import { setAgentContextResolver } from "./context.js";
import { leasedContent } from "./credentials.js";

vi.mock("@selfbuilding/skills", () => ({ loadSkill: vi.fn() }));
const { agent } = await import("./index.js");

// Regression for the Codex 401: the lifecycle staged every auth file root-owned, so a harness that reads its own
// login file as the agent user could not see it. An auth file now lands with the owner its plan names.

let provider: TmpdirProvider;
let workDir: string;
const writes: WriteFileEntry[] = [];

/** Records every writeFiles on every box the provider hands out. Methods stay bound to the real objects. */
function recording(inner: SandboxProvider): SandboxProvider {
  const wrapBox = (box: unknown): unknown => {
    if (!box || typeof box !== "object") return box;
    // openOrCreate answers { handle, created }.
    const inner = (box as { handle?: unknown }).handle;
    if (inner && typeof inner === "object") return { ...box, handle: wrapBox(inner) };
    if (typeof (box as { writeFiles?: unknown }).writeFiles !== "function") return box;
    return new Proxy(box as object, {
      get(target, key) {
        if (key === "writeFiles") {
          return async (files: WriteFileEntry[]) => {
            writes.push(...files);
            return (target as { writeFiles: (f: WriteFileEntry[]) => Promise<void> }).writeFiles(files);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(inner, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = value.apply(target, args);
        return out instanceof Promise ? out.then(wrapBox) : wrapBox(out);
      };
    },
  });
}

function harnessWith(owner: "agent" | undefined): Harness {
  const base = scriptedHarness([]);
  const credential: HarnessCredential = { kind: "auth-file", value: '{"tokens":{"refresh_token":"x"}}', leased: true };
  return {
    ...base,
    options: { ...base.options, credentials: credential },
    auth(_cred, ctx): AuthPlan {
      const path = `${ctx.paths.home}/.tool/auth.json`;
      return {
        env: {},
        files: [{ path, content: "{}", mode: 0o600, secret: true, ...(owner ? { owner } : {}) }],
        stripEnv: [],
        leasedFile: { path },
      };
    },
  };
}

beforeAll(async () => {
  workDir = await tempDir();
  provider = tmpdirProvider({});
});

afterAll(async () => {
  await provider.close();
  await fs.rm(workDir, { recursive: true, force: true });
});

afterEach(() => {
  setAgentContextResolver(undefined);
  writes.length = 0;
});

describe("auth file staging", () => {
  it.each([
    ["agent", "agent"],
    [undefined, "root"],
  ] as const)("an auth file planned with owner %s is written owned by %s, mode 0600", async (owner, expected) => {
    const { ctx } = await testContext({
      sandbox: recording(provider),
      harness: harnessWith(owner),
      deployment: "test",
    });
    setAgentContextResolver(() => ctx);
    useFakeRuntime({ "Stage#0": [{ result: { status: "done", summary: "staged" } }] });
    await agent({ name: "Stage", prompt: "Do it.", output: z.object({ status: z.string(), summary: z.string() }) });
    const file = writes.find((w) => w.path.endsWith("/.tool/auth.json"));
    expect(file).toMatchObject({ mode: 0o600, owner: expected });
  });
});

describe("leased file return", () => {
  it.each([
    [true, '{"login":"refreshed"}'],
    [false, undefined],
  ] as const)("a returned copy the harness accepts=%s is kept in the pool: %s", async (accepted, expected) => {
    const base = scriptedHarness([]);
    const credential: HarnessCredential = { kind: "auth-file", value: '{"login":"a"}', leased: true };
    const harness: Harness = {
      ...base,
      options: { ...base.options, credentials: credential },
      auth(_cred, c): AuthPlan {
        const path = `${c.paths.home}/.tool/auth.json`;
        return {
          env: {},
          files: [{ path, content: '{"login":"refreshed"}', mode: 0o600, secret: true, owner: "agent" }],
          stripEnv: [],
          leasedFile: { path, accepts: () => accepted },
        };
      },
    };
    const { ctx } = await testContext({ sandbox: provider, harness, deployment: "test" });
    setAgentContextResolver(() => ctx);
    useFakeRuntime({ "Lease#0": [{ result: { status: "done", summary: "ok" } }] });
    await agent({ name: "Lease", prompt: "Do it.", output: z.object({ status: z.string(), summary: z.string() }) });
    expect(leasedContent(credential)).toBe(expected);
  });
});
