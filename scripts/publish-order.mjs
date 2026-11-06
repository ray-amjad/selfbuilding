#!/usr/bin/env node
// Prints the publishable workspace packages (`packages/*`) leaves first, one name per line, so each package is
// published after every workspace package it depends on (docs/spec/release-prep.md §6.3).
//
//   node scripts/publish-order.mjs          names in publish order
//   node scripts/publish-order.mjs --json   the same order as a JSON array
//
// Edges come from `dependencies`, `peerDependencies` and `optionalDependencies`; `devDependencies` are not needed by
// a consumer, so they do not constrain the order. Ties are broken by name so the output is stable.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = path.join(ROOT, "packages");

const pkgs = new Map();
for (const dir of readdirSync(PACKAGES).sort()) {
  const file = path.join(PACKAGES, dir, "package.json");
  if (!existsSync(file)) continue;
  const json = JSON.parse(readFileSync(file, "utf8"));
  pkgs.set(json.name, json);
}

const deps = new Map();
for (const [name, json] of pkgs) {
  const all = { ...json.dependencies, ...json.peerDependencies, ...json.optionalDependencies };
  deps.set(name, new Set(Object.keys(all).filter((d) => pkgs.has(d) && d !== name)));
}

const order = [];
const done = new Set();
while (done.size < pkgs.size) {
  const ready = [...pkgs.keys()].filter((n) => !done.has(n) && [...deps.get(n)].every((d) => done.has(d))).sort();
  if (ready.length === 0) {
    const left = [...pkgs.keys()].filter((n) => !done.has(n));
    console.error(`publish-order: dependency cycle among ${left.join(", ")}.`);
    process.exit(1);
  }
  // One at a time, so a package appears as soon as it can and the order reads leaves first.
  const next = ready[0];
  order.push(next);
  done.add(next);
}

if (process.argv.includes("--json")) console.log(JSON.stringify(order));
else for (const name of order) console.log(name);
