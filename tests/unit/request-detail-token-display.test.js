// RequestDetailsTab token display helpers (issue #3890).
// The component is "use client" JSX, so the pure helpers live in
// tokenDisplay.js and are imported here directly.
import { describe, it, expect } from "vitest";
import {
  getOutputTokens,
  getInputTokens,
  getCachedTokens,
  getCacheCreationTokens,
} from "@/app/(dashboard)/dashboard/usage/components/tokenDisplay.js";

describe("getOutputTokens — issue #3890", () => {
  it("Claude-format usage {output_tokens: 100} displays 100, not 0", () => {
    expect(getOutputTokens({ input_tokens: 50, output_tokens: 100 })).toBe(100);
  });

  it("OpenAI-format usage {completion_tokens: 100} still displays 100", () => {
    expect(getOutputTokens({ prompt_tokens: 50, completion_tokens: 100 })).toBe(100);
  });

  it("missing/empty tokens → 0, no throw", () => {
    expect(getOutputTokens(undefined)).toBe(0);
    expect(getOutputTokens(null)).toBe(0);
    expect(getOutputTokens({})).toBe(0);
    expect(() => getOutputTokens(undefined).toLocaleString()).not.toThrow();
  });

  it("input helper unchanged: Claude input_tokens fallback still works", () => {
    expect(getInputTokens({ input_tokens: 50 })).toBe(50);
  });
});

  // Request details store the RAW provider usage, so cache counters land in
  // provider-specific places. Only reading the top-level Claude/OpenAI field made
  // the details list show "—" for a request the overview reported as cached.
  describe("cache counters across raw provider shapes", () => {
    it("reads OpenAI top-level cached_tokens", () => {
      expect(getCachedTokens({ prompt_tokens: 100, cached_tokens: 60 })).toBe(60);
    });

    it("reads translators' nested prompt_tokens_details.cached_tokens (Gemini/oai-compatible rows)", () => {
      const tokens = { prompt_tokens: 93588, completion_tokens: 1461, prompt_tokens_details: { cached_tokens: 91185 } };
      expect(getCachedTokens(tokens)).toBe(91185);
      expect(getInputTokens(tokens)).toBe(93588);
    });

    it("reads the raw Gemini/Antigravity cachedContentTokenCount", () => {
      expect(getCachedTokens({ promptTokenCount: 900, cachedContentTokenCount: 700 })).toBe(700);
    });

    it("reads DeepSeek prompt_cache_hit_tokens", () => {
      expect(getCachedTokens({ prompt_tokens: 298, prompt_cache_hit_tokens: 120 })).toBe(120);
    });

    it("reads Responses input_tokens_details.cached_tokens", () => {
      expect(getCachedTokens({ input_tokens: 25421, input_tokens_details: { cached_tokens: 24320 } })).toBe(24320);
    });

    it("reads nested prompt_tokens_details.cache_creation_tokens", () => {
      expect(getCacheCreationTokens({ prompt_tokens_details: { cache_creation_tokens: 4096 } })).toBe(4096);
    });

    it("reads DeepSeek prompt_cache_write_tokens as cache creation", () => {
      expect(getCacheCreationTokens({ prompt_cache_write_tokens: 512 })).toBe(512);
    });

    it("keeps the Claude top-level field authoritative", () => {
      expect(getCachedTokens({ cache_read_input_tokens: 42, prompt_tokens_details: { cached_tokens: 7 } })).toBe(42);
      expect(getCacheCreationTokens({ cache_creation_input_tokens: 30 })).toBe(30);
    });

    it("ignores zero and missing counters", () => {
      expect(getCachedTokens({ prompt_tokens_details: { cached_tokens: 0 } })).toBe(0);
      expect(getCachedTokens({ prompt_tokens_details: {} })).toBe(0);
      expect(getCacheCreationTokens({ prompt_tokens_details: { cache_creation_tokens: 0 } })).toBe(0);
    });
  });
