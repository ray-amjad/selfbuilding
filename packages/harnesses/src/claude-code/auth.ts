import {
  type AuthContext,
  type AuthPlan,
  ConfigError,
  type HarnessCredential,
  MissingCredentialError,
} from "@selfbuilding/core";

export const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
export const API_KEY_VAR = "ANTHROPIC_API_KEY";

// An API key in the environment silently overrides an OAuth token, so each mode strips the other's variables
// (spec §4.9).
const API_MODE_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;
const OAUTH_MODE_VARS = ["CLAUDE_CODE_OAUTH_TOKEN"] as const;

type ClaudeCredentialKind = "oauth-token" | "api-key";

/** The env var a Claude Code credential becomes on the harness child. */
export function claudeCredentialVariable(cred: HarnessCredential): string {
  if (cred.kind === "oauth-token") return OAUTH_TOKEN_VAR;
  if (cred.kind === "api-key") return API_KEY_VAR;
  throw new ConfigError(
    `Claude Code takes credentials of kind "oauth-token" (CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\`) or "api-key" (ANTHROPIC_API_KEY), not "${cred.kind}".`,
  );
}

function resolvedValue(cred: HarnessCredential & { kind: ClaudeCredentialKind }, ctx: AuthContext, name: string) {
  // Core resolves a credential to `{ value, OAUTH_TOKEN | API_KEY }`; callers may also key it by the env var name.
  const short = cred.kind === "oauth-token" ? "OAUTH_TOKEN" : "API_KEY";
  for (const key of [name, short, "value"]) {
    const fromCtx = ctx.values[key];
    if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  }
  // A resolver function can only run on the orchestrator; a plain string can be used as given.
  if (typeof cred.value === "string" && cred.value.length > 0) return cred.value;
  const only = Object.values(ctx.values);
  if (only.length === 1 && typeof only[0] === "string" && only[0].length > 0) return only[0];
  throw new MissingCredentialError({ consumer: `claudeCode() ${cred.kind}` });
}

// Prefixes of Anthropic's token formats; checked so a swapped token fails at plan time, not mid-run.
function checkShape(kind: ClaudeCredentialKind, value: string): void {
  if (kind === "oauth-token" && value.startsWith("sk-ant-api")) {
    throw new ConfigError(
      'This credential looks like an API key but is passed as kind "oauth-token". Use { kind: "api-key" } for ANTHROPIC_API_KEY values.',
    );
  }
  if (kind === "api-key" && value.startsWith("sk-ant-oat")) {
    throw new ConfigError(
      'This credential looks like a subscription OAuth token but is passed as kind "api-key". Use { kind: "oauth-token" } for `claude setup-token` values.',
    );
  }
  if (/[\r\n]/.test(value.trim())) {
    throw new ConfigError(`The Claude Code ${kind} credential contains a line break; pass the token alone.`);
  }
}

/**
 * The credential becomes a 0600 file under `{secrets}`; the runtime reads it into the harness child's env only, so the
 * value never reaches argv, provider env or the plan's `env` (spec §9.2).
 */
export function claudeCodeAuth(cred: HarnessCredential, ctx: AuthContext): AuthPlan {
  const name = claudeCredentialVariable(cred);
  const kind = cred.kind as ClaudeCredentialKind;
  const value = resolvedValue(cred as HarnessCredential & { kind: ClaudeCredentialKind }, ctx, name).trim();
  checkShape(kind, value);
  const path = `${ctx.paths.secrets}/${name}`;
  return {
    env: {},
    files: [{ path, content: value, mode: 0o600, secret: true }],
    stripEnv: kind === "oauth-token" ? [...API_MODE_VARS] : [...OAUTH_MODE_VARS, "ANTHROPIC_AUTH_TOKEN"],
    secretEnv: { [name]: path },
  };
}
