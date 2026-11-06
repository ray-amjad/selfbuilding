// `@selfbuilding/sandbox-e2b/adapter`: the shared E2B-shape adapter without the `e2b` SDK, so a binding for another
// vendor (Impello) never loads the stock client.

export { createE2bShapeProvider, type E2bShapeBindingOptions } from "./binding.js";
export { type TemplateBuildApi, type TemplateImageBuilderOptions, templateImageBuilder } from "./build.js";
export type {
  E2bCommandHandle,
  E2bCommandOpts,
  E2bCommandResult,
  E2bConnection,
  E2bCreateOpts,
  E2bFileOpts,
  E2bListOpts,
  E2bOnTimeout,
  E2bPaginator,
  E2bSandbox,
  E2bSandboxInfo,
  E2bShapeClient,
  E2bVendorState,
} from "./client.js";
export { DEFAULT_TIMINGS, E2bShapeBox, E2bShapeProvider, type E2bShapeTimings, ENV_FILE } from "./provider.js";
export {
  E2B_SIZE_LIMITS,
  guardTemplateSizes,
  IMPELLO_SIZE_LIMITS,
  overLimit,
  type TemplateSizing,
  templateNameFor,
  templateRefusal,
  templateSizing,
} from "./sizes.js";
export {
  type E2bTemplateDefinition,
  e2bTemplate,
  SELFBUILDING_TEMPLATE_NAMES,
  type SelfbuildingTemplateName,
  STOCK_TEMPLATES,
} from "./templates.js";
