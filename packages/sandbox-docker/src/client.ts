import type { Duplex } from "node:stream";
import Docker from "dockerode";

// The slice of the Docker Engine API the provider uses, typed structurally so no third-party type reaches a public
// declaration and tests can pass an in-memory client.

export interface DockerExecInspect {
  Running: boolean;
  ExitCode: number | null;
}

export interface DockerExec {
  /** With `hijack` and `stdin`, resolves to a duplex: writes go to the process's stdin, reads are multiplexed frames. */
  start(o: { hijack: true; stdin: true; Detach: false; Tty: false }): Promise<Duplex>;
  inspect(): Promise<DockerExecInspect>;
}

export interface DockerExecCreate {
  Cmd: string[];
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  Tty: false;
  User: string;
  Env: string[];
  WorkingDir: string;
}

export interface DockerPortBinding {
  HostIp: string;
  HostPort: string;
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  State: { Status: string; Running: boolean; Paused: boolean; Restarting?: boolean; Dead?: boolean };
  Config: { Labels?: Record<string, string> | null; Env?: string[] | null; Image: string };
  HostConfig?: { NetworkMode?: string; NanoCpus?: number; Memory?: number; PortBindings?: unknown };
  NetworkSettings?: { Ports?: Record<string, DockerPortBinding[] | null> | null };
}

export interface DockerContainer {
  readonly id: string;
  inspect(): Promise<DockerContainerInspect>;
  start(): Promise<unknown>;
  pause(): Promise<unknown>;
  unpause(): Promise<unknown>;
  remove(o: { force: boolean; v: boolean }): Promise<unknown>;
  rename(o: { name: string }): Promise<unknown>;
  exec(o: DockerExecCreate): Promise<DockerExec>;
  putArchive(data: Buffer, o: { path: string }): Promise<unknown>;
  getArchive(o: { path: string }): Promise<NodeJS.ReadableStream>;
  commit(o: { repo: string; tag: string; pause: boolean; comment?: string }): Promise<{ Id?: string }>;
}

export interface DockerContainerSummary {
  Id: string;
  Names: string[];
  State: string;
  /** Unix seconds. */
  Created: number;
  Labels: Record<string, string> | null;
}

export interface DockerCreateOptions {
  name: string;
  Image: string;
  Entrypoint: string[];
  Cmd: string[];
  Labels: Record<string, string>;
  Env: string[];
  WorkingDir: string;
  User: string;
  Tty: false;
  ExposedPorts?: Record<string, Record<string, never>>;
  HostConfig: {
    Init: boolean;
    NetworkMode?: string;
    NanoCpus?: number;
    Memory?: number;
    PortBindings?: Record<string, DockerPortBinding[]>;
    Mounts: { Type: "volume"; Target: string }[];
    Binds?: string[];
    RestartPolicy: { Name: "no" };
  };
}

export interface DockerClient {
  createContainer(o: DockerCreateOptions): Promise<DockerContainer>;
  getContainer(id: string): DockerContainer;
  listContainers(o: { all: boolean; filters: string }): Promise<DockerContainerSummary[]>;
  getImage(name: string): { inspect(): Promise<unknown> };
  /** Resolves to the progress stream (newline-delimited JSON); a failed pull reports `{ error }` in it. */
  pull(ref: string): Promise<NodeJS.ReadableStream>;
  buildImage(context: Buffer, o: { t: string; buildargs?: Record<string, string> }): Promise<NodeJS.ReadableStream>;
}

/** The dockerode client for the local daemon, or the one at `socketPath`. Nothing connects until the first call. */
export function connectDocker(socketPath?: string): DockerClient {
  const docker = socketPath === undefined ? new Docker() : new Docker({ socketPath });
  return docker as unknown as DockerClient;
}
