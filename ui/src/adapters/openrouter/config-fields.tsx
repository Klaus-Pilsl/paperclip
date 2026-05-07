import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function SecretInput({
  value,
  onCommit,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
      >
        {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      </button>
      <DraftInput
        value={value}
        onCommit={onCommit}
        immediate
        type={visible ? "text" : "password"}
        className={inputClass + " pl-8"}
        placeholder={placeholder}
      />
    </div>
  );
}

function schemaVal(values: AdapterConfigFieldsProps["values"], key: string): string {
  const sv = values?.adapterSchemaValues ?? {};
  const v = sv[key];
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

function setSchema(
  values: AdapterConfigFieldsProps["values"],
  set: AdapterConfigFieldsProps["set"],
  key: string,
  value: string,
) {
  set!({ adapterSchemaValues: { ...(values?.adapterSchemaValues ?? {}), [key]: value } });
}

export function OpenRouterConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  const modelValue = isCreate
    ? (values?.model ?? "openrouter/auto")
    : eff("adapterConfig", "model", String(config.model ?? "openrouter/auto"));
  const apiKeyValue = isCreate
    ? schemaVal(values, "apiKey")
    : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""));
  const systemPromptValue = isCreate
    ? schemaVal(values, "systemPrompt")
    : eff("adapterConfig", "systemPrompt", String(config.systemPrompt ?? ""));
  const temperatureValue = isCreate
    ? schemaVal(values, "temperature")
    : eff("adapterConfig", "temperature", String(config.temperature ?? ""));
  const maxTokensValue = isCreate
    ? schemaVal(values, "maxTokens")
    : eff("adapterConfig", "maxTokens", String(config.maxTokens ?? ""));
  const streamValue = isCreate
    ? (schemaVal(values, "stream") || "true")
    : eff("adapterConfig", "stream", String(config.stream ?? "true"));
  const reasoningValue = isCreate
    ? (schemaVal(values, "reasoning") || "false")
    : eff("adapterConfig", "reasoning", String(config.reasoning ?? "false"));

  return (
    <>
      <Field label="OpenRouter API Key" hint="Get your key at openrouter.ai/keys">
        <SecretInput
          value={apiKeyValue}
          onCommit={(v) =>
            isCreate
              ? setSchema(values, set, "apiKey", v)
              : mark("adapterConfig", "apiKey", v || undefined)
          }
          placeholder="sk-or-v1-..."
        />
      </Field>

      <Field label="Model" hint='Select a model or use "openrouter/auto" for auto-routing'>
        <select
          value={modelValue}
          onChange={(e) =>
            isCreate
              ? set!({ model: e.target.value })
              : mark("adapterConfig", "model", e.target.value || undefined)
          }
          className={inputClass}
        >
          <option value="openrouter/auto">Auto (best free route)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="System Prompt">
        <textarea
          value={systemPromptValue}
          onChange={(e) =>
            isCreate
              ? setSchema(values, set, "systemPrompt", e.target.value)
              : mark("adapterConfig", "systemPrompt", e.target.value || undefined)
          }
          rows={3}
          className={inputClass + " resize-y"}
          placeholder="You are a helpful assistant..."
        />
      </Field>

      <Field label="Temperature" hint="0–2, default 0.7">
        <DraftInput
          value={temperatureValue}
          onCommit={(v) =>
            isCreate
              ? setSchema(values, set, "temperature", v)
              : mark("adapterConfig", "temperature", v ? parseFloat(v) : undefined)
          }
          className={inputClass}
          placeholder="0.7"
        />
      </Field>

      <Field label="Max Tokens" hint="Default 4096">
        <DraftInput
          value={maxTokensValue}
          onCommit={(v) =>
            isCreate
              ? setSchema(values, set, "maxTokens", v)
              : mark("adapterConfig", "maxTokens", v ? parseInt(v, 10) : undefined)
          }
          className={inputClass}
          placeholder="4096"
        />
      </Field>

      <Field label="Enable Streaming">
        <select
          value={streamValue}
          onChange={(e) =>
            isCreate
              ? setSchema(values, set, "stream", e.target.value)
              : mark("adapterConfig", "stream", e.target.value === "true")
          }
          className={inputClass}
        >
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </Field>

      <Field label="Enable Reasoning" hint="Only for models that support extended thinking">
        <select
          value={reasoningValue}
          onChange={(e) =>
            isCreate
              ? setSchema(values, set, "reasoning", e.target.value)
              : mark("adapterConfig", "reasoning", e.target.value === "true")
          }
          className={inputClass}
        >
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      </Field>
    </>
  );
}
