import {
  ImageUnavailableError,
  SandboxAuthError,
  SandboxFileNotFoundError,
  SandboxGuestGoneError,
  SandboxNotFoundError,
  SandboxQuotaError,
  SandboxUnavailableError,
  SandboxUnsupportedError,
} from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { classify, isRefusal, isTransient, readVendorFailure } from "./errors.js";

const err = (name: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(Object.assign(new Error(message), { name }), extra);
const site = { provider: "e2b", sandboxId: "i1", op: "find" };

describe("classify: vendor failures become sandbox error classes, once, at the boundary", () => {
  it.each([
    [
      "e2b 503 (ServiceBusyError)",
      err("ServiceBusyError", "Service temporarily unavailable", { statusCode: 503 }),
      SandboxUnavailableError,
    ],
    [
      "impello 503 (status prefix only)",
      err("SandboxError", "503: node busy finishing a snapshot"),
      SandboxUnavailableError,
    ],
    ["500", err("SandboxError", "500: internal"), SandboxUnavailableError],
    ["409 while pausing", err("SandboxError", "409: sandbox is pausing"), SandboxUnavailableError],
    ["request timeout", err("TimeoutError", "[canceled] exceeded requestTimeoutMs"), SandboxUnavailableError],
    ["dropped stream", err("SandboxUnreachableError", "connection lost"), SandboxUnavailableError],
    ["proxy says not running", err("SandboxNotRunningError", "sandbox not running"), SandboxUnavailableError],
    [
      "fetch failed",
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
      SandboxUnavailableError,
    ],
    ["positive 404", err("SandboxNotFoundError", "Sandbox i1 not found"), SandboxNotFoundError],
    ["401", err("AuthenticationError", "Unauthorized"), SandboxAuthError],
    ["402 billing", err("SandboxError", "402: payment required"), SandboxAuthError],
    ["403", err("SandboxError", "403: forbidden", { statusCode: 403 }), SandboxAuthError],
    ["429", err("RateLimitError", "Rate limit exceeded"), SandboxQuotaError],
    ["501", err("SandboxError", "501: not implemented"), SandboxUnsupportedError],
  ])("%s", (_label, error, expected) => {
    const classified = classify(error, site);
    expect(classified).toBeInstanceOf(expected);
    expect(classified.cause).toBe(error);
  });

  it("an outage is never a not-found, and never a ghost", () => {
    const outage = classify(err("ServiceBusyError", "busy", { statusCode: 503 }), site);
    expect(outage).not.toBeInstanceOf(SandboxNotFoundError);
    expect(outage).not.toBeInstanceOf(SandboxGuestGoneError);
    expect(isTransient(outage)).toBe(true);
  });

  it("a missing file on a file call is SandboxFileNotFoundError with the path, never a missing box", () => {
    const classified = classify(err("FileNotFoundError", "Path not found"), { ...site, op: "readFile", file: "/x" });
    expect(classified).toBeInstanceOf(SandboxFileNotFoundError);
    expect((classified as SandboxFileNotFoundError).path).toBe("/x");
  });

  it("a missing template on create names the selfbuilding templates", () => {
    const classified = classify(err("SandboxError", "404: template 'claude' not found"), {
      ...site,
      op: "create",
      template: "claude",
    });
    expect(classified).toBeInstanceOf(ImageUnavailableError);
    expect(classified.message).toContain("selfbuilding-claude-code");
  });

  it("a deterministic 4xx is a refusal that is not retried", () => {
    const classified = classify(err("SandboxError", "400: plan limit reached"), site);
    expect(classified).toBeInstanceOf(SandboxUnavailableError);
    expect(isRefusal(classified)).toBe(true);
    expect(isTransient(classified)).toBe(false);
  });

  it("a guest that stayed silent is not transient for openOrCreate (it rebuilds instead)", () => {
    expect(isTransient(new SandboxGuestGoneError({ provider: "e2b" }))).toBe(false);
  });

  it("reads the status from statusCode or the message prefix", () => {
    expect(readVendorFailure(err("SandboxError", "x", { statusCode: 418 })).status).toBe(418);
    expect(readVendorFailure(err("SandboxError", "409: conflict")).status).toBe(409);
    expect(readVendorFailure("plain").status).toBeUndefined();
  });
});
