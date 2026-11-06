// A tiny in-process S3 (path-style HEAD, GET, PUT) that checks every SigV4 signature with its own verifier, so
// the store's signing is proved against an implementation that does not share code with it.
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeObject {
  body: Buffer;
  contentType: string;
  meta: Record<string, string>;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** "header", "query" or "none" */
  auth: "header" | "query" | "none";
}

/** One injected fault, consumed by the next request that matches its method. */
export type Fault = { method?: string; status: number } | { method?: string; drop: true };

export interface FakeS3 {
  endpoint: string;
  objects: Map<string, FakeObject>;
  requests: FakeRequest[];
  faults: Fault[];
  /** Seconds added to the server clock, to expire presigned URLs. */
  clockSkewS: number;
  close(): Promise<void>;
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
// RFC 3986 encoding as SigV4 wants it.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function signingKey(secret: string, date: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

function canonicalQuery(params: [string, string][]) {
  return params
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function canonicalHeaders(req: IncomingMessage, signed: string[]) {
  return signed
    .map((name) => {
      const raw = req.headers[name];
      const value = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
}

function parseAmzDate(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s2] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s2);
}

function xmlError(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

export async function startFakeS3(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  bucket: string;
}): Promise<FakeS3> {
  const region = opts.region ?? "auto";
  const state: Omit<FakeS3, "endpoint" | "close"> = { objects: new Map(), requests: [], faults: [], clockSkewS: 0 };

  const verify = (
    req: IncomingMessage,
    url: URL,
    body: Buffer,
  ): { ok: true; auth: FakeRequest["auth"] } | { ok: false; code: string } => {
    const params = [...url.searchParams.entries()];
    let credential: string;
    let signedHeaders: string[];
    let signature: string;
    let amzDate: string;
    let payloadHash: string;
    let auth: FakeRequest["auth"];
    const header = req.headers.authorization;
    if (header) {
      const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(header);
      if (!m) return { ok: false, code: "AuthorizationHeaderMalformed" };
      [credential, signedHeaders, signature] = [m[1] as string, (m[2] as string).split(";"), m[3] as string];
      amzDate = String(req.headers["x-amz-date"] ?? "");
      payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
      if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== sha256Hex(body)) {
        return { ok: false, code: "XAmzContentSHA256Mismatch" };
      }
      auth = "header";
    } else if (url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256") {
      credential = url.searchParams.get("X-Amz-Credential") ?? "";
      signedHeaders = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
      signature = url.searchParams.get("X-Amz-Signature") ?? "";
      amzDate = url.searchParams.get("X-Amz-Date") ?? "";
      payloadHash = "UNSIGNED-PAYLOAD";
      const expires = Number(url.searchParams.get("X-Amz-Expires"));
      if (!Number.isInteger(expires) || expires < 1 || expires > 604_800)
        return { ok: false, code: "AuthorizationQueryParametersError" };
      const now = Date.now() + state.clockSkewS * 1000;
      if (now > parseAmzDate(amzDate) + expires * 1000) return { ok: false, code: "AccessDenied" };
      auth = "query";
    } else {
      return { ok: false, code: "AccessDenied" };
    }
    const [keyId, date, credRegion, service, terminator] = credential.split("/");
    if (keyId !== opts.accessKeyId) return { ok: false, code: "InvalidAccessKeyId" };
    if (credRegion !== region || service !== "s3" || terminator !== "aws4_request") {
      return { ok: false, code: "AuthorizationHeaderMalformed" };
    }
    if (!signedHeaders.includes("host")) return { ok: false, code: "AccessDenied" };
    const query = canonicalQuery(params.filter(([k]) => k !== "X-Amz-Signature"));
    const canonical = [
      req.method,
      url.pathname,
      query,
      canonicalHeaders(req, signedHeaders),
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
    const expected = createHmac("sha256", signingKey(opts.secretAccessKey, date as string, region, "s3"))
      .update(toSign)
      .digest("hex");
    if (expected !== signature) return { ok: false, code: "SignatureDoesNotMatch" };
    return { ok: true, auth };
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://fake");
      const method = req.method ?? "GET";
      const faultAt = state.faults.findIndex((f) => f.method === undefined || f.method === method);
      const verdict = verify(req, url, body);
      state.requests.push({
        method,
        path: decodeURIComponent(url.pathname),
        query: Object.fromEntries(url.searchParams),
        auth: verdict.ok ? verdict.auth : "none",
      });
      if (faultAt >= 0) {
        const [fault] = state.faults.splice(faultAt, 1);
        if (fault && "drop" in fault) {
          req.socket.destroy();
          return;
        }
        if (fault) return xmlError(res, fault.status, fault.status === 429 ? "SlowDown" : "InternalError");
      }
      if (!verdict.ok) return xmlError(res, 403, verdict.code);
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      if (bucket !== opts.bucket) return xmlError(res, 404, "NoSuchBucket");
      if (method === "PUT") {
        const meta: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (name.startsWith("x-amz-meta-")) meta[name] = String(value);
        }
        state.objects.set(key, {
          body,
          contentType: String(req.headers["content-type"] ?? "binary/octet-stream"),
          meta,
        });
        res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
        return res.end();
      }
      if (method === "GET" || method === "HEAD") {
        const object = state.objects.get(key);
        if (!object) {
          if (method === "HEAD") {
            res.writeHead(404);
            return res.end();
          }
          return xmlError(res, 404, "NoSuchKey");
        }
        const disposition = url.searchParams.get("response-content-disposition");
        res.writeHead(200, {
          "content-type": object.contentType,
          "content-length": object.body.length,
          ...object.meta,
          ...(disposition ? { "content-disposition": disposition } : {}),
        });
        return res.end(method === "HEAD" ? undefined : object.body);
      }
      return xmlError(res, 405, "MethodNotAllowed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
