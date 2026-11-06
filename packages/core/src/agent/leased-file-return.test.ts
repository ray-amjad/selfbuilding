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
import type { ExecOpts, SandboxProvider } from "../types/sandbox.js";
import { setAgentContextResolver } from "./context.js";
import { leasedContent } from "./credentials.js";
import { LEASED_FILE_MAX_BYTES } from "./lifecycle.js";

vi.mock("@selfbuilding/skills", () => ({ loadSkill: vi.fn() }));
const { agent } = await import("./index.js");

// release-prep §7.2 #5: the leased login file is read back as the agent user, and a symlink, a non-regular file
// or an oversized file is dropped with a warning; the pool keeps its original.

let provider: TmpdirProvider;
let workDir: string;
const reads: { cmd: string; user?: string }[] = [];

/** Before the lifecycle reads the leased file back, `tamper` runs in the box (as root), standing in for the agent. */
function tampering(inner: SandboxProvider, tamper: (path: string) => string): SandboxProvider {
  const wrapBox = (box: unknown): unknown => {
    if (!box || typeof box !== "object") return box;
    const handle = (box as { handle?: unknown }).handle;
    if (handle && typeof handle === "object") return { ...box, handle: wrapBox(handle) };
    if (typeof (box as { exec?: unknown }).exec !== "function") return box;
    return new Proxy(box as object, {
      get(target, key) {
        if (key === "exec") {
          const exec = (target as { exec: (c: string, o?: ExecOpts) => Promise<unknown> }).exec.bind(target);
          return async (cmd: string, opts?: ExecOpts) => {
            const m = /test -f '([^']+)'/.exec(cmd);
            if (m?.[1]) {
              reads.push({ cmd, ...(opts?.user ? { user: opts.user } : {}) });
              await exec(tamper(m[1]), { user: "root" });
            }
            return exec(cmd, opts);
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

function leasing(credential: HarnessCredential): Harness {
  const base = scriptedHarness([]);
  return {
    ...base,
    options: { ...base.options, credentials: credential },
    auth(_cred, c): AuthPlan {
      const path = `${c.paths.home}/.tool/auth.json`;
      return {
        env: {},
        files: [{ path, content: '{"login":"refreshed"}', mode: 0o600, secret: true, owner: "agent" }],
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
  reads.length = 0;
});

const q = (p: string) => `'${p}'`;

describe("leased file return", () => {
  it.each([
    [
      "a symlink to another login",
      (p: string) =>
        `printf '{"login":"stolen"}' > ${q(`${p}.other`)} && rm -f ${q(p)} && ln -s ${q(`${p}.other`)} ${q(p)}`,
      "not a regular file",
    ],
    ["a directory", (p: string) => `rm -f ${q(p)} && mkdir ${q(p)}`, "not a regular file"],
    [
      "a file over the cap",
      (p: string) => `head -c ${LEASED_FILE_MAX_BYTES + 1} /dev/zero | tr '\\0' 'x' > ${q(p)}`,
      `over ${LEASED_FILE_MAX_BYTES} bytes`,
    ],
  ])("%s is dropped with a warning; the pool keeps its original", async (_name, tamper, why) => {
    const credential: HarnessCredential = { kind: "auth-file", value: '{"login":"a"}', leased: true };
    const { ctx, events } = await testContext({
      sandbox: tampering(provider, tamper),
      harness: leasing(credential),
      deployment: "test",
    });
    setAgentContextResolver(() => ctx);
    useFakeRuntime({ "Lease#0": [{ result: { status: "done", summary: "ok" } }] });
    await agent({ name: "Lease", prompt: "Do it.", output: z.object({ status: z.string(), summary: z.string() }) });
    expect(reads).toHaveLength(1);
    expect(reads[0]?.user).toBe("agent");
    expect(leasedContent(credential)).toBeUndefined();
    const warned = events.filter((e) => e.type === "warning" && (e.data as { scope?: string }).scope === "credentials");
    expect(warned).toHaveLength(1);
    expect(String((warned[0]?.data as { message?: string } | undefined)?.message)).toContain(why);
  });

  it("a regular file within the cap is read as the agent user and kept", async () => {
    const credential: HarnessCredential = { kind: "auth-file", value: '{"login":"a"}', leased: true };
    const { ctx, events } = await testContext({
      sandbox: tampering(provider, () => "true"),
      harness: leasing(credential),
      deployment: "test",
    });
    setAgentContextResolver(() => ctx);
    useFakeRuntime({ "Lease#0": [{ result: { status: "done", summary: "ok" } }] });
    await agent({ name: "Lease", prompt: "Do it.", output: z.object({ status: z.string(), summary: z.string() }) });
    expect(reads[0]?.user).toBe("agent");
    expect(leasedContent(credential)).toBe('{"login":"refreshed"}');
    expect(events.some((e) => e.type === "warning" && (e.data as { scope?: string }).scope === "credentials")).toBe(
      false,
    );
  });
});
