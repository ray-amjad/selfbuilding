# Sizes and templates

A size names how big a sandbox is. Calls ask for a name; the provider gives exactly that size or refuses with an
error that says how to fix it. There is no silent fallback to another size and no build on demand.

## Presets and your own sizes

| Name | vCPU | Memory |
|---|---:|---:|
| `small` | 2 | 4096 MiB |
| `medium` | 4 | 8192 MiB |
| `large` | 8 | 16384 MiB |

These are `BUILT_IN_SIZES` in `@selfbuilding/core`. Add names in the config:

```ts
defineConfig({
  sizes: {
    xlarge: { vcpu: 16, memoryMiB: 32768 },
    "big-disk": { vcpu: 4, memoryMiB: 8192, diskGiB: 100 },
  },
});
```

Names match `^[a-z][a-z0-9-]{0,23}$`, and `vcpu` and `memoryMiB` are positive integers. Redefining `small`, `medium`
or `large` with other numbers is a `ConfigError`, because templates are built and named per preset.

## Asking for a size

| Where | Applies to |
|---|---|
| `agent({ size })`, `X(input, { size })` | a fresh box for that call only; ignored on a shared handle or a fork, whose box already exists (a warning is logged once) |
| `Agent.fromSkill(dir, { defaults: { size } })` | fresh boxes of that agent (`Verify` defaults to `medium`) |
| `factory({ defaults: { size } })` | every fresh box and every `sandbox()` handle in the factory |
| `sandbox({ size })` | that handle's box |
| `box.fork(n, { size })` | the children; default the parent's size |

For a fresh box: call option, then the agent's default, then the factory default. With none of them, no size is
sent and the provider's default box is used (on E2B and Impello that is the `small` template).

## How providers give sizes

- **Docker** sizes each container when it is created, so any size up to `docker({ maxVcpu, maxMemoryMiB })` works,
  and a fork may take another size than its parent. One image per harness.
- **E2B and Impello** fix the size in the template when it is built. Each size is its own template, a fork keeps
  its parent's size, and only sizes whose template you built exist.

Template names: `selfbuilding-<harness>` for `small` and `selfbuilding-<harness>-<size>` for the rest, where the
harness is `claude-code`, `codex` or `all-harnesses` (`selfbuilding-codex-medium`,
`selfbuilding-all-harnesses-large`). Build them, then list them on the provider:

```sh
npx selfbuilding images build --provider e2b --harness codex --size small,medium
npx selfbuilding images build --provider e2b --all-harnesses --size medium
```

```ts
e2b({ apiKey, template: "selfbuilding-codex", sizes: ["small", "medium"] });
```

`--harness all` builds each harness separately; `--all-harnesses` (or `--harness all-harnesses`) builds the one
combined image, and both together build all three. `--size all` builds every name in the size table. Every size is
checked against the provider's limits before anything is built: a refused one is printed with its fix and
skipped, and the rest still build.

## The refusal and its fix

A size that cannot be given throws `SizeUnavailableError` (code `size_unavailable`) after one
`sandbox.size_refused` event. Its message ends with the fix:

| Reason | When | Fix in the message |
|---|---|---|
| `not-sizable` | the provider takes no sizes | drop the size, or run the call on Docker, E2B or Impello |
| `fork-inherits` | a fork asks for another size on a template provider | create the parent at that size, or run on a fresh box |
| `over-limit` | more vCPU or memory than the provider or plan allows | provider-specific: E2B Hobby allows 8 vCPU and 8 GiB (use `medium`, or `e2b({ plan: "pro" })`); Impello has no 8 vCPU pool; Docker names `docker({ maxVcpu, maxMemoryMiB })` |
| `invalid-shape` | the provider offers only certain shapes | define a size with one of them |
| `not-built` | a template provider has no template for it | `selfbuilding images build --provider <id> --harness <harness> --size <size>`, then add it to `<id>({ sizes })` |

An unknown name throws `SizeUnknownError` listing the known ones. In `parallel()` a refused agent call is `null`,
and `.settled()` gives `{ ok: false, code: "size_unavailable" }`. Workflow scripts may only ask for sizes in
`scripts.allowedSizes` (default `small` and `medium`).

## Usage

Each sized box is labelled `selfbuilding.size=<name>`, and an agent result's `usage.sandboxVcpuMs` is box time
weighted by vCPU, so a `large` box costs four times a `small` one in the run's accounting.
