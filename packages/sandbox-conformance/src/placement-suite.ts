import {
  type ProviderSandbox,
  SANDBOX_PATHS,
  type SandboxProvider,
  type SandboxRef,
  SELFBUILDING_LABELS,
} from "@selfbuilding/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConformanceOptions, Fixture, GIT, sh } from "./support.js";

const REPO = `${SANDBOX_PATHS.workdir}/repo`;

/** A small repository with a base commit on main and one feature commit on `feature`. Returns the feature head. */
async function buildRepo(box: ProviderSandbox): Promise<{ base: string; head: string }> {
  await sh(
    box,
    `mkdir -p ${REPO} && cd ${REPO} && ${GIT} init -q && echo base > README.md && ${GIT} add -A && ${GIT} commit -qm base`,
  );
  const base = await sh(box, `cd ${REPO} && git rev-parse HEAD`);
  await sh(
    box,
    `cd ${REPO} && ${GIT} checkout -qb feature && echo 'export const x = 1;' > feature.ts && ${GIT} add -A && ${GIT} commit -qm "add feature"`,
  );
  return { base, head: await sh(box, `cd ${REPO} && git rev-parse HEAD`) };
}

/**
 * Moves branches between boxes with a git bundle carried by readFile/writeFiles, the provider-neutral handoff
 * (spec §3.11: workspaces move through git and writeFiles). Works across providers.
 */
export async function transferRepo(from: ProviderSandbox, to: ProviderSandbox, branches: string[]): Promise<void> {
  const bundle = "/tmp/selfbuilding-handoff.bundle";
  await sh(from, `cd ${REPO} && git bundle create -q ${bundle} ${branches.join(" ")}`);
  await to.writeFiles([{ path: bundle, data: await from.readFile(bundle) }]);
  await sh(
    to,
    `rm -rf ${REPO} && ${GIT} clone -q ${bundle} ${REPO} && cd ${REPO} && for b in ${branches.join(" ")}; do git branch -f $b origin/$b 2>/dev/null || true; done && git checkout -q ${branches.at(-1)}`,
  );
}

/**
 * Registers the placement suite (spec §3.11, §10.3 L1 "Sandbox placement"): fresh isolation, a shared box, handoff
 * by git branch, snapshot, review on forks of the build box, and review on a different provider. `secondary` is the
 * provider reviewers may run on (e.g. build on one vendor, review on another); without it the cross-provider cases
 * are skipped.
 */
