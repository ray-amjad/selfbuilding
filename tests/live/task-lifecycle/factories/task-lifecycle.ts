// Runs lifecycle.mjs (or any workflow script given as `source`) as the run-script factory, with this project's
// harness logins registered by name.
import { createScriptFactory } from "@selfbuilding/script";
import config, { harnesses } from "../selfbuilding.config";

export default createScriptFactory({ harnesses, config });
