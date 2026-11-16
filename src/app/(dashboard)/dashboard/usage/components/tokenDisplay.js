// Single read path for token counts stored on a requestDetails row.
//
// Request details persist the RAW usage object handed to saveRequestDetail(),
// not the canonicalized shape written to usageHistory/usageDaily. Providers and
// translators therefore leave cache counters in provider-specific places:
//   - translators' buildUsage(): prompt_tokens_details.cached_tokens / cache_creation_tokens
//   - Gemini / Antigravity wire: cachedContentTokenCount
//   - DeepSeek: prompt_cache_hit_tokens / prompt_cache_write_tokens
//   - Claude: cache_read_input_tokens / cache_creation_input_tokens
// Reading only the top-level Claude/OpenAI field hid every nested shape from the
// details list and drawer, even though the overview (canonicalized on write)
// reported the same request's cache correctly. Keep this file the only place
// that knows the aliases so the list, the drawer and the tests cannot drift.

function firstNumber(candidates) {
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export function getCachedTokens(tokens) {
  return firstNumber([
    tokens?.cached_tokens,
    tokens?.cache_read_input_tokens,
    tokens?.prompt_tokens_details?.cached_tokens,
    tokens?.prompt_cache_hit_tokens,
    tokens?.cachedContentTokenCount,
    tokens?.input_tokens_details?.cached_tokens,
    tokens?.usageMetadata?.cachedContentTokenCount,
  ]);
}

export function getCacheCreationTokens(tokens) {
  return firstNumber([
    tokens?.cache_creation_input_tokens,
    tokens?.prompt_tokens_details?.cache_creation_tokens,
    tokens?.cache_write_tokens,
    tokens?.prompt_cache_write_tokens,
  ]);
}

export function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  // Canonical storage keeps prompt cache-inclusive. Legacy Claude rows may have
  // stored prompt cache-exclusive; fall back to cache when it's larger so old
  // rows don't under-report input.
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

export function getOutputTokens(tokens) {
  // Translators store usage in either OpenAI field names
  // (completion_tokens) or Claude field names (output_tokens) — issue #3890.
  return tokens?.completion_tokens || tokens?.output_tokens || 0;
}
