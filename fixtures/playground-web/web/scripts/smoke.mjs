// Boots the built app (`next start`) on a fresh database and proves "add a note" end to end without a browser:
// it posts the form the way a browser with JavaScript off would, then checks both the page and the row.
// Usage: npm run build && npm run smoke        (PORT defaults to a free one)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNotes, openDb, resetDb, SEED_NOTES, seed } from "../lib/db.js";

const BOOT_TIMEOUT_MS = 60_000;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForHealth(base, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no readiness at ${base}/api/health within ${BOOT_TIMEOUT_MS} ms`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

const dir = mkdtempSync(join(tmpdir(), "playground-web-smoke-"));
const dbPath = join(dir, "app.db");
resetDb(dbPath).close();
{
  const db = openDb(dbPath);
  seed(db);
  db.close();
}

const port = Number(process.env.PORT) || (await freePort());
const base = `http://127.0.0.1:${port}`;
const log = [];
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", `${port}`],
  {
    env: { ...process.env, DATABASE_PATH: dbPath, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (d) => log.push(String(d)));
child.stderr.on("data", (d) => log.push(String(d)));

let failed = false;
try {
  const started = Date.now();
  const health = await waitForHealth(base, child);
  check(
    health.ok === true && health.db === "ok",
    `GET /api/health is {"ok":true,"db":"ok"} (${Date.now() - started} ms)`,
  );

  const page = await (await fetch(`${base}/`)).text();
  for (const id of ["note-form", "note-title", "note-body", "note-submit", "note-list", "note-item"]) {
    check(page.includes(`data-testid="${id}"`), `the page has data-testid="${id}"`);
  }
  for (const note of SEED_NOTES) check(page.includes(note.title), `the page lists the seeded note "${note.title}"`);

  // A server action form carries its action id as a hidden field; posting it is what a no-JS browser does.
  const actionField = page.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  check(Boolean(actionField), "the form carries a server action id");
  const title = `Smoke note ${Date.now()}`;
  const form = new FormData();
  form.set(actionField, "");
  form.set("title", title);
  form.set("body", "written by the smoke test");
  const post = await fetch(`${base}/`, { method: "POST", body: form, redirect: "manual" });
  const location = post.headers.get("location") ?? "";
  check(post.status >= 300 && post.status < 400, `submitting the form redirects (status ${post.status})`);
  const added = location.match(/[?&]added=(\d+)/)?.[1];
  check(Boolean(added), `the redirect names the new note (${location})`);

  const after = await (await fetch(new URL(location, base))).text();
  check(after.includes('data-testid="flash"') && after.includes("Note added"), 'the page shows the flash "Note added"');
  check(after.includes(title), "the page shows the new note");

  const db = openDb(dbPath);
  const row = listNotes(db).find((n) => n.id === Number(added));
  db.close();
  check(row?.title === title, `the database has row ${added} with the submitted title`);
} catch (error) {
  failed = true;
  console.error(`not ok - ${error instanceof Error ? error.message : String(error)}`);
  console.error("--- server log ---");
  console.error(log.join("").slice(-8000));
} finally {
  child.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
