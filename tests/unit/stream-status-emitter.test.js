import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: [],
  combos: [],
  updatePatches: [],
  settings: { fallbackStrategy: "fallback", requireApiKey: false },
}));

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async ({ provider, isActive } = {}) => {
    return state.connections
      .filter((c) => (!provider || c.provider === provider) && (isActive === undefined || c.isActive === isActive))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((c) => ({ ...c, providerSpecificData: { ...(c.providerSpecificData || {}) } }));
  }),
  getProviderConnectionById: vi.fn(async (id) => {
    const conn = state.connections.find((c) => c.id === id);
    return conn ? { ...conn, providerSpecificData: { ...(conn.providerSpecificData || {}) } } : null;
  }),
  updateProviderConnection: vi.fn(async (id, patch) => {
    state.updatePatches.push({ id, patch });
    const idx = state.connections.findIndex((c) => c.id === id);
    if (idx !== -1) {
      state.connections[idx] = { ...state.connections[idx], ...patch };
    }
    return state.connections[idx] || null;
  }),
  getSettings: vi.fn(async () => ({ ...state.settings })),
  validateApiKey: vi.fn(async () => true),
  getProxyPools: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getComboByName: vi.fn(async (name) => state.combos.find((c) => c.name === name) || null),
  getProviderNodes: vi.fn(async () => []),
}));

const upstreamMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: vi.fn(async () => null),
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({
  getCombos: vi.fn(async () => [...state.combos]),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
    strictProxy: false,
  })),
  pickProxyPoolId: vi.fn(() => null),
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => upstreamMocks.fetch(...args),
}));
vi.mock("@/lib/usageDb.js", () => ({
  statsEmitter: { emit: vi.fn() },
  trackPendingRequest: vi.fn(),
  getActiveRequests: vi.fn(() => []),
  saveRequestUsage: vi.fn(async () => {}),
  getUsageHistory: vi.fn(async () => []),
  getUsageStats: vi.fn(async () => ({})),
  getChartData: vi.fn(async () => []),
  appendRequestLog: vi.fn(async () => {}),
  getRecentLogs: vi.fn(async () => []),
  saveRequestDetail: vi.fn(async () => {}),
  getRequestDetails: vi.fn(async () => []),
  getRequestDetailById: vi.fn(async () => null),
}));

import { SSE_HEADERS_CORS } from "../../open-sse/utils/sseConstants.js";
import {
  STREAM_STATUS_HEADER,
  wantsStreamStatus,
  createImmediateStatusStreamResponse,
} from "../../src/sse/utils/streamStatusEmitter.js";
import { handleChat } from "../../src/sse/handlers/chat.js";
import {
  resetGeminiRotationCursors,
  getGeminiRotationCursor,
} from "../../src/sse/services/geminiRotation.js";

function makeGeminiConn(id, priority, overrides = {}) {
  return {
    id,
    provider: "gemini",
    authType: "apikey",
    apiKey: `gem-key-${id}`,
    priority,
    isActive: true,
    name: `Gem-${id}`,
    providerSpecificData: {},
    ...overrides,
  };
}

function makeAntigravityConn(id, priority, overrides = {}) {
  return {
    id,
    provider: "antigravity",
    authType: "oauth",
    accessToken: `ant-token-${id}`,
    priority,
    isActive: true,
    name: `Ant-${id}`,
    projectId: `proj-${id}`,
    providerSpecificData: {},
    ...overrides,
  };
}

function getHeaderKey(opts) {
  const headers = opts?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get("x-goog-api-key");
  return headers["x-goog-api-key"] || headers["X-Goog-Api-Key"] || null;
}

function parseSseFrames(rawText) {
  const frames = [];
  const blocks = rawText.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(":")) {
      frames.push({ kind: "comment", raw: trimmed });
      continue;
    }
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        frames.push({ kind: "done" });
      } else {
        frames.push({ kind: "data", data: JSON.parse(payload) });
      }
    }
  }
  return frames;
}

