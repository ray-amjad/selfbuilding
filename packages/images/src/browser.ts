import { type McpServerSpec, SANDBOX_PATHS } from "@selfbuilding/core";
import type { ImageStep } from "./index.js";

// The headless browser baked into the Codex image (demo-path §3), so Verify can drive a real web app.

/** The `playwright` package installed globally; scripts in the box `import("playwright")` this version. */
export const PLAYWRIGHT_VERSION = "1.64.1";

/** The browser MCP server. It carries its own Playwright build, whose Chromium is installed alongside. */
export const PLAYWRIGHT_MCP_VERSION = "0.0.83";

/** Root-owned, world-readable; shared by every user in the box. */
export const PLAYWRIGHT_BROWSERS_PATH = "/opt/selfbuilding/browsers";

export const PLAYWRIGHT_MCP_BIN = "/usr/local/bin/playwright-mcp";

/** Where Verify's screenshots and traces land, inside the collected output tree. */
export const BROWSER_OUTPUT_DIR = `${SANDBOX_PATHS.out}/files/verify`;

/** The smallest size a browser call should ask for: Chromium plus a dev server does not fit in small. */
export const BROWSER_MIN_SIZE = "medium";

const GLOBAL_MODULES = "/usr/local/lib/node_modules";
const MCP_PACKAGE = `${GLOBAL_MODULES}/@playwright/mcp`;
const MCP_PLAYWRIGHT_CORE = `${MCP_PACKAGE}/node_modules/playwright-core`;

/** Add to a call's `mcpServers` to give its agent the browser. `--no-sandbox` lives here, never image-wide. */
export const BROWSER_MCP_SERVER: McpServerSpec = Object.freeze({
  name: "browser",
  type: "stdio",
  command: PLAYWRIGHT_MCP_BIN,
  args: Object.freeze([
    "--headless",
    "--isolated",
    "--browser",
    "chromium",
    "--no-sandbox",
    "--output-dir",
    BROWSER_OUTPUT_DIR,
  ]) as string[],
  // Harnesses start MCP servers with an allow-listed environment, so the image-wide variable may not arrive.
  env: Object.freeze({ PLAYWRIGHT_BROWSERS_PATH }),
}) as McpServerSpec;

/** The `browser` entry of `/opt/selfbuilding/image-manifest.json`. */
export interface BrowserManifest {
  engine: "chromium";
  playwright: string;
  mcp: string;
  browsersPath: string;
}

export const BROWSER_MANIFEST: BrowserManifest = Object.freeze({
  engine: "chromium",
  playwright: PLAYWRIGHT_VERSION,
  mcp: PLAYWRIGHT_MCP_BIN,
  browsersPath: PLAYWRIGHT_BROWSERS_PATH,
});

// The runtime builds the harness env from scratch, so image ENV never reaches the agent or its MCP servers. The
// probe runs with the same bare env to prove the browser is found without PLAYWRIGHT_BROWSERS_PATH or NODE_PATH.
const BARE_ENV = `env -i HOME=${SANDBOX_PATHS.home} PATH=/usr/local/bin:/usr/bin:/bin`;
const LAUNCH_ESM =
  "const { chromium } = await import('playwright'); const b = await chromium.launch({ args: ['--no-sandbox'] }); await b.close();";
const LAUNCH_MCP_ENGINE = `require('${MCP_PLAYWRIGHT_CORE}').chromium.launch({ args: ['--no-sandbox'] }).then((b) => b.close()).catch((e) => { console.error(e); process.exit(1); });`;

/**
 * A shell command that launches headless Chromium once and closes it, the way an agent script would: bare env,
 * `import("playwright")` from the output tree. Run it as the agent user; exit 0 means the browser works.
 */
export const BROWSER_LAUNCH_CHECK = `cd ${SANDBOX_PATHS.out} && ${BARE_ENV} node --input-type=module -e "${LAUNCH_ESM}"`;

/** The image's final verify: the harness, the MCP server, and Chromium from both Playwright builds, as the agent. */
export function browserVerifyCommand(harnessBinary: string): string {
  return [
    `${harnessBinary} --version`,
    `${PLAYWRIGHT_MCP_BIN} --version`,
    `cd ${SANDBOX_PATHS.out}`,
    `runuser -u agent -- ${BARE_ENV} node -e "require('playwright')"`,
    `runuser -u agent -- ${BARE_ENV} node --input-type=module -e "${LAUNCH_ESM}"`,
    `runuser -u agent -- ${BARE_ENV} node -e "${LAUNCH_MCP_ENGINE}"`,
  ].join(" && ");
}

/**
 * The install steps, given the image's global npm install prefix. Chromium is installed twice when the MCP server's
 * Playwright build expects a different browser revision than the pinned `playwright`; when they match it is a no-op.
 */
export function browserSteps(npmGlobalInstall: string): ImageStep[] {
  const wrapper = [
    "#!/bin/sh",
    `: "\${PLAYWRIGHT_BROWSERS_PATH:=${PLAYWRIGHT_BROWSERS_PATH}}"`,
    "export PLAYWRIGHT_BROWSERS_PATH",
    `exec node ${MCP_PACKAGE}/cli.js "$@"`,
  ].join("\\n");
  return [
    { kind: "env", vars: { PLAYWRIGHT_BROWSERS_PATH, NODE_PATH: GLOBAL_MODULES } },
    {
      kind: "run",
      commands: [
        "apt-get update",
        "apt-get install -y --no-install-recommends sqlite3",
        `${npmGlobalInstall} playwright@${PLAYWRIGHT_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
        "/usr/local/bin/playwright install --with-deps chromium",
        `node ${MCP_PLAYWRIGHT_CORE}/cli.js install chromium`,
        "rm -rf /var/lib/apt/lists/*",
        `chmod -R a+rX ${PLAYWRIGHT_BROWSERS_PATH}`,
      ],
    },
    {
      kind: "run",
      commands: [
        // The npm bin is a symlink; a wrapper finds the browsers even when the caller's env does not say where.
        `rm -f ${PLAYWRIGHT_MCP_BIN}`,
        `printf '${wrapper}\\n' > ${PLAYWRIGHT_MCP_BIN}`,
        `chmod 0755 ${PLAYWRIGHT_MCP_BIN}`,
        // ESM ignores NODE_PATH: a node_modules above the work and output trees makes bare imports resolve.
        "mkdir -p /selfbuilding/node_modules",
        `ln -sfn ${GLOBAL_MODULES}/playwright /selfbuilding/node_modules/playwright`,
        // Playwright's default browser cache, for scripts that launch Chromium without PLAYWRIGHT_BROWSERS_PATH. A
        // real directory of links, not one link to the read-only browsers tree: the MCP server writes its own
        // entries there, and a link left every first browser call failing with EACCES (found live).
        ...[SANDBOX_PATHS.home, "/home/agent"].flatMap((home) => [
          `mkdir -p ${home}/.cache/ms-playwright`,
          `cp -as ${PLAYWRIGHT_BROWSERS_PATH}/. ${home}/.cache/ms-playwright/`,
          `chown -R -h agent:agent ${home}/.cache`,
        ]),
      ],
    },
  ];
}
