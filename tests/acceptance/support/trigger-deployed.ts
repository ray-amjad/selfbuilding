// Support for acceptance 16 (release-prep §3.3): one fake S3 bucket behind a fetch stub, and a way to give every
// Trigger task run its own host, with its own result store instance, as separate machines of a deployed project
// would have. Nothing is shared between task runs but the bucket and the local Trigger stand-in.
import { createHash } from "node:crypto";
import { s3ResultStore } from "@selfbuilding/artifacts-s3";
import type { Json, ResultStore } from "@selfbuilding/core";
import {
  createTriggerHost,
  type LocalTrigger,
  type TriggerHostOptions,
  type TriggerScheduleDefinition,
  type TriggerSdk,
  type TriggerTaskDefinition,
} from "@selfbuilding/host-trigger";

export interface FakeBucket {
  fetch: typeof fetch;
  objects: Map<string, { body: string; etag: string }>;
  /** Conditional PUTs the bucket refused with 412. */
  refused: number;
}

/** Path-style GET and PUT with If-None-Match / If-Match, and ListObjectsV2 with continuation tokens. */
export function fakeBucket(bucket: string, pageSize = 50): FakeBucket {
  const state: FakeBucket = { objects: new Map(), refused: 0, fetch: undefined as unknown as typeof fetch };
  let writes = 0;
  const xml = (status: number, code: string) =>
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, { status });
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const [, b, ...rest] = url.pathname.split("/");
    if (b !== bucket) return xml(404, "NoSuchBucket");
    if (!req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")) return xml(403, "AccessDenied");
    const key = rest.map(decodeURIComponent).join("/");
    if (req.method === "GET" && rest.length === 0) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const after = url.searchParams.get("continuation-token");
      const all = [...state.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = after ? all.indexOf(Buffer.from(after, "base64url").toString()) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      const truncated = start + pageSize < all.length;
      const next = truncated
        ? `<NextContinuationToken>${Buffer.from(page.at(-1) ?? "").toString("base64url")}</NextContinuationToken>`
        : "";
      const contents = page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`).join("");
      return new Response(
        `<ListBucketResult>${contents}<IsTruncated>${truncated}</IsTruncated>${next}</ListBucketResult>`,
      );
    }
    if (req.method === "GET") {
      const object = state.objects.get(key);
      if (!object) return xml(404, "NoSuchKey");
      return new Response(object.body, { headers: { etag: object.etag } });
    }
    if (req.method === "PUT") {
      const body = await req.text();
      const existing = state.objects.get(key);
      const ifMatch = req.headers.get("if-match");
      if ((req.headers.get("if-none-match") === "*" && existing) || (ifMatch !== null && existing?.etag !== ifMatch)) {
        state.refused += 1;
        return xml(412, "PreconditionFailed");
      }
      const etag = `"${createHash("md5").update(`${body}#${++writes}`).digest("hex")}"`;
      state.objects.set(key, { body, etag });
      return new Response(null, { headers: { etag } });
    }
    return xml(405, "MethodNotAllowed");
  }) as typeof fetch;
  return state;
}

/** A fresh `s3ResultStore` over the bucket: no cache, no memory shared with any other instance. */
export function storeOver(bucket: FakeBucket, name: string): ResultStore {
  return s3ResultStore({
    bucket: name,
    endpoint: "https://s3.fake.test",
    accessKeyId: "AKIDTESTFAKE0000",
    secretAccessKey: "fake-secret-value-0123456789",
    fetch: bucket.fetch,
    retry: { baseDelayMs: 1 },
  });
}

/**
 * Registers the three Selfbuilding tasks on `t` so that every task run (and every retry of one) builds its own
 * `createTriggerHost(make())`: its own store instance, driver and in-process state, as on another machine.
 * Returns how many hosts were built.
 */
export function perRunHosts(t: LocalTrigger, make: () => Omit<TriggerHostOptions, "trigger">): { built: number } {
  const counter = { built: 0 };
  const build = () => {
    const tasks = new Map<string, TriggerTaskDefinition<unknown, unknown> | TriggerScheduleDefinition>();
    // The real stand-in for every call, except that task definitions are captured instead of registered.
    const capture = new Proxy(t, {
      get(target, prop, receiver) {
        if (prop === "task" || prop === "scheduleTask") {
          return (def: TriggerTaskDefinition<unknown, unknown>) => {
            tasks.set(def.id, def);
            return { id: def.id };
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TriggerSdk;
    createTriggerHost({ ...make(), trigger: capture });
    counter.built += 1;
    return tasks;
  };
  const template = build();
  for (const [id, def] of template) {
    if ("cron" in def) {
      t.scheduleTask({
        ...def,
        run: (payload, params) => (build().get(id) as TriggerScheduleDefinition).run(payload, params),
      });
      continue;
    }
    t.task<unknown, unknown>({
      ...def,
      run: (payload, params) => (build().get(id) as TriggerTaskDefinition<unknown, unknown>).run(payload, params),
      onCancel: async (params) => {
        await (build().get(id) as TriggerTaskDefinition<unknown, unknown>).onCancel?.(params);
      },
    });
  }
  return counter;
}

export type { Json };
