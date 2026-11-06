import { MissingCredentialError, type Secret } from "@selfbuilding/core";

/** Resolves a secret on the orchestrator when it is needed, so a rotated value takes effect on the next mint. */
export async function resolveSecret(secret: Secret, consumer: string): Promise<string> {
  const value = typeof secret === "function" ? await secret() : secret;
  if (typeof value !== "string" || value.trim().length === 0) throw new MissingCredentialError({ consumer });
  return value.trim();
}
