# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting: on this repository,
open the Security tab and choose "Report a vulnerability". Do not open a public issue, pull request or discussion
for a vulnerability.

Include what you found, the version or commit, how to reproduce it, and what an attacker gains. We will
acknowledge the report, keep you informed while we work on a fix, and credit you in the release notes unless you
ask us not to. Please give us a reasonable time to release a fix before you disclose it.

Selfbuilding is pre-release. Fixes land on `main` and in the next release; there are no maintained older versions
yet.

## Scope

In scope: weaknesses in Selfbuilding's own code, in particular

- **Sandbox escape through Selfbuilding:** an agent, a workflow script or anything running in a sandbox reaching
  the host process, another sandbox, or a credential it was not given, through the runtime, the tool socket, the
  file transfer, the git sync or a provider adapter.
- **Secret handling:** a credential reaching a command line, a provider's environment, an image, a snapshot, a
  journal, an event, a log, an error message, a Slack message or a PR; a secret file readable by the wrong user; a
  leased login file escaping its lease.
- **Grant forgery and guard bypass:** forging or replaying a `start_workflow` grant, launching a run outside the
  configured caps (sizes, budget, sandboxes, depth), reading another run's status, or a workflow script escaping
  its isolate or its caps.
- **Inbound requests:** the hooks handlers accepting a request without a valid signature, or an answer from
  someone who is not an approver.
- **Git:** an agent pushing a ref outside `selfbuilding/*`, or getting a token that can write.

Out of scope: vulnerabilities in the sandbox vendors, the harness CLIs, GitHub, Slack or Trigger.dev themselves
(report those to them); a vendor not enforcing an egress policy it accepted, which is documented in
`docs/decisions/0001-egress-enforcement.md`; and what an agent does with access you deliberately gave it.

## How secrets are handled

The model the code is built to:

- Secrets are resolved on the host (orchestrator) when a call needs them, from your secret manager or environment
  through `fromEnv`, `fromFile` or a resolver function. They are never printed, and `selfbuilding doctor` reports
  only whether each one resolves.
- A secret reaches a sandbox only as a file with mode 0600 under `/run/selfbuilding/`, owned by root unless the
  harness itself must read it (then by the agent user). Never as an environment variable of the box, never in a
  command line, never baked into an image. On Docker that directory is an anonymous volume, so it never lands in a
  snapshot or a fork image.
- The runtime reads a harness credential into the harness process's environment only, and strips the variables of
  the other credential kind.
- Git: the agent gets a short-lived read-only token; the host, outside the sandbox, mints a write token per launch
  and pushes only `refs/heads/selfbuilding/**` and `refs/selfbuilding/**`. The GitHub App broker refuses to push
  until a ruleset limits the App to those refs.
- `start_workflow` grants are HMAC-signed, expire, and are written root-only so the agent never sees them; the
  supervisor makes the call.
- Known secret values and token shapes are redacted from events, logs and channel messages.
