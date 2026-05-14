/**
 * OpenRouter adapter execute() — multi-turn tool loop.
 *
 * Responsibilities:
 *   - Build messages from Paperclip wake context + skills
 *   - Run a tool-calling loop against OpenRouter's chat/completions endpoint
 *   - Manage issue state (in_progress at start, done/blocked at end)
 *   - Post the final assistant output as an issue comment
 *   - Emit typed TranscriptEntry lines so the run viewer renders properly
 *   - Track usage and cost via OpenRouter's /generation endpoint
 *
 * Out of scope for v1 (deferred to v3):
 *   - Token streaming inside the tool loop (non-streaming is more reliable
 *     for tool calls on free models)
 *   - Approval gate handling (we route hire_agent through approvals, but we
 *     don't yet pause-and-resume runs on async approval callbacks)
 *   - Workspace runtime env vars (we have no child process to pass them to)
 *   - Attachment / multimodal handling
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import {
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

import {
  OPENROUTER_CHAT_ENDPOINT,
  type OpenRouterConfig,
} from "../index.js";
import { PaperclipApi, PaperclipApiError } from "./paperclip-api.js";
import { buildTools, toolSchemas, findTool, type Tool } from "./tools.js";
import { loadSkills, renderSkillsForPrompt } from "./skills.js";
import * as rateLimitRegistry from "./rate-limit-registry.js";
import {
  emitInit,
  emitAssistant,
  emitThinking,
  emitToolCall,
  emitToolResult,
  emitResult,
  emitSystem,
  writeRawStderr,
  type OnLog,
} from "./transcript.js";

// ----- types matching OpenRouter / OpenAI chat completions -----

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

// ----- helpers -----

const DEFAULT_MAX_TURNS = 25;
const RATE_LIMIT_FALLBACK_SECONDS = 60;

/**
 * Typed signal that the OpenRouter API rate-limited a request. Carries the
 * reset timestamp so the adapter can short-circuit subsequent runs via the
 * rate-limit registry and surface a transient-upstream retry hint to the
 * heartbeat scheduler.
 */
class RateLimitedError extends Error {
  readonly resetAtMs: number;
  readonly reason: string;
  constructor(resetAtMs: number, reason: string) {
    super(`Rate-limited until ${new Date(resetAtMs).toISOString()}: ${reason}`);
    this.name = "RateLimitedError";
    this.resetAtMs = resetAtMs;
    this.reason = reason;
  }
}

/**
 * Parse a Retry-After value into an absolute reset timestamp (ms).
 * Accepts either a non-negative numeric seconds delta or an HTTP-date.
 * Returns null when the value can't be parsed.
 */
function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Numeric seconds delta (most common).
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
  }
  // HTTP-date.
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs) && dateMs > 0) return dateMs;
  return null;
}

/**
 * Parse an X-RateLimit-Reset value into an absolute reset timestamp (ms).
 * The header is commonly Unix seconds; some providers send Unix ms. We
 * pick the interpretation by magnitude: values smaller than 1e11 are
 * treated as seconds (anything < ~5138 CE).
 */
