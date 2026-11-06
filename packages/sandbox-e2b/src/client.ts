// The slice of an E2B-shape SDK the adapter uses, declared here so no vendor type reaches a public `.d.ts`.
// `e2b` and `@impello/sdk` both satisfy it (their `Sandbox` class statics plus the connected instance).

/** Connection options passed on every call. The adapter fills every field it can, so SDK env fallbacks stay unused. */
export interface E2bConnection {
  apiKey: string;
  domain?: string;
  apiUrl?: string;
  debug?: boolean;
  requestTimeoutMs?: number;
  /** Retries inside the SDK. The adapter owns the deadline, so it passes 0 (invariant 13). */
  retries?: number;
  signal?: AbortSignal;
}

export type E2bVendorState = "running" | "paused";

export interface E2bSandboxInfo {
  sandboxId: string;
  templateId?: string;
  metadata?: Record<string, string>;
  startedAt?: Date | string;
  endAt?: Date | string;
  state?: string;
}

export interface E2bPaginator {
  readonly hasNext: boolean;
  nextItems(): Promise<E2bSandboxInfo[]>;
}

export interface E2bCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface E2bCommandHandle {
  readonly pid: number;
  wait(): Promise<E2bCommandResult>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface E2bCommandOpts {
  background: true;
  cwd?: string;
  user?: string;
  envs?: Record<string, string>;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  /** 0 disables the vendor's command timeout. Always passed: the vendor default is 60 s (invariant 14). */
  timeoutMs: number;
  requestTimeoutMs?: number;
}

export interface E2bFileOpts {
  user?: string;
  requestTimeoutMs?: number;
}

/** A connected sandbox instance. */
export interface E2bSandbox {
  readonly sandboxId: string;
  readonly trafficAccessToken?: string | undefined;
  readonly commands: {
    run(cmd: string, opts: E2bCommandOpts): Promise<E2bCommandHandle>;
  };
  readonly files: {
    read(path: string, opts: E2bFileOpts & { format: "bytes" }): Promise<Uint8Array>;
    write(files: { path: string; data: string | ArrayBuffer }[], opts?: E2bFileOpts): Promise<unknown>;
  };
  getHost(port: number): string;
}

export type E2bOnTimeout = "pause" | "kill";

export interface E2bCreateOpts extends E2bConnection {
  metadata: Record<string, string>;
  timeoutMs: number;
  lifecycle: { onTimeout: E2bOnTimeout };
  allowInternetAccess?: boolean;
  network?: { allowOut?: string[]; denyOut?: string[] };
}

export interface E2bListOpts extends E2bConnection {
  query: { metadata: Record<string, string>; state: E2bVendorState[] };
  limit?: number;
}

/** The SDK's `Sandbox` class, as static methods. Optional members are probed at runtime. */
export interface E2bShapeClient {
  create(template: string, opts: E2bCreateOpts): Promise<E2bSandbox>;
  /** The only resume verb. Always given `timeoutMs`: without it the lifetime resets to 300 s. */
  connect(sandboxId: string, opts: E2bConnection & { timeoutMs: number }): Promise<E2bSandbox>;
  list(opts: E2bListOpts): E2bPaginator;
  getInfo(sandboxId: string, opts: E2bConnection): Promise<E2bSandboxInfo>;
  /** `false` on 404, so it is idempotent. */
  kill(sandboxId: string, opts: E2bConnection): Promise<boolean>;
  /** `false` when the vendor answered 409 (already paused or pausing). */
  pause(sandboxId: string, opts: E2bConnection & { keepMemory?: boolean }): Promise<boolean>;
  /** Resets the deadline to now + ms (it can shorten it). */
  setTimeout(sandboxId: string, timeoutMs: number, opts: E2bConnection): Promise<void>;
  createSnapshot?(sandboxId: string, opts: E2bConnection & { name?: string }): Promise<{ snapshotId: string }>;
}
