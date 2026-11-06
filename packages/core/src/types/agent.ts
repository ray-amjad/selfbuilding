import type { SkillDef } from "@selfbuilding/skills";
import type { z } from "zod";
import type { SelfbuildingError } from "../errors/base.js";
import type { ErrorCode } from "../errors/codes.js";
import type { AgentResult, Artifacts } from "./artifacts.js";
import type { Duration, Effort, JSONSchema7 } from "./common.js";
import type { SelfbuildingConfig } from "./config.js";
import type { Harness, McpServerSpec } from "./harness.js";
import type { SandboxHandle, SandboxProvider } from "./sandbox.js";
import type { SizeName } from "./sizes.js";

// Agents, contracts and the one per-call options type (spec §2.4, §2.5, §2.7, §2.10.4).

/** The value form of an agent call (spec §1.9). `error` is `signal.reason` when aborted. */
export type Settled<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; error: SelfbuildingError | unknown };

export interface PrOptions {
  /** Default true. */
  draft?: boolean;
  /** Default: the call's base branch. */
  base?: string;
  title?: string | ((r: unknown) => string);
  body?: string | ((r: unknown, a: Artifacts) => string);
  labels?: string[];
}

export interface GitCallOptions {
  /** Working branch; default branchName(runId, callPath). */
  branch?: string;
  /** Default: the repo's default branch. */
  baseBranch?: string;
  /** Default true. */
  commitLeftovers?: boolean;
  identity?: "agent" | { mode: "attributed"; name: string; email: string };
  /** Refs outside refs/heads/selfbuilding/** and refs/selfbuilding/**. */
  allowPushTo?: string[];
}

export interface CallTimeouts {
  idle?: Duration;
  boot?: Duration;
  setup?: Duration;
  start?: Duration;
  postSubmitGrace?: Duration;
  cancelGrace?: Duration;
}

/** The one per-call options type. Every key is optional; factory defaults and config apply (spec §1.11). */
export interface AgentCallOptions {
  /** Explicit config for standalone calls. */
  config?: SelfbuildingConfig;

  // Where the work happens. Never skill input.
  /** "github.com/acme/api"; default: review target, factory defaults, config. */
  repo?: string;
  /** "fresh" (default), a provider for a fresh box elsewhere, or a shared handle (which supplies repo and branch). */
  sandbox?: "fresh" | SandboxProvider | SandboxHandle;
  git?: GitCallOptions;
  /** Open or update a PR for the working branch; default false. */
  pr?: boolean | PrOptions;

  // How it runs
  /** The model lives on the harness value. */
  harness?: Harness;
  /**
   * Machine size for a fresh box (demo-path §1). Ignored with a shared handle (the handle's size wins); a fork's
   * size is set on `fork()`. Default: contract default, then the factory's `defaults.size`, then the provider's.
   */
  size?: SizeName;
  /** Extra MCP servers for the harness, after the `selfbuilding` server (which cannot be shadowed). */
  mcpServers?: McpServerSpec[];
  /** Hand this call a start grant so its agent can call start_workflow (demo-path §9). Default false. */
  startWorkflow?: boolean;
  effort?: Effort;
  /** Replaces `Name#n` in the callPath. */
  label?: string;
  /** Overrides the scope's current phase for this call. */
  phase?: string;
  /** Per call; defaults to budget.perAgent. */
  budget?: { usd?: number; wallClock?: Duration };
  /** Active-time limit for the whole call; default "2h". */
  timeout?: Duration;
  /** Advanced (spec §6.11). */
  timeouts?: CallTimeouts;
  /** Live re-runs after a turn that did work; default 0. */
  retries?: number;
  /** Shared handles only; default "git". */
  checkpoint?: "git" | "snapshot" | "none";
  /** Declared secret names. */
  secrets?: string[];
  /** May only tighten. */
  hitl?: { risk?: "high"; timeout?: Duration; maxAsks?: number };
  /** Default "throw". */
  onDoneFailure?: "throw" | "return";
  /** Default "fail". */
  onInterrupted?: "fail" | "resume-session";
  maxSubmitAttempts?: number;
  maxResumes?: number;
  maxDoneRetries?: number;
  /** Refuse "same-user" sandboxes; default false. */
  requireIsolation?: boolean;
  lifecycle?: { preserveOnCancel?: boolean; keepOnFailure?: false | `${number}${"m" | "h"}` };
  signal?: AbortSignal;
}

export interface DoneContext {
  /** exec/readFile only. */
  sandbox: SandboxHandle;
  git: {
    base: string;
    head: string;
    commitsAhead: number;
    dirty: boolean;
    changedPaths: string[];
    remoteHasBranch(): Promise<boolean>;
  };
  artifacts: Partial<Artifacts>;
}

