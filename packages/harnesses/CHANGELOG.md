# @selfbuilding/harnesses

## 0.1.0

### Minor Changes

- b437663: Add the Codex harness adapter (`codex()` from `@selfbuilding/harnesses/codex`): `codex exec --json` and
  `exec resume`/`exec fork` invocations, MCP servers as `-c mcp_servers.*` overrides with the tool timeout, the
  normalised event parser and failure classifier with golden fixtures, leased `auth.json` and API-key credentials,
  the credential-pool fallback rules and the `'tested'` version policy. `InvokeContext` gains optional `mcpServers`
  and `hotWaitMs`.

### Patch Changes

- Updated dependencies [b437663]
  - @selfbuilding/core@0.1.0