function parseRateLimitReset(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

/**
 * Pick the best reset timestamp from response headers + a fallback delta.
 * Prefers Retry-After (RFC-standard for 429); falls back to X-RateLimit-
 * Reset; finally to a conservative N-second delta from now. The fallback
 * is deliberately short — if it's wrong (real limit is hours), we'll get
 * another 429 right away and the registry auto-corrects with the new
 * headers, which is cheaper than guessing from the error message body.
 */
function resolveRateLimitResetAt(headers: Headers, nowMs: number): number {
  return (
    parseRetryAfter(headers.get("retry-after"), nowMs) ??
    parseRateLimitReset(headers.get("x-ratelimit-reset")) ??
    nowMs + RATE_LIMIT_FALLBACK_SECONDS * 1000
  );
}

const DEFAULT_SYSTEM_PROMPT = `You are an AI agent working inside Paperclip, an autonomous multi-agent company orchestration system. You receive a wake payload describing an issue (task) you have been assigned. Your job is to EXECUTE the task — not narrate it.

# Execution contract

Every run follows this shape:

1. **Understand** — call get_issue (and list_comments if the thread matters) to load the full task context. Read the description, latest comments, and any continuation summary.
2. **Plan internally** — decide what concrete deliverable or action the task requires. Do not announce the plan; just execute it.
3. **Produce real artefacts** — for anything the team will want to read or reuse later (a research report, a design doc, a written plan, a code excerpt, a summary memo) call \`upsert_document\` with a stable slug \`key\` and the full markdown \`body\`. Calling it again with the same key updates the document. **This is the primary way you produce work.** Comments are not deliverables.
4. **Communicate** — use \`add_comment\` for short status updates, questions back to the team, or to flag a result. Comments are ephemeral and don't replace documents.
5. **Delegate or escalate when needed** — \`create_sub_issue\` to break work into smaller pieces; \`hire_agent\` if a missing role is blocking you; \`request_approval\` for actions that need a human sign-off.
6. **Close the loop** — when the task is genuinely complete, call \`update_issue_status\` with \`status='done'\` (or \`'blocked'\` with a reason if you cannot proceed). After that, **always end your turn with a short assistant message summarising what you produced and any open questions** — this message is what the team will see at the top of the thread, so make it useful even if the documents carry the detail.

# Hard rules

- Tools are your **only** way to affect the world. Talking to yourself in the response text changes nothing; calling a tool does.
- One issue per run: focus on the current task (the wake payload's issue), don't free-roam.
- Don't call the same tool with identical arguments repeatedly — if a tool errors, read the error and adjust. After 3 identical calls the run is killed automatically.
- Don't fabricate ids. Use list_agents / list_issues to discover real ones before referencing them.
- Markdown matters: write documents and comments as proper, well-structured markdown.
`;

function resolveApiKey(config: OpenRouterConfig): string {
  const key = config.apiKey || process.env.OPENROUTER_API_KEY || "";
  if (!key) {
    throw new Error(
      "OpenRouter API key not found. Set adapterConfig.apiKey or OPENROUTER_API_KEY env var.",
    );
  }
  return key;
}

function resolveBillingType(config: OpenRouterConfig): "api" | "subscription" {
  // OpenRouter is always API-key based.
  if (config.apiKey || process.env.OPENROUTER_API_KEY) return "api";
  return "api";
}

function buildHeaders(apiKey: string, config: OpenRouterConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": config.httpReferer || "https://paperclip.ing",
    "X-Title": config.xTitle || "Paperclip",
  };
}