export type DoneCheck<I, O> =
  | {
      id: string;
      /** Runs in the sandbox; a function is resolved on the host from the caller's input. */
      cmd: string | ((input: I) => string | undefined);
      cwd?: string;
      timeout?: Duration;
      expectExit?: number;
    }
  | { id: string; assert: (r: O, ctx: DoneContext) => true | string | Promise<true | string> }
  | { id: string; judge: { rubric: string; harness?: Harness } };

export type BranchRequirement = "required" | "optional" | "forbidden";

export interface ContractDefaults {
  harness?: Harness;
  size?: SizeName;
  mcpServers?: McpServerSpec[];
  effort?: Effort;
  maxSubmitAttempts?: number;
  maxResumes?: number;
  maxDoneRetries?: number;
  timeout?: Duration;
}

/** What `defineContract` takes (spec §2.4). */
export interface ContractDefinition<I extends z.ZodType, O extends z.ZodType> {
  /** Default: DefaultInput. */
  input?: I;
  /** Default: DefaultResult. */
  output?: O;
  workspace?: {
    /** Default "required". */
    repo?: "required" | "optional";
    /** Default "none". */
    target?: "none" | "review";
  };
  /** The only test command checks will run. */
  testCommand?: string | ((input: z.input<I>) => string | undefined);
  done?: DoneCheck<z.input<I>, z.infer<O>>[];
  protect?: { extra?: string[]; allow?: string[] };
  artifacts?: {
    /** Default "optional". */
    branch?: BranchRequirement | ((input: z.input<I>) => BranchRequirement);
    /** Default "optional". */
    pr?: BranchRequirement;
  };
  defaults?: ContractDefaults;
}

/** A compiled contract. `I` is the call-site input type, `O` the parsed result type. */
export interface Contract<I, O> {
  readonly input: z.ZodType<unknown, I>;
  readonly output: z.ZodType<O>;
  readonly workspace: { repo: "required" | "optional"; target: "none" | "review" };
  readonly testCommand?: string | ((input: I) => string | undefined);
  readonly done: DoneCheck<I, O>[];
  readonly protect: { extra: string[]; allow: string[] };
  readonly artifacts: { branch: BranchRequirement | ((input: I) => BranchRequirement); pr: BranchRequirement };
  readonly defaults: ContractDefaults;
}

/** The second argument of `Agent.fromSkill` (spec §1.8): `{ input?, output?, done?, artifacts?, defaults? }` and the rest of a contract. */
export type ContractSpec<I, O> = {
  input?: z.ZodType<unknown, I>;
  output?: z.ZodType<O>;
  workspace?: { repo?: "required" | "optional"; target?: "none" | "review" };
  testCommand?: string | ((input: I) => string | undefined);
  done?: DoneCheck<I, O>[];
  protect?: { extra?: string[]; allow?: string[] };
  artifacts?: { branch?: BranchRequirement | ((input: I) => BranchRequirement); pr?: BranchRequirement };
  defaults?: ContractDefaults;
};

/** A patch for `X.with()` (spec §2.10.4). `output` must extend the base schema. */
export interface AgentPatch<I, O> {
  appendBody?: string;
  output?: (base: z.ZodType<O>) => z.ZodType<O>;
  done?: (base: DoneCheck<I, O>[]) => DoneCheck<I, O>[];
  protect?: { extra?: string[]; allow?: string[] };
  defaults?: ContractDefaults;
  /** Declared secret names (spec §9.2). */
  secrets?: string[];
}

/** A compiled agent: a typed async function (spec §2.5.1). Throws SelfbuildingError on failure. */
export type Agent<I, O> = {
  (input: I, opts?: AgentCallOptions): Promise<AgentResult<O>>;
  settled(input: I, opts?: AgentCallOptions): Promise<Settled<AgentResult<O>>>;
  readonly skill: SkillDef;
  readonly contract: Contract<I, O>;
  readonly inputJsonSchema: JSONSchema7;
  readonly outputJsonSchema: JSONSchema7;
  with(patch: AgentPatch<I, O>): Agent<I, O>;
};

/** `agent({ name, prompt, input?, output, ...opts })`: inline prompts only (spec §3.4). */
export type InlineAgentSpec<O> = {
  name: string;
  /** A literal string; no template expansion. */
  prompt: string;
  input?: unknown;
  output: z.ZodType<O>;
} & AgentCallOptions;

export interface InlineAgentFn {
  <O>(spec: InlineAgentSpec<O>): Promise<AgentResult<O>>;
  settled<O>(spec: InlineAgentSpec<O>): Promise<Settled<AgentResult<O>>>;
}