describe("streamStatusEmitter & SSE headers", () => {
  it("updates SSE_HEADERS_CORS with proxy anti-buffering headers", () => {
    expect(SSE_HEADERS_CORS).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("wantsStreamStatus respects opt-in values, case-insensitivity, and streaming flags", () => {
    expect(STREAM_STATUS_HEADER).toBe("x-9router-stream-status");

    expect(wantsStreamStatus({ headers: new Headers({ "X-9Router-Stream-Status": "1" }) }, { stream: true })).toBe(true);
    expect(wantsStreamStatus({ headers: new Headers({ "x-9router-stream-status": "TRUE" }) }, { stream: true })).toBe(true);
    expect(wantsStreamStatus({ headers: new Headers({ "X-9Router-Stream-Status": " True " }) }, {})).toBe(true);
    // Gemini-native requests omit body.stream
    expect(wantsStreamStatus({ headers: { "X-9Router-Stream-Status": "1" } }, { contents: [] })).toBe(true);
    expect(wantsStreamStatus({ headers: { "X-9Router-Stream-Status": "true" } }, undefined)).toBe(true);

    // Opt-out cases
    expect(wantsStreamStatus({ headers: new Headers() }, { stream: true })).toBe(false);
    expect(wantsStreamStatus({ headers: new Headers({ "X-9Router-Stream-Status": "0" }) }, { stream: true })).toBe(false);
    expect(wantsStreamStatus({ headers: new Headers({ "X-9Router-Stream-Status": "false" }) }, { stream: true })).toBe(false);
    expect(wantsStreamStatus({ headers: new Headers({ "X-9Router-Stream-Status": "1" }) }, { stream: false })).toBe(false);
    expect(wantsStreamStatus({ headers: new Headers({ "X-9Router-Stream-Status": "true" }) }, { stream: false })).toBe(false);
  });

  describe("createImmediateStatusStreamResponse primitives", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns 200 SSE headers immediately (0ms TTFB) and emits/resets 15s keepalive heartbeats", async () => {
      vi.useFakeTimers();

      let resolveRun;
      let emitRef;
      const runPromise = new Promise((resolve) => {
        resolveRun = resolve;
      });

      const res = createImmediateStatusStreamResponse({
        keepaliveMs: 15000,
        run: async ({ emitStatus }) => {
          emitRef = emitStatus;
          return runPromise;
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(res.headers.get("x-accel-buffering")).toBe("no");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let doneReading = false;
      const drain = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            doneReading = true;
            break;
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
      })();

      // Advance 10s -> no keepalive yet
      await vi.advanceTimersByTimeAsync(10000);
      expect(chunks).toEqual([]);

      // Writing a status at t=10s must reset the 15s keepalive timer (next due at t=25s)
      emitRef({ phase: "attempt", provider: "gemini", model: "gemini-2.5-flash" });
      await vi.advanceTimersByTimeAsync(14999);
      expect(chunks.join("")).not.toContain(": keepalive");

      // Advance 1ms to t=25s -> first keepalive arrives
      await vi.advanceTimersByTimeAsync(1);
      expect(chunks.join("")).toContain(": keepalive\n\n");

      // Advance another 15s -> second keepalive arrives
      await vi.advanceTimersByTimeAsync(15000);
      const keepaliveMatches = chunks.join("").match(/: keepalive\n\n/g) || [];
      expect(keepaliveMatches).toHaveLength(2);

      // Resolve run with 2xx JSON -> forwards data:<rawJson> + [DONE] and clears timer
      resolveRun(
        new Response(JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "hi" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      await drain;
      expect(doneReading).toBe(true);

      const full = chunks.join("");
      expect(full).toContain('data: {"id":"chatcmpl-1","choices":[{"message":{"content":"hi"}}]}\n\n');
      expect(full.endsWith("data: [DONE]\n\n")).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("strips split-chunk upstream data:[DONE], emits phase:done strictly before single final data:[DONE]", async () => {
      const encoder = new TextEncoder();
      let emitRef;

      const res = createImmediateStatusStreamResponse({
        run: async ({ emitStatus }) => {
          emitRef = emitStatus;
          const upstream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel'));
              controller.enqueue(encoder.encode('lo"}}]}\n\ndata: [DO'));
              controller.enqueue(encoder.encode("NE]\n\n"));
              emitRef({ phase: "done", provider: "gemini", model: "gemini-2.5-flash", totalMs: 42 });
              controller.close();
            },
          });
          return new Response(upstream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });

      const text = await res.text();
      const frames = parseSseFrames(text);
      expect(frames).toHaveLength(3);
      expect(frames[0]).toEqual({
        kind: "data",
        data: { choices: [{ delta: { content: "hello" } }] },
      });
      expect(frames[1].kind).toBe("data");
      expect(frames[1].data._9r_status).toMatchObject({
        phase: "done",
        provider: "gemini",
        model: "gemini-2.5-flash",
        totalMs: 42,
      });
      expect(frames[2]).toEqual({ kind: "done" });
    });

    it("propagates ReadableStream.cancel() to internal abort signal immediately", async () => {
      vi.useFakeTimers();
      let observedAborted = false;
      let abortPromiseResolve;
      const abortedReached = new Promise((r) => {
        abortPromiseResolve = r;
      });

      const res = createImmediateStatusStreamResponse({
        keepaliveMs: 15000,
        run: async ({ emitStatus, signal }) => {
          emitStatus({ phase: "waiting", waitMs: 30000 });
          await new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAborted = true;
                abortPromiseResolve();
                resolve();
              },
              { once: true }
            );
          });
          return new Response(JSON.stringify({ error: { message: "aborted" } }), { status: 499 });
        },
      });

      const reader = res.body.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"phase":"waiting"');

      await reader.cancel("client_closed");
      await abortedReached;

      expect(observedAborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("handleChat with X-9Router-Stream-Status end-to-end", () => {
  let fetchSpy;

  beforeEach(() => {
    resetGeminiRotationCursors();
    state.connections = [makeGeminiConn("1", 1), makeGeminiConn("2", 2)];
    state.combos = [];
    state.updatePatches = [];
    state.settings = { fallbackStrategy: "fallback", requireApiKey: false };
    upstreamMocks.fetch.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((...args) => upstreamMocks.fetch(...args));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.useRealTimers();
  });

  it("does NOT change behavior when X-9Router-Stream-Status header is absent", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let call = 0;

    upstreamMocks.fetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
      }
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"legacy-ok"}]},"finishReason":"STOP"}]}\n\n'
            )
          );
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    let settled = false;
    const p = handleChat(req).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(29000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("legacy-ok");
    expect(text).not.toContain("_9r_status");
    expect(text).not.toContain(": keepalive");
  });

  it("emits immediate headers, 503 rotation sequence, 15s keepalives, streaming, done BEFORE [DONE], and preserves cursor rotation", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const keysUsed = [];

    upstreamMocks.fetch.mockImplementation(async (_url, opts) => {
      keysUsed.push(getHeaderKey(opts));
      if (keysUsed.length === 1) {
        return new Response(JSON.stringify({ error: { message: "Model overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"recovered"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":15,"cachedContentTokenCount":80}}\n\n'
            )
          );
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    // Omit body.stream intentionally (Chat's Gemini-native request shape)
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await handleChat(req);
    // 0ms immediate 200 SSE response
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collected += decoder.decode(value, { stream: true });
      }
    })();

    // Flush microtasks so account 1 fails 503 and enters 30s sleep
    await vi.advanceTimersByTimeAsync(100);
    expect(collected).toContain('"phase":"attempt"');
    expect(collected).toContain('"phase":"posting"');
    expect(collected).toContain('"phase":"upstream_error"');
    expect(collected).toContain('"phase":"waiting"');
    expect(keysUsed).toEqual(["gem-key-1"]);

    // Advance 15s during 30s wait -> keepalive heartbeat arrives
    await vi.advanceTimersByTimeAsync(15000);
    expect(collected).toContain(": keepalive");

    // Finish 30s wait -> account 2 succeeds and streams
    await vi.advanceTimersByTimeAsync(15000);
    await readAll;

    expect(keysUsed).toEqual(["gem-key-1", "gem-key-2"]);
    expect(getGeminiRotationCursor("gemini")).toBe("2");

    const frames = parseSseFrames(collected);
    const statusPhases = frames
      .filter((f) => f.kind === "data" && f.data._9r_status)
      .map((f) => f.data._9r_status);

    expect(statusPhases.map((s) => s.phase)).toEqual([
      "attempt",
      "posting",
      "upstream_error",
      "waiting",
      "attempt",
      "posting",
      "streaming",
      "succeeded",
      "done",
    ]);

    expect(statusPhases[0]).toMatchObject({
      phase: "attempt",
      provider: "gemini",
      model: "gemini-2.5-flash",
      account: "Gem-1",
      cycle: 1,
      totalCycles: 3,
      accountIndex: 1,
      totalAccounts: 2,
    });
    expect(statusPhases[1]).toMatchObject({
      phase: "posting",
      provider: "gemini",
      model: "gemini-2.5-flash",
      account: "Gem-1",
      format: "FMT: openai→gemini",
      msgCount: 1,
      toolCount: 0,
    });
    expect(statusPhases[2]).toMatchObject({
      phase: "upstream_error",
      provider: "gemini",
      model: "gemini-2.5-flash",
      account: "Gem-1",
      statusCode: 503,
    });
    expect(statusPhases[3]).toMatchObject({
      phase: "waiting",
      provider: "gemini",
      model: "gemini-2.5-flash",
      account: "Gem-1",
      statusCode: 503,
      waitMs: 30000,
    });
    expect(typeof statusPhases[3].nextRetryAt).toBe("number");
    expect(statusPhases[6]).toMatchObject({
      phase: "streaming",
      provider: "gemini",
      model: "gemini-2.5-flash",
      account: "Gem-2",
    });
    expect(statusPhases[8]).toMatchObject({
      phase: "done",
      provider: "gemini",
      model: "gemini-2.5-flash",
      account: "Gem-2",
      promptTokens: 120,
      completionTokens: 15,
      cachedTokens: 80,
    });

    // Verify order: content chunk -> phase: "done" -> single data: [DONE] at the very end
    const contentIdx = frames.findIndex((f) => f.kind === "data" && f.data.choices?.[0]?.delta?.content === "recovered");
    const doneStatusIdx = frames.findIndex((f) => f.kind === "data" && f.data._9r_status?.phase === "done");
    const sentinelIdxs = frames
      .map((f, idx) => (f.kind === "done" ? idx : -1))
      .filter((idx) => idx !== -1);

    expect(contentIdx).toBeGreaterThan(-1);
    expect(doneStatusIdx).toBeGreaterThan(contentIdx);
    expect(sentinelIdxs).toEqual([frames.length - 1]);
  });

  it("emits fallback status in generic while(true) loop for Antigravity and preserves account fallback", async () => {
    state.connections = [makeAntigravityConn("1", 1), makeAntigravityConn("2", 2)];
    const encoder = new TextEncoder();

    upstreamMocks.fetch.mockImplementation(async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 });
      }
      const auth = typeof opts?.headers?.get === "function"
        ? opts.headers.get("authorization")
        : (opts?.headers?.Authorization || opts?.headers?.authorization || "");
      if (auth === "Bearer ant-token-1") {
        // Large retry-after vetoes AntigravityExecutor's internal retry so chat.js fallback loop handles it immediately
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3600" },
        });
      }
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ant-stream-ok"}]},"finishReason":"STOP"}]}}\n\n'
            )
          );
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "true",
      },
      body: JSON.stringify({
        model: "antigravity/gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "hi antigravity" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = parseSseFrames(text);
    const phases = frames
      .filter((f) => f.kind === "data" && f.data._9r_status)
      .map((f) => f.data._9r_status);

    expect(phases.map((p) => p.phase)).toEqual([
      "posting",
      "upstream_error",
      "fallback",
      "posting",
      "streaming",
      "done",
    ]);
    expect(phases[2]).toMatchObject({
      phase: "fallback",
      provider: "antigravity",
      model: "gemini-2.5-flash",
      account: "Ant-1",
      statusCode: 429,
    });
    expect(frames.some((f) => f.kind === "data" && f.data.choices?.[0]?.delta?.content === "ant-stream-ok")).toBe(true);
    expect(frames[frames.length - 1]).toEqual({ kind: "done" });
  });

  it("emits exhausted status and SSE error frame + [DONE] when all Gemini accounts fail", async () => {
    vi.useFakeTimers();
    state.connections = [makeGeminiConn("1", 1)];

    upstreamMocks.fetch.mockImplementation(async () => {
      return new Response(JSON.stringify({ error: { message: "Capacity exhausted" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "fail all" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);
    const textPromise = res.text();

    // 1 account x 3 cycles = 2 sleeps of 30s
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);

    const text = await textPromise;
    const frames = parseSseFrames(text);
    const statuses = frames.filter((f) => f.kind === "data" && f.data._9r_status).map((f) => f.data._9r_status);

    expect(statuses.map((s) => s.phase)).toEqual([
      "attempt",
      "posting",
      "upstream_error",
      "waiting",
      "attempt",
      "posting",
      "upstream_error",
      "waiting",
      "attempt",
      "posting",
      "upstream_error",
      "exhausted",
    ]);
    expect(statuses[statuses.length - 1]).toMatchObject({
      phase: "exhausted",
      provider: "gemini",
      model: "gemini-2.5-flash",
      statusCode: 503,
    });

    const errorFrame = frames.find((f) => f.kind === "data" && f.data.error);
    expect(errorFrame).toBeDefined();
    expect(errorFrame.data.error.code).toBe(503);
    expect(errorFrame.data.error.message).toContain("Capacity exhausted");
    expect(frames[frames.length - 1]).toEqual({ kind: "done" });
  });

  it("propagates request.signal abort during 30s Gemini wait and closes stream cleanly without extra attempts", async () => {
    vi.useFakeTimers();

    upstreamMocks.fetch.mockImplementation(async () => {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const ac = new AbortController();
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      signal: ac.signal,
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "abort me" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);

    const textPromise = res.text();
    await vi.advanceTimersByTimeAsync(1000);
    expect(upstreamMocks.fetch).toHaveBeenCalledTimes(1);

    ac.abort();
    const text = await textPromise;

    expect(text).toContain('"phase":"waiting"');
    // Rotation stopped immediately: never waited 30s or attempted key 2
    await vi.advanceTimersByTimeAsync(60000);
    expect(upstreamMocks.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits switching status (no wait) on 500 and upstream_error (502) when executor throws network error", async () => {
    const encoder = new TextEncoder();
    let call = 0;

    upstreamMocks.fetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 500 });
      }
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"after-500"}]},"finishReason":"STOP"}]}\n\n'
            )
          );
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "switch fast" }],
      }),
    });

    const res = await handleChat(req);
    const frames = parseSseFrames(await res.text());
    const phases = frames
      .filter((f) => f.kind === "data" && f.data._9r_status)
      .map((f) => f.data._9r_status.phase);

    expect(phases).toEqual([
      "attempt",
      "posting",
      "upstream_error",
      "switching",
      "attempt",
      "posting",
      "streaming",
      "succeeded",
      "done",
    ]);

    // Network throw -> 502 upstream_error on single non-Gemini provider (use fake timers for BaseExecutor retry backoff)
    vi.useFakeTimers();
    state.connections = [
      {
        id: "oai-1",
        provider: "openai",
        authType: "apikey",
        apiKey: "sk-1",
        priority: 1,
        isActive: true,
        name: "OAI-1",
        providerSpecificData: {},
      },
    ];
    upstreamMocks.fetch.mockReset();
    upstreamMocks.fetch.mockRejectedValue(new Error("ECONNRESET"));

    const netReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "net fail" }],
      }),
    });

    const netRes = await handleChat(netReq);
    const netTextPromise = netRes.text();
    await vi.runAllTimersAsync();
    const netFrames = parseSseFrames(await netTextPromise);
    const errStatuses = netFrames
      .filter((f) => f.kind === "data" && f.data._9r_status?.phase === "upstream_error")
      .map((f) => f.data._9r_status);

    expect(errStatuses.length).toBeGreaterThanOrEqual(1);
    expect(errStatuses[0]).toMatchObject({
      phase: "upstream_error",
      provider: "openai",
      model: "gpt-4o",
      account: "OAI-1",
      statusCode: 502,
    });
    expect(netFrames.some((f) => f.kind === "data" && f.data.error?.code === 503)).toBe(true);
    expect(netFrames[netFrames.length - 1]).toEqual({ kind: "done" });
  });

  it("emits request_error on request-scoped 400 and threads status through combo fallback", async () => {
    state.connections = [
      makeGeminiConn("1", 1),
      {
        id: "oai-1",
        provider: "openai",
        authType: "apikey",
        apiKey: "sk-oai-1",
        priority: 1,
        isActive: true,
        name: "OAI-Combo",
        providerSpecificData: {},
      },
    ];
    state.combos = [
      {
        name: "gem-then-oai",
        models: ["gemini/gemini-2.5-flash", "openai/gpt-4o"],
        strategy: "fallback",
      },
    ];

    upstreamMocks.fetch.mockImplementation(async (url) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ error: { message: "Invalid JSON payload received at contents" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              enc.encode(
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"combo-ok"},"finish_reason":null}]}\n\n' +
                  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
                  "data: [DONE]\n\n"
              )
            );
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      body: JSON.stringify({
        model: "gem-then-oai",
        stream: true,
        messages: [{ role: "user", content: "combo test" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await res.text());
    const phases = frames
      .filter((f) => f.kind === "data" && f.data._9r_status)
      .map((f) => f.data._9r_status.phase);

    expect(phases).toEqual([
      "attempt",
      "posting",
      "upstream_error",
      "request_error",
      "posting",
      "streaming",
      "done",
    ]);
    expect(frames.some((f) => f.kind === "data" && f.data.choices?.[0]?.delta?.content === "combo-ok")).toBe(true);
    expect(frames[frames.length - 1]).toEqual({ kind: "done" });
  });

  it("handles gemini->gemini native passthrough (contents + cachedContentTokenCount + single trailing [DONE])", async () => {
    state.connections = [makeGeminiConn("1", 1)];
    const encoder = new TextEncoder();

    upstreamMocks.fetch.mockImplementation(async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"gemini-native-ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":150,"candidatesTokenCount":25,"cachedContentTokenCount":95}}\n\n'
            )
          );
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    // Gemini-native body (contents, no stream field)
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: "hello native" }] }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = parseSseFrames(text);

    const statusPhases = frames
      .filter((f) => f.kind === "data" && f.data._9r_status)
      .map((f) => f.data._9r_status);

    expect(statusPhases.map((s) => s.phase)).toEqual([
      "attempt",
      "posting",
      "streaming",
      "succeeded",
      "done",
    ]);
    expect(statusPhases[1]).toMatchObject({
      phase: "posting",
      format: "FMT: gemini→gemini",
      msgCount: 1,
    });
    expect(statusPhases[4]).toMatchObject({
      phase: "done",
      provider: "gemini",
      model: "gemini-2.5-flash",
      account: "Gem-1",
      promptTokens: 150,
      completionTokens: 25,
      cachedTokens: 95,
    });

    const contentIdx = frames.findIndex(
      (f) => f.kind === "data" && f.data.candidates?.[0]?.content?.parts?.[0]?.text === "gemini-native-ok"
    );
    const doneStatusIdx = frames.findIndex((f) => f.kind === "data" && f.data._9r_status?.phase === "done");
    const sentinelIdxs = frames
      .map((f, idx) => (f.kind === "done" ? idx : -1))
      .filter((idx) => idx !== -1);

    expect(contentIdx).toBeGreaterThan(-1);
    expect(doneStatusIdx).toBeGreaterThan(contentIdx);
    expect(sentinelIdxs).toEqual([frames.length - 1]);
  });

  it("keeps blank-line event boundary when upstream SSE ends with unterminated tail without trailing newline", async () => {
    const encoder = new TextEncoder();

    const res = createImmediateStatusStreamResponse({
      run: async ({ emitStatus }) => {
        const upstream = new ReadableStream({
          start(controller) {
            // Prior event ended with \n\n (lastLineWasBlank = true), final line lacks any trailing \n
            controller.enqueue(encoder.encode('data: {"id":"1"}\n\ndata: {"id":"2"}'));
            emitStatus({ phase: "done", totalMs: 12 });
            controller.close();
          },
        });
        return new Response(upstream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const text = await res.text();
    // Exact wire framing must separate tail, done status, and [DONE] with \n\n
    expect(text).toContain('data: {"id":"2"}\n\ndata: {"_9r_status":');
    expect(text).toMatch(/\}\}\n\ndata: \[DONE\]\n\n$/);

    const frames = parseSseFrames(text);
    expect(frames).toHaveLength(4);
    expect(frames[0]).toEqual({ kind: "data", data: { id: "1" } });
    expect(frames[1]).toEqual({ kind: "data", data: { id: "2" } });
    expect(frames[2].data._9r_status).toMatchObject({ phase: "done", totalMs: 12 });
    expect(frames[3]).toEqual({ kind: "done" });
  });

  it("does not leak stale phase:done from an empty-peeked combo leg when the next candidate fails with 404/503", async () => {
    // Candidate 1 (openai) has credentials and streams empty content (peekComboResponse drains to EOF);
    // Candidate 2 (anthropic) has NO credentials (returns 404 without emitting any status).
    state.connections = [
      {
        id: "oai-1",
        provider: "openai",
        authType: "apikey",
        apiKey: "sk-oai-1",
        priority: 1,
        isActive: true,
        name: "OAI-Empty",
        providerSpecificData: {},
      },
    ];
    state.combos = [
      {
        name: "empty-then-missing",
        models: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
        strategy: "fallback",
      },
    ];

    const encoder = new TextEncoder();
    upstreamMocks.fetch.mockImplementation(async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"id":"chatcmpl-empty","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}\n\n' +
                "data: [DONE]\n\n"
            )
          );
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-9Router-Stream-Status": "1",
      },
      body: JSON.stringify({
        model: "empty-then-missing",
        stream: true,
        messages: [{ role: "user", content: "empty peek" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await res.text());

    const doneStatuses = frames.filter((f) => f.kind === "data" && f.data._9r_status?.phase === "done");
    expect(doneStatuses).toHaveLength(0);

    const errFrame = frames.find((f) => f.kind === "data" && f.data.error);
    expect(errFrame).toBeDefined();
    expect(errFrame.data.error.code).toBe(502);
    expect(frames[frames.length - 1]).toEqual({ kind: "done" });
  });
});
