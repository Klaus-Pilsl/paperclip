import type { UIAdapterModule } from "../types";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { buildConfig } from "@paperclipai/adapter-openrouter/ui";
import { label } from "@paperclipai/adapter-openrouter";
import { OpenRouterConfigFields } from "./config-fields";

function parseStdoutLine(line: string, _ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.kind === "string" && typeof parsed.ts === "string") {
      return [parsed as TranscriptEntry];
    }
  } catch {
    // not JSON
  }
  return [{ kind: "system", ts: _ts, text: trimmed }];
}

export const openrouterUIAdapter: UIAdapterModule = {
  type: "openrouter",
  label,
  parseStdoutLine,
  ConfigFields: OpenRouterConfigFields,
  buildAdapterConfig: (values) => {
    const schema = (values.adapterSchemaValues ?? {}) as Record<string, unknown>;
    return buildConfig({
      model: values.model || (schema.model as string) || "openrouter/auto",
      apiKey: (schema.apiKey as string) || undefined,
      systemPrompt: (schema.systemPrompt as string) || undefined,
      temperature: (schema.temperature as string) || undefined,
      maxTokens: (schema.maxTokens as string) || undefined,
      stream: schema.stream as string | boolean | undefined,
      reasoning: schema.reasoning as string | boolean | undefined,
    });
  },
};
