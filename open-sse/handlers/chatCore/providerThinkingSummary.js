/**
 * Provider-side thinking summary for request details.
 *
 * The dashboard shows what 9Router actually sent upstream — the translated body
 * handed to the executor — not what the client asked for. That body is redacted
 * from the details API (it carries user conversation content), so the summary
 * has to be derived here, at write time, and stored as a plain string.
 *
 * Two carriers exist:
 *   - a thinking field in the outbound JSON body (OpenAI `reasoning_effort`,
 *     Claude `thinking`/`output_config.effort`, Gemini `thinkingConfig`,
 *     Qwen `enable_thinking`, DeepSeek `thinking`), read via extractThinking()
 *   - Kiro, which carries it in `additionalModelRequestFields` and/or a
 *     `<thinking_mode>` system prefix inside the request content
 */

import { extractThinking } from "../../translator/concerns/thinkingUnified.js";

const KIRO_THINKING_PREFIX_RE = /<thinking_mode>(enabled|interleaved)<\/thinking_mode>/i;
const KIRO_MAX_THINKING_RE = /<max_thinking_length>(\d+)<\/max_thinking_length>/i;

// File-format image parts from the details repo hold at most this much JSON.
const MAX_SCAN_CHARS = 20000;

/**
 * Walk every string in a (possibly deep) value looking for Kiro's thinking tag.
 * Depth- and size-bounded so a pathological body can't stall the request path.
 */
function findKiroPrefixText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length > MAX_SCAN_CHARS) value = value.slice(0, MAX_SCAN_CHARS);
    return value.includes("<thinking_mode>") ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findKiroPrefixText(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const hit = findKiroPrefixText(item, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function summaryFromEffort(effort) {
  if (typeof effort !== "string" || !effort) return null;
  const level = effort.toLowerCase();
  if (level === "none" || level === "off" || level === "disabled") return { mode: "none" };
  if (level === "auto") return { mode: "auto" };
  return { mode: "level", level };
}

// Kiro keeps its effort outside the regular thinking fields.
function extractKiroThinking(providerRequest) {
  const fields = providerRequest?.additionalModelRequestFields;
  if (fields && typeof fields === "object") {
    const effort = summaryFromEffort(fields.output_config?.effort ?? fields.reasoning?.effort);
    if (effort) return effort;
  }

  // The `<thinking_mode>` prefix lives inside the conversation content, so
  // finding it means walking every string in the body. Only Kiro-shaped bodies
  // (chatTriggerType + currentMessage are its GenerateAssistantResponse
  // envelope) are worth that scan — it must not run on every request.
  if (!providerRequest?.conversationState?.currentMessage) return null;

  const text = findKiroPrefixText(providerRequest);
  if (!text || !KIRO_THINKING_PREFIX_RE.test(text)) return null;
  const budget = Number(KIRO_MAX_THINKING_RE.exec(text)?.[1]);
  return Number.isFinite(budget) && budget > 0
    ? { mode: "budget", budget }
    : { mode: "auto" };
}

/**
 * Derive a normalized thinking intent from the body 9Router sent upstream.
 * @param {object|string|null} providerRequest - executor's transformedBody
 * @returns {{mode: "none"|"auto"|"level"|"budget", level?: string, budget?: number}|null}
 */
export function summarizeProviderThinking(providerRequest) {
  if (!providerRequest || typeof providerRequest !== "object") return null;

  const kiro = extractKiroThinking(providerRequest);
  if (kiro) return kiro;

  try {
    return extractThinking(providerRequest);
  } catch {
    return null;
  }
}

/**
 * Render an intent as the short label shown in the dashboard:
 * "off" | "auto" | "high" | "8k" — the same vocabulary the request log uses.
 */
export function formatThinkingSummary(summary) {
  if (!summary || !summary.mode) return null;
  if (summary.mode === "none") return "off";
  if (summary.mode === "auto") return "auto";
  if (summary.mode === "level") return summary.level || null;
  if (summary.mode === "budget") {
    const budget = Number(summary.budget);
    if (!Number.isFinite(budget) || budget <= 0) return "auto";
    return budget >= 1000 ? `${Math.round(budget / 1000)}k` : String(budget);
  }
  return null;
}

/**
 * Convenience: providerRequest → display label (null when no thinking intent).
 */
export function describeProviderThinking(providerRequest) {
  return formatThinkingSummary(summarizeProviderThinking(providerRequest));
}