// selfbuilding-mcp: the stateless stdio MCP server the harness spawns (spec §2.6, §6.3). It forwards submit_result,
// ask_human and notify_human (plus start_workflow and get_workflow_status with `--start-workflow`) to the supervisor
// over the tool socket and holds no state or credentials. `--standalone` serves only start_workflow on a laptop.
import { SANDBOX_PATHS } from "@selfbuilding/core";
import { standaloneForwarder, startMcpServer } from "./mcp-server.js";
import { Layout } from "./paths.js";

const argv = process.argv.slice(2);
const layout = new Layout();
const cli = process.env.SELFBUILDING_CLI;
const { done } = startMcpServer({
  socketPath: layout.toolSocket,
  resultSchemaPath: layout.host(SANDBOX_PATHS.contract),
  input: process.stdin,
  output: process.stdout,
  startWorkflow: argv.includes("--start-workflow"),
  ...(argv.includes("--standalone") ? { standalone: standaloneForwarder(cli ? { cli: [cli] } : {}) } : {}),
});
void done.then(() => process.exit(0));