function extractCurrentIssueId(context: Record<string, unknown>): string | null {
  const candidates = [
    context.taskId,
    context.issueId,
    context.wakeTaskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.taskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.issueId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function callOpenRouter(
  apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = {
    model: config.model || "openrouter/auto",
    messages,
    max_tokens: config.maxTokens ?? 4096,
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 1,
    stream: false,
    // Ask OpenRouter to include per-generation cost in the response so we can
    // sum it accurately across multi-turn runs without a separate /generation lookup.
    usage: { include: true },
  };
  if (tools.length > 0) {
    body.tools = toolSchemas(tools);
    body.tool_choice = "auto";
  }
  if (config.reasoning) body.reasoning = { effort: "high" };
  if (config.transforms?.length) body.transforms = config.transforms;
  if (config.route) body.route = config.route;

  const response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
    method: "POST",
    headers: buildHeaders(apiKey, config),
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const errText = await response.text().catch(() => "");
    const resetAtMs = resolveRateLimitResetAt(response.headers, Date.now());
    const detail = errText ? errText.slice(0, 160) : "no body";
    const reason = `HTTP 429 on ${config.model || "openrouter/auto"} — ${detail}`;
    rateLimitRegistry.mark(apiKey, config.model || "openrouter/auto", resetAtMs, reason);
    throw new RateLimitedError(resetAtMs, reason);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenRouter API error (${response.status}): ${errText}`);
  }

  const json = (await response.json()) as ChatCompletionResponse & { error?: { message?: string; code?: unknown } };
  // OpenRouter sometimes returns HTTP 200 with an error object instead of choices.
  if (json.error) {
    // 429 can also surface as a 200 envelope with an error.code === 429 body —
    // treat it identically so the retry-not-before contract still kicks in.
    if (json.error.code === 429 || json.error.code === "429") {
      const resetAtMs = resolveRateLimitResetAt(response.headers, Date.now());
      const msg = typeof json.error.message === "string" ? json.error.message : JSON.stringify(json.error);
      const reason = `Body code 429 on ${config.model || "openrouter/auto"} — ${msg.slice(0, 160)}`;
      rateLimitRegistry.mark(apiKey, config.model || "openrouter/auto", resetAtMs, reason);
      throw new RateLimitedError(resetAtMs, reason);
    }
    const msg = typeof json.error.message === "string" ? json.error.message : JSON.stringify(json.error);
    throw new Error(`OpenRouter error: ${msg}`);
  }
  return json;
}

// ----- main -----

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = (ctx.agent.adapterConfig ?? ctx.config) as unknown as OpenRouterConfig & {
    maxTurns?: number;
    autoApprove?: boolean;
  };
  const { context, onLog, agent, authToken } = ctx;

  const model = config.model || "openrouter/auto";
  const maxTurns = typeof config.maxTurns === "number" && config.maxTurns > 0 ? config.maxTurns : DEFAULT_MAX_TURNS;
  const autoApprove = config.autoApprove === true;

  // Tool handlers need a Paperclip API client. If we have no authToken,
  // tools are disabled (model can still respond, just can't act).
  let api: PaperclipApi | null = null;
  let tools: Tool[] = [];
  const currentIssueId = extractCurrentIssueId(context);
  const companyId = agent.companyId;

  if (authToken) {
    api = new PaperclipApi({ authToken });
    tools = buildTools({
      api,
      agentId: agent.id,
      companyId,
      currentIssueId,
      autoApprove,
    });
  } else {
    await writeRawStderr(
      onLog,
      "[openrouter] No authToken on context — tool calls disabled. Agent can only generate text.",
    );
  }

  // Emit init early so the run viewer renders the header.
  await emitInit(onLog, { model, sessionId: ctx.runId });

  // ----- build messages -----

  const messages: ChatMessage[] = [];

  // System prompt = base + skills + optional instructions file
  let systemContent = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // If instructionsFilePath is set, read the file and use it as the base.
  // This mirrors the behavior of claude-local / codex-local / etc., letting
  // operators version-control long agent instructions in a markdown file
  // instead of pasting them into the inline systemPrompt field.
  const instructionsFilePath = (config as unknown as Record<string, unknown>).instructionsFilePath;
  if (typeof instructionsFilePath === "string" && instructionsFilePath.trim().length > 0) {
    try {
      const fileContent = await fs.readFile(instructionsFilePath.trim(), "utf8");
      if (fileContent.trim().length > 0) {
        systemContent = fileContent.trim();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] could not read instructionsFilePath ${instructionsFilePath}: ${reason}. Falling back to systemPrompt.`,
      );
    }
  }
  try {
    const skills = await loadSkills({ agentConfig: config as unknown as Record<string, unknown>, onLog });
    if (skills.length > 0) {
      systemContent = `${systemContent}\n\n${renderSkillsForPrompt(skills)}`;
      await emitSystem(onLog, `Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] skill loading error (continuing): ${reason}`);
  }
  messages.push({ role: "system", content: systemContent });

  // User prompt = Paperclip wake payload rendered as text
  const resumedSession = !!ctx.runtime.sessionId;
  let wakePrompt = "";
  try {
    wakePrompt = renderPaperclipWakePrompt(context, { resumedSession }) || "";
  } catch {
    wakePrompt = "";
  }
  messages.push({
    role: "user",
    content: wakePrompt || JSON.stringify(context),
  });

  // ----- check out issue (acquire run lock) -----
  //
  // Paperclip's sameRunLock check rejects any write to an issue (comments,
  // status changes, etc.) unless the issue's checkoutRunId matches the
  // calling run id. The CLI adapters get this for free because Paperclip's
  // wake handler pre-checks-out the issue for them; pure-HTTP adapters
  // don't, so we have to do it ourselves before any tool can mutate state.
  //
  // If checkout fails (issue locked by another live run, project paused,
  // etc.), we log and proceed without tools — same graceful degradation
  // we apply when authToken is missing.

  // If Paperclip's heartbeat dispatcher already stamped this run as the
  // issue's executionRunId, the lock is effectively held by us already and
  // an explicit checkout call would be redundant (and on some Paperclip
  // versions, return a validation error). Detect that and skip.
  const preLocked = (() => {
    const wakeIssue = (context.paperclipWake as Record<string, unknown> | undefined)?.issue as
      | Record<string, unknown>
      | undefined;
    const ctxIssue = (context.issue as Record<string, unknown> | undefined) ?? wakeIssue;
    const execRunId =
      typeof ctxIssue?.executionRunId === "string" ? ctxIssue.executionRunId : null;
    return !!execRunId && execRunId === ctx.runId;
  })();

  let issueLocked = preLocked;
  if (api && currentIssueId && !preLocked) {
    try {
      await api.checkoutIssue(currentIssueId, agent.id);
      issueLocked = true;
    } catch (err) {
      // Best-effort: many runs are dispatched by the heartbeat which already
      // holds the lock for us, so a checkout failure is not necessarily
      // fatal. We try the writes anyway and let Paperclip enforce the real
      // ownership check at write time.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] checkout call failed for ${currentIssueId}: ${reason}. Continuing — Paperclip may still accept writes if the heartbeat pre-locked the issue.`,
      );
      issueLocked = true;
    }
  }

  // ----- mark issue in_progress -----

  if (api && currentIssueId && issueLocked) {
    try {
      await api.updateIssue(currentIssueId, { status: "in_progress" });
    } catch (err) {
      // Don't fail the run for status updates.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not set issue in_progress: ${reason}`);
    }
  }

  // ----- tool loop -----

  let apiKey: string;
  try {
    apiKey = resolveApiKey(config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] ${reason}\n`);
    if (api && currentIssueId) {
      await api
        .updateIssue(currentIssueId, { status: "blocked", statusReason: reason })
        .catch(() => undefined);
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: reason,
      errorCode: "missing_api_key",
      usage: { inputTokens: 0, outputTokens: 0 },
      model,
      provider: "openrouter",
      biller: "openrouter",
      billingType: resolveBillingType(config),
    };
  }

  // ----- pre-flight: if this (key, model) pair is currently rate-limited
  // per the in-process registry, short-circuit before even calling OpenRouter.
  // Returning errorFamily: "transient_upstream" + retryNotBefore lets the
  // heartbeat scheduler reschedule the run for the reset time without ever
  // touching the network. See server/src/services/heartbeat.ts (search for
  // transientRecovery / retryNotBefore) for the consumer side.
  {
    const cached = rateLimitRegistry.peek(apiKey, model);
    if (cached) {
      const retryNotBefore = new Date(cached.resetAtMs).toISOString();
      await emitSystem(
        onLog,
        `Skipping OpenRouter call: model is rate-limited until ${retryNotBefore} (${cached.reason})`,
      );
      if (api && currentIssueId) {
        const body =
          `_Run skipped — model **${model}** is rate-limited._\n\n` +
          `Reset at: \`${retryNotBefore}\`\n\n` +
          `Reason: ${cached.reason}\n\n` +
          `_Paperclip will retry this run automatically after the reset time._`;
        await api.addIssueComment(currentIssueId, { body }).catch(async (err) => {
          const reason = err instanceof Error ? err.message : String(err);
          await writeRawStderr(onLog, `[openrouter] could not post rate-limit pre-flight comment: ${reason}`);
        });
      }
      await emitResult(onLog, {
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        subtype: "rate_limited",
        isError: false,
        errors: [cached.reason],
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorFamily: "transient_upstream",
        errorCode: "openrouter_rate_limited_cached",
        errorMessage: `Model ${model} is rate-limited until ${retryNotBefore}: ${cached.reason}`,
        retryNotBefore,
        errorMeta: {
          rateLimitedModel: model,
          resetAtMs: cached.resetAtMs,
          source: "registry-cache",
        },
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
        provider: "openrouter",
        biller: "openrouter",
        billingType: resolveBillingType(config),
      };
    }
  }

  let lastGenerationId: string | undefined;
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  // Track per-turn cost reported inline by OpenRouter (usage.cost). Stays null
  // until at least one turn reports a number; that lets us distinguish "the run
  // was free" (some turn reported 0) from "OpenRouter never told us" (null).
  let totalCostUsd: number | null = null;
  let finalAssistantText = "";
  let turn = 0;
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" | "rate_limited" = "completed";
  let runError: { message: string; code: string } | null = null;
  let rateLimitedAtMs: number | null = null;
  // Repeat-call detection: if the model calls the same tool with the same args
  // three times in a row, break the loop. Prevents 20+ retries when the model
  // misreads an error message and keeps "fixing" it the same wrong way.
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;

  try {
    while (turn < maxTurns) {
      turn += 1;

      let response: ChatCompletionResponse;
      try {
        response = await callOpenRouter(apiKey, config, messages, tools);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          rateLimitedAtMs = err.resetAtMs;
          runError = { message: err.reason, code: "openrouter_rate_limited" };
          stoppedReason = "rate_limited";
          await emitSystem(
            onLog,
            `OpenRouter returned 429; pausing this model until ${new Date(err.resetAtMs).toISOString()}.`,
          );
          break;
        }
        const reason = err instanceof Error ? err.message : String(err);
        runError = { message: reason, code: "openrouter_request_failed" };
        stoppedReason = "error";
        break;
      }

      lastGenerationId = response.id || lastGenerationId;
      if (response.usage) {
        totalUsage = {
          inputTokens: totalUsage.inputTokens + (response.usage.prompt_tokens ?? 0),
          outputTokens: totalUsage.outputTokens + (response.usage.completion_tokens ?? 0),
        };
        if (typeof response.usage.cost === "number" && Number.isFinite(response.usage.cost)) {
          totalCostUsd = (totalCostUsd ?? 0) + response.usage.cost;
        }
      }

      const choice = response.choices?.[0];
      if (!choice) {
        const detail = JSON.stringify(response).slice(0, 400);
        runError = { message: `OpenRouter returned no choices. Raw response: ${detail}`, code: "openrouter_empty_response" };
        stoppedReason = "error";
        break;
      }

      const msg = choice.message;
      const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
      const text = typeof msg.content === "string" ? msg.content : "";
      const toolCalls = msg.tool_calls ?? [];

      if (reasoning) {
        await emitThinking(onLog, reasoning);
      }
      if (text) {
        await emitAssistant(onLog, text);
        finalAssistantText = text;
      }

      // No tool calls => model is done.
      if (toolCalls.length === 0) {
        stoppedReason = "completed";
        break;
      }

      // Add the assistant message (with tool_calls) so the model sees its own request.
      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });

      // Execute each tool call and append the results.
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const args = safeParseToolArgs(tc.function.arguments);
        await emitToolCall(onLog, { name: toolName, input: args, toolUseId: tc.id });

        const tool = findTool(tools, toolName);
        let resultContent: string;
        let isError: boolean;
        if (!tool) {
          resultContent = JSON.stringify({ error: `Unknown tool: ${toolName}` });
          isError = true;
        } else {
          try {
            const out = await tool.execute(args);
            resultContent = out.content;
            isError = out.isError;
          } catch (err) {
            resultContent = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
            isError = true;
          }
        }

        await emitToolResult(onLog, {
          toolUseId: tc.id,
          toolName,
          content: resultContent,
          isError,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultContent,
        });

        // Track repeat calls
        const callSig = `${toolName}::${JSON.stringify(args)}`;
        recentCalls.push(callSig);
        if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
        if (
          recentCalls.length === REPEAT_THRESHOLD &&
          recentCalls.every((s) => s === callSig)
        ) {
          await writeRawStderr(
            onLog,
            `[openrouter] Tool "${toolName}" called ${REPEAT_THRESHOLD}x with identical args — breaking loop.`,
          );
          runError = {
            message: `Tool "${toolName}" was called ${REPEAT_THRESHOLD} times in a row with identical arguments. The model is stuck in a retry loop.`,
            code: "tool_repeat_loop",
          };
          stoppedReason = "repeat_loop";
          break;
        }
      }
      if (stoppedReason === "repeat_loop") break;
    }

    if (turn >= maxTurns && stoppedReason !== "error" && stoppedReason !== "rate_limited") {
      stoppedReason = "max_turns";
      await writeRawStderr(onLog, `[openrouter] hit max_turns (${maxTurns}), stopping`);
    }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      rateLimitedAtMs = err.resetAtMs;
      runError = { message: err.reason, code: "openrouter_rate_limited" };
      stoppedReason = "rate_limited";
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      runError = { message: reason, code: "openrouter_loop_failed" };
      stoppedReason = "error";
    }
  }

  // ----- post-loop: cost, comment, status -----

  // costUsd is the sum of per-turn `usage.cost` values reported inline by
  // OpenRouter (we set `usage: { include: true }` on every request). It stays
  // null only when no turn reported a cost — which lets the run summary surface
  // "unknown" instead of a misleading $0.
  const costUsd: number | null = totalCostUsd;
  if (costUsd === null && lastGenerationId) {
    await writeRawStderr(
      onLog,
      `[openrouter] cost not reported by any turn (last generation: ${lastGenerationId}); leaving costUsd as null`,
    );
  }

  // Post the final assistant text as a comment so the team sees something
  // when they open the issue. If the model ended on a tool_call instead of
  // a text message (common for weaker models), synthesize a fallback summary
  // from the last few tool actions — better than silent completion.
  let commentBody = finalAssistantText.trim();
  // Rate-limited runs get their own auto-resume message instead of the
  // "model forgot to summarize" fallback — different cause, different fix.
  if (stoppedReason === "rate_limited" && rateLimitedAtMs) {
    commentBody =
      `_Run paused — OpenRouter rate-limited model **${model}**._\n\n` +
      `Resumes at: \`${new Date(rateLimitedAtMs).toISOString()}\`\n\n` +
      (runError ? `Reason: ${runError.message}\n\n` : "") +
      `_Paperclip will automatically retry this run after the reset time. No action needed._`;
  } else if (!commentBody && api && currentIssueId) {
    const lastToolNames: string[] = [];
    for (let i = messages.length - 1; i >= 0 && lastToolNames.length < 3; i -= 1) {
      const m = messages[i];
      if (m.role === "assistant" && m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          if (lastToolNames.length < 3) lastToolNames.unshift(tc.function.name);
        }
      }
    }
    const reasonLabel = stoppedReason === "completed"
      ? "completed"
      : stoppedReason === "max_turns"
        ? `stopped after hitting max_turns (${maxTurns})`
        : stoppedReason === "repeat_loop"
          ? "stopped — repeat tool-call loop detected"
          : "errored";
    const actionsLine = lastToolNames.length > 0
      ? `Last actions: ${lastToolNames.join(" → ")}.`
      : "No tool actions were taken.";
    commentBody =
      `_Run ${reasonLabel} without a final summary message from the model._\n\n` +
      `${actionsLine}\n\n` +
      `_(This is a fallback comment — the model should have written a summary but did not. ` +
      `Common with weaker free-tier models that prefer ending on a tool call.)_`;
  }
  if (api && currentIssueId && commentBody.length > 0) {
    try {
      await api.addIssueComment(currentIssueId, { body: commentBody });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not post final comment: ${reason}`);
    }
  }

  // Update issue status based on outcome. Skip for rate_limited — Paperclip's
  // bounded transient-retry will pick the run up again at retryNotBefore, and
  // we don't want to flip the issue to blocked just to flip it back later.
  if (api && currentIssueId && stoppedReason !== "rate_limited") {
    let nextStatus: string | null = null;
    let statusReason: string | null = null;
    if (stoppedReason === "completed") {
      nextStatus = "done";
    } else if (stoppedReason === "max_turns") {
      nextStatus = "blocked";
      statusReason = `Hit max_turns (${maxTurns}) without completing`;
    } else if (stoppedReason === "repeat_loop" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    } else if (stoppedReason === "error" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    }
    if (nextStatus) {
      try {
        await api.updateIssue(currentIssueId, { status: nextStatus, statusReason });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeRawStderr(onLog, `[openrouter] could not update final status: ${reason}`);
      }
    }
  }

  // Emit the final result transcript entry.
  await emitResult(onLog, {
    text: finalAssistantText,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    costUsd: costUsd ?? 0,
    subtype: stoppedReason,
    isError: stoppedReason === "error",
    errors: runError ? [runError.message] : [],
  });

  if (stoppedReason === "rate_limited" && rateLimitedAtMs && runError) {
    // Signal Paperclip's heartbeat to reschedule rather than mark the run as
    // a hard failure. retryNotBefore is the consumed contract (see
    // server/src/services/heartbeat.ts: transientRecovery / readTransient
    // RetryNotBeforeFromRun). errorFamily: "transient_upstream" classifies
    // this for the bounded-retry path.
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorFamily: "transient_upstream",
      errorMessage: runError.message,
      errorCode: runError.code,
      retryNotBefore: new Date(rateLimitedAtMs).toISOString(),
      errorMeta: {
        rateLimitedModel: model,
        resetAtMs: rateLimitedAtMs,
        source: "live-429",
      },
      usage: totalUsage,
      model,
      provider: "openrouter",
      biller: "openrouter",
      billingType: resolveBillingType(config),
      costUsd,
      sessionId: lastGenerationId ?? null,
      sessionDisplayId: lastGenerationId ?? null,
      sessionParams: lastGenerationId ? { lastGenerationId } : null,
    };
  }

  if (stoppedReason === "error" && runError) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: runError.message,
      errorCode: runError.code,
      usage: totalUsage,
      model,
      provider: "openrouter",
      biller: "openrouter",
      billingType: resolveBillingType(config),
      costUsd,
      sessionId: lastGenerationId ?? null,
      sessionDisplayId: lastGenerationId ?? null,
      sessionParams: lastGenerationId ? { lastGenerationId } : null,
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: totalUsage,
    model,
    provider: "openrouter",
    biller: "openrouter",
    billingType: resolveBillingType(config),
    costUsd,
    sessionId: lastGenerationId ?? null,
    sessionDisplayId: lastGenerationId ?? null,
    sessionParams: lastGenerationId ? { lastGenerationId } : null,
    summary: finalAssistantText.slice(0, 500),
  };
}
