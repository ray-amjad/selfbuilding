# 0001: Egress policies a vendor accepts but does not enforce

Status: accepted, November 2026.

## What happened

In the first full live run, the conformance case "a policy the provider cannot enforce raises
EgressPolicyUnsupportedError" failed on both Impello and E2B. A box created with `network: "deny-all"` could still
open a TCP connection to `1.1.1.1:443`.

## Is it our bug?

No. We checked the whole path:

- `#networkOpts` in `packages/sandbox-e2b/src/provider.ts` maps `"deny-all"` to `{ allowInternetAccess: false }` and
  an allowlist to `{ network: { allowOut, denyOut: ["0.0.0.0/0"] } }`. Both are spread straight into the create
  options, and the client wrappers (`e2bClient`, `impelloClient`) pass them to `Sandbox.create` unchanged.
- The SDK (`e2b` 2.62.0, `Sandbox.createSandbox`) sends `allow_internet_access` and a `network` body on
  `POST /v2/sandboxes`. That is the field name in the API schema's `NewSandbox`, so the vendor receives the policy.
- A direct SDK probe on Impello, with no selfbuilding code in the path, reproduced the leak.
- Fork children are created with the parent's stored policy (`sbx.network` metadata), so forks do not drop it.

So the vendor accepts the policy and does not enforce it, at least for these accounts and templates. The adapter
cannot fix that.

`tests/live/support/egress-probe.mjs` repeats the probe for each vendor through its own SDK. It tries
`allowInternetAccess: false`, `denyOut 0.0.0.0/0`, an allowlist, and an open control box, and it prints what the
vendor reports back. Run it when a vendor changes its network layer, or before trusting a policy in production.
The script only runs when `SELFBUILDING_LIVE=1` is set, and no test or CI job runs it.

## Decision

1. **Detect the leak and opt in to refusing it.** `SandboxProvider.probeEgress(box, policy)` is an optional
   method. It opens a TCP connection from inside the box to a public address the policy does not allow. If the
   connection succeeds, the method returns `{ enforced: false }`. The E2B-shape adapter implements it for both
   E2B and Impello.
2. **The `verifyEgress` provider option.** With `verifyEgress: true`, every fresh box with a policy other than
   `"open"` is probed before it is handed out. If the policy leaks, the box is killed and the call throws
   `EgressPolicyUnsupportedError`. The option is off by default, because each probe adds a few seconds to a
   create.
3. **An honest conformance case.** The case is now "a deny-all policy is enforced, refused with
   EgressPolicyUnsupportedError, or detected by probeEgress". A provider passes if the box blocks the connection,
   if the provider refuses the policy, or if its `probeEgress` reports the leak. A provider whose box leaks and
   that has no way to say so still fails. A second case checks that `probeEgress` agrees with a direct
   connection attempt.

## Why not refuse deny-all outright on these vendors?

The vendors document `allowInternetAccess: false` as a working feature, and they may enforce it on other plans or
regions, or fix the leak later. If we refused the policy everywhere, users would lose it in all those places too.
The probe checks what actually happens in each box, so it stays correct when the vendor's behaviour changes.

## Consequences

- With `verifyEgress` off, "deny-all" on E2B or Impello is a request, not a guarantee. Do not rely on it to keep
  secrets in. They already reach a box only as 0600 files, and no host credential is ever placed in one.
- Docker enforces policies itself and needs no probe.
- `verifyEgress` is accepted by `e2b()`, `impello()` and the shared adapter `createE2bShapeProvider`; the two
  factories pass it through unchanged. `probeEgress` works on every E2B and Impello provider.
- The probe address is the first of `1.1.1.1` and `8.8.8.8` that no allowlist entry covers: an equal hostname, an
  equal IP (a port is ignored) or a CIDR that contains it. A substring is not coverage, so an entry `8.8.8.80`
  does not stop the probe from trying `8.8.8.8`. When the allowlist covers both, the box is not probed.
- A probe that could not run (a vendor error such as a 429, a timeout, a connect error, or an exit code other than
  0 or 1) is not a leak. It is retried with backoff up to three times; after that the create fails with a
  retryable `SandboxUnavailableError`. Only a box the create made itself is killed, never one it converged onto
  because a concurrent create won.
