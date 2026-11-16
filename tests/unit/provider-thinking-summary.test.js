import { describe, it, expect, vi } from "vitest";

// Sever the DB import chain (usageDb -> @/lib/db/*) — not under test.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(),
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(),
}));
// requestDetail.js pulls COLORS from stream.js, which drags in the translator graph.
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: {},
  formatSSE: vi.fn(),
}));

import { buildRequestDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";
import {
  summarizeProviderThinking,
  formatThinkingSummary,
  describeProviderThinking,
} from "../../open-sse/handlers/chatCore/providerThinkingSummary.js";

describe("providerThinkingSummary — outbound thinking intent", () => {
  it("reads OpenAI reasoning_effort", () => {
    expect(describeProviderThinking({ reasoning_effort: "high" })).toBe("high");
  });

  it("reads nested OpenAI reasoning.effort (Responses wire)", () => {
    expect(describeProviderThinking({ reasoning: { effort: "xhigh", summary: "auto" } })).toBe("xhigh");
  });

  it("reads Claude budget thinking as a k-short budget", () => {
    expect(describeProviderThinking({ thinking: { type: "enabled", budget_tokens: 8192 } })).toBe("8k");
  });

  it("reads Claude output_config.effort (adaptive)", () => {
    expect(describeProviderThinking({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } }))
      .toBe("medium");
  });

  it("reads Gemini nested generationConfig.thinkingConfig", () => {
    expect(describeProviderThinking({ generationConfig: { thinkingConfig: { thinkingLevel: "low" } } }))
      .toBe("low");
  });

  it("reads Gemini thinkingBudget=0 as off", () => {
    expect(describeProviderThinking({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } })).toBe("off");
  });

  it("reads Kiro additionalModelRequestFields.output_config.effort", () => {
    const body = {
      conversationState: { currentMessage: { userInputMessage: { content: "hi" } } },
      additionalModelRequestFields: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
    };
    expect(describeProviderThinking(body)).toBe("high");
  });

  it("reads Kiro's native GPT effort field", () => {
    expect(describeProviderThinking({ additionalModelRequestFields: { reasoning: { effort: "low" } } }))
      .toBe("low");
  });

  it("reads Kiro's <thinking_mode> system prefix budget", () => {
    const body = {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: "<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>16000</max_thinking_length>\n\nhi",
          },
        },
      },
    };
    expect(describeProviderThinking(body)).toBe("16k");
  });

  it("reports off when the outbound body disables thinking", () => {
    expect(describeProviderThinking({ thinking: { type: "disabled" } })).toBe("off");
  });

  it("returns null when no thinking intent reached the provider", () => {
    expect(describeProviderThinking({ messages: [], model: "gpt-5" })).toBeNull();
    expect(describeProviderThinking(null)).toBeNull();
    expect(describeProviderThinking("streaming")).toBeNull();
    expect(describeProviderThinking({})).toBeNull();
  });

  it("never throws on malformed bodies", () => {
    expect(() => describeProviderThinking({ reasoning_effort: 123 })).not.toThrow();
    expect(describeProviderThinking({ reasoning_effort: 123 })).toBeNull();
    const cyclic = { reasoning_effort: "low" };
    cyclic.self = cyclic;
    expect(() => summarizeProviderThinking(cyclic)).not.toThrow();
  });

  it("formats every intent mode", () => {
    expect(formatThinkingSummary(null)).toBeNull();
    expect(formatThinkingSummary({ mode: "none" })).toBe("off");
    expect(formatThinkingSummary({ mode: "auto" })).toBe("auto");
    expect(formatThinkingSummary({ mode: "level", level: "minimal" })).toBe("minimal");
    expect(formatThinkingSummary({ mode: "budget", budget: 512 })).toBe("512");
    expect(formatThinkingSummary({ mode: "budget", budget: 24576 })).toBe("25k");
    expect(formatThinkingSummary({ mode: "budget" })).toBe("auto");
  });
});

describe("buildRequestDetail — non-redacted summary fields", () => {
  const base = { provider: "gemini", model: "gemini-3.1-flash", request: {}, response: {} };

  it("keeps statusCode/statusText out of the redacted response blob", () => {
    const detail = buildRequestDetail({
      ...base,
      status: "error",
      response: { error: "upstream refused", status: 503, thinking: null },
    });
    expect(detail.statusCode).toBe(503);
    expect(detail.statusText).toBe("503 Service Unavailable");
  });

  it("labels 429 and 499 too", () => {
    expect(buildRequestDetail({ ...base, response: { status: 429 } }).statusText).toBe("429 Too Many Requests");
    expect(buildRequestDetail({ ...base, response: { status: 499 } }).statusText).toBe("499 Client Closed Request");
  });

  it("leaves statusCode null for successful requests", () => {
    const detail = buildRequestDetail({ ...base, response: { content: "ok" } });
    expect(detail.statusCode).toBeNull();
    expect(detail.statusText).toBeNull();
  });

  it("ignores non-error and non-integer statuses", () => {
    expect(buildRequestDetail({ ...base, response: { status: 200 } }).statusCode).toBeNull();
    expect(buildRequestDetail({ ...base, response: { status: "abc" } }).statusCode).toBeNull();
    expect(buildRequestDetail({ ...base, response: { status: 302 } }).statusCode).toBeNull();
  });

  it("derives providerThinking from the outbound body", () => {
    const detail = buildRequestDetail({
      ...base,
      providerRequest: { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } },
    });
    expect(detail.providerThinking).toBe("high");
  });

  it("providerThinking is null when the provider request is absent", () => {
    expect(buildRequestDetail({ ...base, providerRequest: null }).providerThinking).toBeNull();
    expect(buildRequestDetail({ ...base, providerRequest: "[Streaming - raw response not captured]" }).providerThinking)
      .toBeNull();
  });

  it("overrides still win over the base values", () => {
    const detail = buildRequestDetail({ ...base, status: "success" }, { status: "error", id: "x" });
    expect(detail.status).toBe("error");
    expect(detail.id).toBe("x");
  });
});