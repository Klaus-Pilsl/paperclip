import type { UIAdapterModule } from "../types";
import { parseStdout } from "@paperclipai/adapter-openrouter/ui";
import { buildConfig } from "@paperclipai/adapter-openrouter/ui";
import { label } from "@paperclipai/adapter-openrouter";
import { OpenRouterConfigFields } from "./config-fields";

export const openrouterUIAdapter: UIAdapterModule = {
  type: "openrouter",
  label,
  parseStdoutLine: (line, _ts) => parseStdout(line),
  ConfigFields: OpenRouterConfigFields,
  buildAdapterConfig: (values) => buildConfig(values as Parameters<typeof buildConfig>[0]),
};
