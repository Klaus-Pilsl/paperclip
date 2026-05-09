// ─────────────────────────────────────────────────────────────────
// @paperclipai/adapter-openrouter — Root Metadata (src/index.ts)
// Shared across server · ui · cli — keep dependency-free
// ─────────────────────────────────────────────────────────────────

export const type = "openrouter" as const;
export const label = "OpenRouter";

// Static fallback shown only when the live /models call fails (no API key,
// no network). The real list comes from listOpenRouterModels() at runtime —
// hardcoded slugs rot fast and were the source of "model not found" errors.
export const models = [
  { id: "openrouter/auto", label: "Auto (best free route)" },
];

// ── OpenRouter API constants ────────────────────────────────────
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_ENDPOINT = `${OPENROUTER_BASE_URL}/models`;
export const OPENROUTER_CHAT_ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;
export const OPENROUTER_GENERATION_ENDPOINT = `${OPENROUTER_BASE_URL}/generation`;

// ── Adapter documentation ───────────────────────────────────────
export const agentConfigurationDoc = `# openrouter adapter configuration

## Use when
- You want access to 300+ models (free AND paid) from a single API key
- You want to use OpenRouter's auto-routing for cost-optimized inference
- You need models not available via native adapters (Llama, Qwen, Mistral, DeepSeek, etc.)
- You want to compare outputs across multiple providers without separate API keys

## Core fields
- \`model\` (string) — OpenRouter model ID, e.g. "anthropic/claude-sonnet-4-6"
  Use "openrouter/auto" to let OpenRouter pick the best model automatically.
  Append ":free" to any model ID for free-tier routing.
- \`apiKey\` (string) — Your OpenRouter API key (sk-or-v1-...)
  Can also be set via OPENROUTER_API_KEY env var.
- \`systemPrompt\` (string, optional) — System prompt prepended to all messages.
- \`temperature\` (number, optional) — Sampling temperature (0-2). Default: 0.7
- \`maxTokens\` (number, optional) — Max completion tokens. Default: 4096
- \`topP\` (number, optional) — Nucleus sampling. Default: 1
- \`stream\` (boolean, optional) — Enable SSE streaming. Default: true
- \`reasoning\` (boolean, optional) — Enable extended thinking for supported models.
- \`transforms\` (string[], optional) — OpenRouter transforms, e.g. ["middle-out"]
- \`route\` (string, optional) — "fallback" (default) or "no-fallback"
- \`httpReferer\` (string, optional) — Your app URL for OpenRouter leaderboards
- \`xTitle\` (string, optional) — Your app name for OpenRouter leaderboards

## Don't use when
- You already have a direct API key for a single provider and only need that one model
- You need local/offline inference (use ollama or process adapter instead)
`;

// ── Types ───────────────────────────────────────────────────────
export interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  context_length: number;
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: Record<string, string> | null;
  architecture?: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
  };
}

export interface OpenRouterConfig {
  model: string;
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  reasoning?: boolean;
  transforms?: string[];
  route?: "fallback" | "no-fallback";
  httpReferer?: string;
  xTitle?: string;
  /** Max tool-loop turns per run. Default 25. */
  maxTurns?: number;
  /** Skip approval gates for hire_agent and similar mutating tools. Default false. */
  autoApprove?: boolean;
  /** Override path to skills directory. Defaults to ~/.openrouter-adapter/skills. */
  skillsDir?: string;
  /** Absolute path to a markdown file that will be read at runtime and
   * prepended to the system prompt. Takes precedence over systemPrompt
   * if both are set. */
  instructionsFilePath?: string;
}
