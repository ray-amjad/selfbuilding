// Plain constants only: the runtime bundles the parser, which reads some of these.

/** The Codex version that passed this release's matrix (the `'tested'` pin, spec §4.11). */
export const CODEX_TESTED_VERSION = "0.164.0";

export const CODEX_NPM_PACKAGE = "@openai/codex";

/** Where images and the install plan put the CLI (spec §4.10). */
export const CODEX_DEFAULT_BINARY = "/usr/local/bin/codex";

export const CODEX_INSTALL_HOSTS: readonly string[] = ["registry.npmjs.org"];

/** The MCP server that carries `submit_result`, `ask_human` and `notify_human`. Always present, always first. */
export const SELFBUILDING_SERVER = "selfbuilding";

/** Default effective hot wait when the caller did not pass one (spec §8.4: `hitl.hotWait` defaults to 10 min). */
export const DEFAULT_HOT_WAIT_MS = 10 * 60 * 1000;

/** The MCP tool timeout is the effective hot wait plus this margin (spec §6.11). */
export const MCP_TIMEOUT_MARGIN_MS = 2 * 60 * 1000;

/** Variables of the auth mode not in use. `auth()` strips all of them: the credential always arrives as auth.json. */
export const CODEX_AUTH_ENV: readonly string[] = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];

/** Names under which `AuthContext.values` may carry the credential, tried in order. */
export const API_KEY_VALUE_NAMES: readonly string[] = ["CODEX_API_KEY", "OPENAI_API_KEY", "API_KEY"];
export const AUTH_FILE_VALUE_NAMES: readonly string[] = ["AUTH_FILE", "auth.json", "CODEX_AUTH_JSON"];
