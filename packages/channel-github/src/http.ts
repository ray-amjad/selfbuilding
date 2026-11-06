import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { ConfigError } from "@selfbuilding/core";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubHttp {
  /** No trailing slash, e.g. "https://api.github.com". */
  apiUrl: string;
  fetch: FetchLike;
}

export interface GithubResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

/** A transport failure: the request may never have reached GitHub. Callers map it to their own retryable error. */
export class TransportFailure {
  constructor(readonly cause: unknown) {}
}

export function normaliseApiUrl(apiUrl: string | undefined): string {
  return (apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
}

/**
 * One REST call. Never throws for an HTTP status; a network failure resolves to a `TransportFailure`, so each
 * caller decides which registry error a failure becomes.
 */
export async function githubRequest<T = unknown>(
  http: GithubHttp,
  method: string,
  path: string,
  opts: { auth: string; body?: unknown },
): Promise<GithubResponse<T> | TransportFailure> {
  let response: Response;
  try {
    response = await http.fetch(http.apiUrl + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: opts.auth,
        "user-agent": "selfbuilding",
        "x-github-api-version": "2022-11-28",
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  } catch (cause) {
    return new TransportFailure(cause);
  }
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON (an HTML error page from a proxy, say); keep the text for the message.
    }
  }
  return { status: response.status, ok: response.ok, body: body as T };
}

/** GitHub's `message` field, or a short excerpt of the body, for error messages. Never contains a token we sent. */
export function githubMessage(response: GithubResponse): string {
  const body = response.body as { message?: unknown; errors?: unknown } | string | undefined;
  if (body && typeof body === "object" && typeof body.message === "string") {
    // A 422 says only "Validation Failed"; the reason ("No commits between…", "Draft pull requests are not
    // supported…") is in errors[].
    const reasons = Array.isArray(body.errors)
      ? body.errors
          .map((e) => (typeof e === "string" ? e : (e as { message?: unknown })?.message))
          .filter((m): m is string => typeof m === "string" && m !== "")
      : [];
    return reasons.length > 0 ? `${body.message}: ${reasons.join("; ").slice(0, 400)}` : body.message;
  }
  if (typeof body === "string" && body.length > 0) return body.slice(0, 200);
  return `HTTP ${response.status}`;
}

export function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

export function loadPrivateKey(pem: string): KeyObject {
  try {
    return createPrivateKey(pem.replace(/\\n/g, "\n"));
  } catch (cause) {
    throw new ConfigError(
      "The GitHub App privateKey is not a PEM private key. Pass the .pem file GitHub generated for the App, for example privateKey: fromFile(new URL('./app.pem', import.meta.url).href).",
      { cause },
    );
  }
}

/**
 * The App's own JWT (RS256), used only to look up installations and mint installation tokens. `iat` is backdated
 * 60 s against clock drift; GitHub refuses an `exp` more than 10 minutes out, so it is 9.
 */
export function appJwt(appId: number | string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
}