export function describePlacement(
  name: string,
  makeProviders: () =>
    | { primary: SandboxProvider; secondary?: SandboxProvider }
    | Promise<{ primary: SandboxProvider; secondary?: SandboxProvider }>,
  opts: ConformanceOptions = {},
): void {
  describe(`sandbox placement: ${name}`, () => {
    if (opts.skip) {
      it.skip(`all cases [skipped: ${opts.skip}]`, () => undefined);
      return;
    }
    const timeout = opts.timeoutMs ?? 60_000;
    const fx = new Fixture(opts);
    let primary: SandboxProvider;
    let secondary: SandboxProvider | undefined;

    beforeAll(async () => {
      const providers = await makeProviders();
      primary = providers.primary;
      secondary = providers.secondary;
    }, timeout);
    afterAll(async () => {
      if (primary) await fx.cleanup(primary);
      if (secondary) await fx.cleanup(secondary);
    }, timeout);

    const forkChildren = async (parent: ProviderSandbox, n: number): Promise<ProviderSandbox[]> => {
      const results = await primary.fork?.(parent.ref, {
        children: Array.from({ length: n }, (_, i) => {
          const childName = `${parent.ref.name}-r${i}`;
          return {
            name: childName,
            labels: {
              [SELFBUILDING_LABELS.deployment]: fx.deployment,
              [SELFBUILDING_LABELS.run]: fx.runId,
              [SELFBUILDING_LABELS.name]: childName,
            },
          };
        }),
        lifetimeMs: fx.lifetimeMs,
      });
      if (!results) throw new Error("fork returned nothing");
      for (const result of results) if (result instanceof Error) throw result;
      return results as ProviderSandbox[];
    };

    it(
      "fresh: a box per call; B cannot see A's uncommitted file",
      async () => {
        const a = await fx.box(primary, "root/1/build");
        const b = await fx.box(primary, "root/2/review");
        expect(a.ref.id).not.toBe(b.ref.id);
        await sh(a, `echo draft > ${SANDBOX_PATHS.workdir}/draft.txt`);
        expect((await b.exec(`test -e ${SANDBOX_PATHS.workdir}/draft.txt`)).exitCode).not.toBe(0);
      },
      timeout,
    );

    it(
      "shared: two calls on one handle share one box and its working tree",
      async () => {
        const first = await primary.openOrCreate(fx.key("box#0"), fx.spec("box#0"));
        await sh(first.handle, `echo wip > ${SANDBOX_PATHS.workdir}/wip.txt`);
        const second = await primary.openOrCreate(fx.key("box#0"), fx.spec("box#0"));
        expect(second.handle.ref.id).toBe(first.handle.ref.id);
        expect(await sh(second.handle, `cat ${SANDBOX_PATHS.workdir}/wip.txt`)).toBe("wip");
      },
      timeout,
    );

    it(
      "handoff by git branch: B checks out A's branch and sees A's commit",
      async () => {
        const a = await fx.box(primary, "root/3/build");
        const b = await fx.box(primary, "root/4/consume");
        const { head } = await buildRepo(a);
        await transferRepo(a, b, ["main", "feature"]);
        expect(await sh(b, `cd ${REPO} && git rev-parse feature`)).toBe(head);
      },
      timeout,
    );

    it(
      "snapshot: B starts from A's snapshot; A's later writes do not reach B",
      async (ctx) => {
        if (typeof primary.snapshot !== "function") ctx.skip("the primary provider has no snapshot()");
        const a = await fx.box(primary, "root/5/build");
        const { head } = await buildRepo(a);
        await sh(a, `echo untracked > ${REPO}/notes.txt`);
        const snap = await primary.snapshot?.(a.ref, { name: "placement" });
        if (!snap) throw new Error("snapshot returned nothing");
        await sh(a, `echo later > ${REPO}/later.txt`);
        const image = (opts.snapshotImage ?? ((s, base) => ({ ...base, ref: s.snapshotId })))(snap, fx.image);
        const b = await fx.box(primary, "root/6/from-snapshot", { image });
        expect(await sh(b, `cd ${REPO} && git rev-parse HEAD`)).toBe(head);
        expect(await sh(b, `cat ${REPO}/notes.txt`)).toBe("untracked");
        expect((await b.exec(`test -e ${REPO}/later.txt`)).exitCode).not.toBe(0);
      },
      timeout,
    );

    it(
      "review on forks: each reviewer sees the build box's tree, including uncommitted work, and diverges alone",
      async (ctx) => {
        if (typeof primary.fork !== "function") ctx.skip("the primary provider has no fork()");
        const builder = await fx.box(primary, "root/7/build");
        const { base, head } = await buildRepo(builder);
        await sh(builder, `echo 'pending fix' > ${REPO}/uncommitted.txt`);
        const [claudeReviewer, codexReviewer] = await forkChildren(builder, 2);
        if (!claudeReviewer || !codexReviewer) throw new Error("expected two fork children");
        for (const reviewer of [claudeReviewer, codexReviewer]) {
          expect(reviewer.ref.id).not.toBe(builder.ref.id);
          expect(await sh(reviewer, `cd ${REPO} && git rev-parse HEAD`)).toBe(head);
          expect(await sh(reviewer, `cd ${REPO} && git diff --name-only ${base} HEAD`)).toBe("feature.ts");
          expect(await sh(reviewer, `cat ${REPO}/uncommitted.txt`)).toBe("pending fix");
        }
        await sh(claudeReviewer, `echo 'finding: x' > ${REPO}/review-notes.md`);
        expect((await codexReviewer.exec(`test -e ${REPO}/review-notes.md`)).exitCode).not.toBe(0);
        expect((await builder.exec(`test -e ${REPO}/review-notes.md`)).exitCode).not.toBe(0);
        await sh(builder, `echo fixed > ${REPO}/fix.txt`);
        expect((await claudeReviewer.exec(`test -e ${REPO}/fix.txt`)).exitCode).not.toBe(0);
      },
      timeout,
    );

    it(
      "review on a different provider: the reviewer's box gets the build's branch and diff",
      async (ctx) => {
        if (!secondary) ctx.skip("no secondary provider (return one from makeProviders)");
        const other = secondary as SandboxProvider;
        const builder = await fx.box(primary, "root/8/build");
        const { base, head } = await buildRepo(builder);
        const reviewer = await fx.box(other, "root/9/review");
        expect(reviewer.ref.provider).toBe(other.id);
        await transferRepo(builder, reviewer, ["main", "feature"]);
        expect(await sh(reviewer, `cd ${REPO} && git rev-parse HEAD`)).toBe(head);
        expect(await sh(reviewer, `cd ${REPO} && git diff --name-only ${base} HEAD`)).toBe("feature.ts");
        const found: SandboxRef | null = await other.find(fx.key("root/9/review"));
        expect(found?.id).toBe(reviewer.ref.id);
        expect(await primary.find(fx.key("root/9/review"))).toBeNull();
      },
      timeout,
    );

    it(
      "parallel review: one reviewer on a fork, one on the other provider, both on the same head",
      async (ctx) => {
        if (typeof primary.fork !== "function") ctx.skip("the primary provider has no fork()");
        if (!secondary) ctx.skip("no secondary provider (return one from makeProviders)");
        const other = secondary as SandboxProvider;
        const builder = await fx.box(primary, "root/10/build");
        const { head } = await buildRepo(builder);
        const heads = await Promise.all([
          (async () => {
            const [fork] = await forkChildren(builder, 1);
            if (!fork) throw new Error("expected a fork child");
            return sh(fork, `cd ${REPO} && git rev-parse HEAD`);
          })(),
          (async () => {
            const reviewer = await fx.box(other, "root/11/review");
            await transferRepo(builder, reviewer, ["main", "feature"]);
            return sh(reviewer, `cd ${REPO} && git rev-parse HEAD`);
          })(),
        ]);
        expect(heads).toEqual([head, head]);
      },
      timeout,
    );
  });
}
