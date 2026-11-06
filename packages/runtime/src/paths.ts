import path from "node:path";
import { ATTEMPT_FILES, RUNTIME_ENV, SANDBOX_PATHS } from "@selfbuilding/core";

/** Step keys and launch ids name directories, so they must be plain file names. */
const SAFE_NAME = /^[A-Za-z0-9._@:+=-]{1,200}$/;

export function isSafeName(value: string): boolean {
  return SAFE_NAME.test(value) && value !== "." && value !== "..";
}

/**
 * The canonical filesystem layout (spec §6.4) resolved against the box root. In a real sandbox the root is "" and
 * every path is used as written; under a test provider `SELFBUILDING_FS_ROOT` names the directory standing in for "/".
 */
export class Layout {
  readonly root: string;

  constructor(root: string = process.env[RUNTIME_ENV.fsRoot] ?? "") {
    this.root = root.replace(/\/+$/, "");
  }

  /** A canonical sandbox path on this machine's filesystem. */
  host(canonical: string): string {
    return this.root ? path.join(this.root, canonical) : canonical;
  }

  /** Maps a path that may be canonical onto this filesystem; paths already under the root are left alone. */
  map(value: string): string {
    if (!this.root || !value.startsWith("/") || value.startsWith(`${this.root}/`)) return value;
    if (/^\/(selfbuilding|run\/selfbuilding|tmp)(\/|$)/.test(value)) return this.host(value);
    return value;
  }

  /**
   * Maps canonical paths inside a shell command (hooks, done checks) onto this filesystem. A no-op in a real sandbox;
   * under a test provider it gives the command the same view of the box that the provider's own execs get.
   */
  mapCommand(command: string): string {
    if (!this.root) return command;
    const root = this.root;
    return command.replace(
      /(^|[\s'"=:;&|(<>`])(\/run\/selfbuilding|\/selfbuilding|\/tmp)(?=$|[/\s'";&|)<>`])/g,
      (match: string, lead: string, _prefix: string, offset: number) =>
        command.startsWith(root, offset + lead.length) ? match : `${lead}${root}${match.slice(lead.length)}`,
    );
  }

  get workdir(): string {
    return this.host(SANDBOX_PATHS.workdir);
  }
  get home(): string {
    return this.host(SANDBOX_PATHS.home);
  }
  get inDir(): string {
    return this.host(SANDBOX_PATHS.in);
  }
  get runDir(): string {
    return this.host(SANDBOX_PATHS.run);
  }
  get toolSocket(): string {
    return this.host(SANDBOX_PATHS.toolSocket);
  }
  get callLock(): string {
    return this.host(SANDBOX_PATHS.callLock);
  }
  get supervisorPid(): string {
    return this.host(SANDBOX_PATHS.supervisorPid);
  }
  get secrets(): string {
    return this.host(SANDBOX_PATHS.secrets);
  }
  get nsReap(): string {
    return this.host(SANDBOX_PATHS.nsReap);
  }
  get state(): string {
    return this.host(SANDBOX_PATHS.state);
  }
  get setupDone(): string {
    return this.host(SANDBOX_PATHS.setupDone);
  }

  launchMarker(launchId: string): string {
    return this.host(`${SANDBOX_PATHS.launches}/${launchId}.launched`);
  }

  launchStatus(launchId: string): string {
    return this.host(`${SANDBOX_PATHS.launches}/${launchId}.status`);
  }

  attempt(stepKey: string, attempt: number): AttemptLayout {
    return new AttemptLayout(this.host(`${SANDBOX_PATHS.calls}/${stepKey}/${attempt}`));
  }
}

/** Files inside one attempt directory. */
export class AttemptLayout {
  constructor(readonly dir: string) {}

  file(name: string): string {
    return path.join(this.dir, name);
  }
  get spec(): string {
    return this.file(ATTEMPT_FILES.spec);
  }
  get state(): string {
    return this.file(ATTEMPT_FILES.state);
  }
  get events(): string {
    return this.file(ATTEMPT_FILES.events);
  }
  get submissions(): string {
    return this.file(ATTEMPT_FILES.submissions);
  }
  get result(): string {
    return this.file(ATTEMPT_FILES.result);
  }
  get outcome(): string {
    return this.file(ATTEMPT_FILES.outcome);
  }
  get outcomeAck(): string {
    return this.file(ATTEMPT_FILES.outcomeAck);
  }
  get cancel(): string {
    return this.file(ATTEMPT_FILES.cancel);
  }
  get wake(): string {
    return this.file(ATTEMPT_FILES.wake);
  }
  get inbox(): string {
    return this.file(ATTEMPT_FILES.inbox);
  }
  get inboxOpen(): string {
    return this.file(ATTEMPT_FILES.inboxOpen);
  }
  get runtimeLog(): string {
    return this.file(ATTEMPT_FILES.runtimeLog);
  }
  get harnessStderr(): string {
    return this.file(ATTEMPT_FILES.harnessStderr);
  }
  get hooks(): string {
    return this.file(ATTEMPT_FILES.hooks);
  }
  get protected(): string {
    return this.file(ATTEMPT_FILES.protected);
  }
  get artifacts(): string {
    return this.file("artifacts");
  }
  wakeSent(launchId: string, rearm: number): string {
    return this.file(`wake.${launchId}.w${rearm}.sent`);
  }
  get wakePending(): string {
    return this.file("wake.pending");
  }
}
