# @selfbuilding/script

`runScript` runs a workflow script written by an agent inside a QuickJS (WASM) isolate that exposes only the
Selfbuilding primitives, with caps on agent calls, sandboxes, budget and wall-clock time. `createScriptFactory`
wraps it as a factory.

```sh
pnpm add @selfbuilding/script
```

Requires Node 22.12 or later. Pre-release.

- [Writing a workflow script](https://github.com/ray-amjad/selfbuilding/blob/main/docs/guides/writing-a-workflow-script.md)
- [Agent-launched workflows](https://github.com/ray-amjad/selfbuilding/blob/main/docs/guides/agent-launched-workflows.md)
- [Project README](https://github.com/ray-amjad/selfbuilding#readme)
