import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";

const state = vi.hoisted(() => ({
  connections: [],
  combos: [],
  updatePatches: [],
  settings: { fallbackStrategy: "round-robin", requireApiKey: false },
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

import { handleChat } from "../../src/sse/handlers/chat.js";
import { POST as v1betaPost } from "../../src/app/api/v1beta/models/[...path]/route.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { resetGeminiRotationCursors, getGeminiRotationCursor } from "../../src/sse/services/geminiRotation.js";

function geminiOkResponse(text = "ok") {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function makeGeminiConn(id, priority, overrides = {}) {
  return {
    id,
    provider: "gemini",
    authType: "apikey",
    apiKey: `gem-key-${id}`,
    priority,
    isActive: true,
    name: `Gemini-${id}`,
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

describe("Gemini rotation end-to-end across chat endpoints & /v1beta native endpoints", () => {
  let fetchSpy;

  beforeEach(() => {
    resetGeminiRotationCursors();
    state.connections = [
      makeGeminiConn("1", 1),
      makeGeminiConn("2", 2),
      makeGeminiConn("3", 3),
    ];
    state.combos = [];
    state.updatePatches = [];
    state.settings = { fallbackStrategy: "round-robin", requireApiKey: false };
    upstreamMocks.fetch.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((...args) => upstreamMocks.fetch(...args));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.useRealTimers();
  });

  it("/v1/chat/completions ignores dashboard strategy, disables 503 built-in retry, waits 30s on 503/429, advances cursor, and writes no modelLock_*", async () => {
    vi.useFakeTimers();

    const keysUsed = [];
    upstreamMocks.fetch.mockImplementation(async (_url, opts) => {
      const key = getHeaderKey(opts);
      keysUsed.push(key);
      if (keysUsed.length === 1) {
        // Key 1 returns 503 -> executor MUST NOT do 3x2s internal retries
        return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (keysUsed.length === 2) {
        // Key 2 returns 429
        return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return geminiOkResponse("from-key-3");
    });

    const req1 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const promise1 = handleChat(req1);
    // Advance twice by 30s for the 503 on key-1 and 429 on key-2
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);

    const res1 = await promise1;
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.choices[0].message.content).toBe("from-key-3");
    expect(keysUsed).toEqual(["gem-key-1", "gem-key-2", "gem-key-3"]);
    expect(getGeminiRotationCursor("gemini")).toBe("3");

    // Verify no modelLock_* or backoffLevel was written on any patch
    for (const { patch } of state.updatePatches) {
      expect(patch.backoffLevel).toBeUndefined();
      expect(Object.keys(patch).some((k) => k.startsWith("modelLock_"))).toBe(false);
    }
    // Verify dashboard error statuses recorded for 1 and 2
    expect(state.connections.find((c) => c.id === "1").testStatus).toBe("unavailable");
    expect(state.connections.find((c) => c.id === "2").testStatus).toBe("unavailable");

    // Request 2 (bare model inference via /v1/messages) MUST start after cursor ("3") -> "1"!
    // Notice account 1 was marked "unavailable" above, yet Gemini rotation STILL includes it & clears its error on success!
    keysUsed.length = 0;
    upstreamMocks.fetch.mockImplementation(async (_url, opts) => {
      keysUsed.push(getHeaderKey(opts));
      return geminiOkResponse("from-key-1-claude");
    });
    const req2 = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        max_tokens: 32,
        stream: false,
        messages: [{ role: "user", content: "hi claude format" }],
      }),
    });
    const res2 = await handleChat(req2);
    expect(res2.status).toBe(200);
    expect(keysUsed).toEqual(["gem-key-1"]);
    expect(getGeminiRotationCursor("gemini")).toBe("1");
    expect(state.connections.find((c) => c.id === "1").testStatus).toBe("active");
    expect(state.connections.find((c) => c.id === "1").lastError).toBeNull();
  });

  it("/v1/responses switches immediately (0ms wait) on 401/403/500 and rotates Google 400 invalid API key, while failing fast on request-scoped 400", async () => {
    const seen = [];
    upstreamMocks.fetch.mockImplementation(async (_url, opts) => {
      const key = getHeaderKey(opts);
      seen.push(key);
      if (key === "gem-key-1") {
        // 401 should NOT incur 3s refreshWithRetry delay for API-key gemini
        return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
      }
      if (key === "gem-key-2") {
        return new Response(
          JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }),
          { status: 400 }
        );
      }
      return geminiOkResponse("responses-ok");
    });

    const t0 = Date.now();
    const res = await handleChat(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini/gemini-2.5-flash",
          stream: false,
          input: "hello responses api",
        }),
      })
    );
    const elapsedMs = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(seen).toEqual(["gem-key-1", "gem-key-2", "gem-key-3"]);
    expect(elapsedMs).toBeLessThan(1500); // proves no 3s refreshWithRetry and no 30s sleep

    // Now test request-scoped 400 -> starts after cursor "3" -> "1", fails fast without rotating to 2
    seen.length = 0;
    upstreamMocks.fetch.mockImplementationOnce(async (_url, opts) => {
      seen.push(getHeaderKey(opts));
      return new Response(JSON.stringify({ error: { message: "Invalid JSON payload received at contents" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const badRes = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini/gemini-2.5-flash",
          stream: false,
          messages: [{ role: "user", content: "bad" }],
        }),
      })
    );
    expect(badRes.status).toBe(400);
    expect(seen).toEqual(["gem-key-1"]);
    // Cursor advances to "1" regardless of failure
    expect(getGeminiRotationCursor("gemini")).toBe("1");
  });

  it("chat endpoint stops immediately and returns 499 when client aborts during 30s wait or during upstream fetch", async () => {
    vi.useFakeTimers();

    upstreamMocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
    );

    const acWait = new AbortController();
    const req1 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: acWait.signal,
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: false,
        messages: [{ role: "user", content: "abort wait" }],
      }),
    });

    const p1 = handleChat(req1);
    await vi.advanceTimersByTimeAsync(1000);
    acWait.abort();
    const res1 = await p1;
    expect(res1.status).toBe(499);
    expect(upstreamMocks.fetch).toHaveBeenCalledTimes(1);

    vi.useRealTimers();

    // Abort during in-flight fetch
    upstreamMocks.fetch.mockReset();
    const acFetch = new AbortController();
    upstreamMocks.fetch.mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });

    const req2 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: acFetch.signal,
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: false,
        messages: [{ role: "user", content: "abort fetch" }],
      }),
    });
    const p2 = handleChat(req2);
    setTimeout(() => acFetch.abort(), 30);
    const res2 = await p2;
    expect(res2.status).toBe(499);
    expect(upstreamMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("chat endpoint returns 404 when no active gemini accounts exist", async () => {
    state.connections = [];
    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini/gemini-2.5-flash",
          stream: false,
          messages: [{ role: "user", content: "no creds" }],
        }),
      })
    );
    expect(res.status).toBe(404);
    expect(upstreamMocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps non-gemini provider fallback working properly (refreshedCredentials scope)", async () => {
    state.connections = [
      {
        id: "ant-1",
        provider: "antigravity",
        authType: "oauth",
        accessToken: "token-1",
        priority: 1,
        isActive: true,
        name: "Ant1",
        projectId: "proj-1",
        providerSpecificData: {},
      },
      {
        id: "ant-2",
        provider: "antigravity",
        authType: "oauth",
        accessToken: "token-2",
        priority: 2,
        isActive: true,
        name: "Ant2",
        projectId: "proj-2",
        providerSpecificData: {},
      },
    ];

    let call = 0;
    upstreamMocks.fetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
      }
      return new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: "ant-ok" }] }, finishReason: "STOP" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "antigravity/gemini-2.5-flash",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(call).toBe(2);
  });

  it("/v1beta non-TTS endpoint rotates with shared cursor and forwards request.signal abort", async () => {
    const seen = [];
    upstreamMocks.fetch.mockImplementation(async (_url, opts) => {
      const key = getHeaderKey(opts);
      seen.push(key);
      if (key === "gem-key-1") {
        return new Response(JSON.stringify({ error: { message: "err" } }), { status: 500 });
      }
      return geminiOkResponse("native-non-tts");
    });

    const req = new Request("http://localhost/api/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    });
    const res = await v1betaPost(req, { params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }) });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["gem-key-1", "gem-key-2"]);
    expect(getGeminiRotationCursor("gemini")).toBe("2");

    // Pre-aborted /v1beta non-TTS request is forwarded cleanly to handleChat and returns 499
    const ac = new AbortController();
    ac.abort();
    const abortedReq = new Request("http://localhost/api/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    });
    const abortedRes = await v1betaPost(abortedReq, {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });
    expect(abortedRes.status).toBe(499);
  });

  it("/v1beta TTS native endpoint uses 3-cycle 30s rotation, preserves CORS & strips compression headers, and handles aborts/404", async () => {
    vi.useFakeTimers();

    const seen = [];
    upstreamMocks.fetch.mockImplementation(async (_url, opts) => {
      const key = getHeaderKey(opts);
      seen.push(key);
      if (seen.length === 1) {
        return new Response("overloaded", { status: 503 });
      }
      if (seen.length === 2) {
        throw new Error("ECONNRESET");
      }
      return new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "999",
          "transfer-encoding": "chunked",
          "x-custom": "keep",
        },
      });
    });

    const ttsReq = new Request(
      "http://localhost/api/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "speak" }] }],
          generationConfig: { responseModalities: ["AUDIO"] },
        }),
      }
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let res;
    try {
      const p = v1betaPost(ttsReq, {
        params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }),
      });
      // Account 1 returned 503 -> wait 30s; Account 2 threw network error (502) -> immediate switch to Account 3!
      await vi.advanceTimersByTimeAsync(30000);

      res = await p;
      const warnText = warnSpy.mock.calls.flat().join("\n");
      const infoText = logSpy.mock.calls.flat().join("\n");
      expect(warnText).toContain("[GEMINI_ROTATION]");
      expect(infoText).toContain("[GEMINI_ROTATION]");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(seen).toEqual(["gem-key-1", "gem-key-2", "gem-key-3"]);
    expect(getGeminiRotationCursor("gemini")).toBe("3");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    vi.useRealTimers();

    // No credentials -> 404
    state.connections = [];
    const noCredRes = await v1betaPost(
      new Request("http://localhost/api/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "speak" }] }] }),
      }),
      { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) }
    );
    expect(noCredRes.status).toBe(404);
  });

  it("streaming (/v1/chat/completions stream:true) holds silently during 30s wait then streams SSE on recovery", async () => {
    vi.useFakeTimers();

    const encoder = new TextEncoder();
    let call = 0;
    upstreamMocks.fetch.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      const ssePayload =
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"stream-ok"}]},"finishReason":"STOP"}]}\n\n';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ssePayload));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "stream test" }],
      }),
    });

    let settled = false;
    const p = handleChat(req).then((r) => {
      settled = true;
      return r;
    });

    // Advance 29s: connection MUST still be held open silently (promise pending)
    await vi.advanceTimersByTimeAsync(29000);
    expect(settled).toBe(false);
    expect(call).toBe(1);

    // Advance remaining 1s -> 30s wait completes, switches to key 2 and streams SSE
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("stream-ok");
    expect(call).toBe(2);
    expect(getGeminiRotationCursor("gemini")).toBe("2");
  });

  it("/v1beta TTS native endpoint aborts during 30s sleep -> 499 and returns 429 after 3 exhausted cycles", async () => {
    vi.useFakeTimers();

    upstreamMocks.fetch.mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: "quota 429" } }), { status: 429 })
    );

    const ac = new AbortController();
    const pAbort = v1betaPost(
      new Request("http://localhost/api/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "abort" }] }] }),
      }),
      { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) }
    );
    await vi.advanceTimersByTimeAsync(1000);
    ac.abort();
    const abortRes = await pAbort;
    expect(abortRes.status).toBe(499);
    expect(upstreamMocks.fetch).toHaveBeenCalledTimes(1);

    // Full 3-cycle exhaustion across 2 active connections -> 6 fetches, 5 waits
    upstreamMocks.fetch.mockClear();
    state.connections = [makeGeminiConn("1", 1), makeGeminiConn("2", 2)];
    const pExhaust = v1betaPost(
      new Request("http://localhost/api/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "exhaust" }] }] }),
      }),
      { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) }
    );
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30000);
    }
    const exhaustRes = await pExhaust;
    expect(exhaustRes.status).toBe(429);
    expect(upstreamMocks.fetch).toHaveBeenCalledTimes(6);
  });

  it("combo leg targeting gemini exhausts 3 cycles before failing over to openai, and fast-fails request-scoped 400", async () => {
    state.connections = [
      makeGeminiConn("1", 1),
      makeGeminiConn("2", 2),
      {
        id: "oa-1",
        provider: "openai",
        authType: "apikey",
        apiKey: "oa-key-1",
        priority: 1,
        isActive: true,
        name: "OpenAI-1",
        providerSpecificData: {},
      },
    ];
    state.combos = [
      {
        name: "gem-fallback",
        models: ["gemini/gemini-2.5-flash", "openai/gpt-4o"],
        strategy: "fallback",
      },
    ];

    const calls = [];
    upstreamMocks.fetch.mockImplementation(async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        calls.push({ provider: "gemini", key: getHeaderKey(opts) });
        return new Response(JSON.stringify({ error: { message: "internal error" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push({ provider: "openai" });
      return new Response(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"served by openai"},"finish_reason":null}]}\n\n' +
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    const res1 = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gem-fallback", stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.choices[0].message.content).toBe("served by openai");
    // 2 Gemini keys * 3 cycles = 6 Gemini calls, then 1 OpenAI call
    expect(calls.map((c) => c.provider)).toEqual([
      "gemini",
      "gemini",
      "gemini",
      "gemini",
      "gemini",
      "gemini",
      "openai",
    ]);

    // Scenario 2: request-scoped 400 on Gemini stops Gemini after 1 attempt, then combo fails over to OpenAI
    calls.length = 0;
    resetGeminiRotationCursors();
    upstreamMocks.fetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        calls.push({ provider: "gemini" });
        return new Response(JSON.stringify({ error: { message: "Invalid JSON payload received" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push({ provider: "openai" });
      return new Response(
        'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"fallback after 400"},"finish_reason":null}]}\n\n' +
          'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    const res2 = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gem-fallback", stream: false, messages: [{ role: "user", content: "bad" }] }),
      })
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.choices[0].message.content).toBe("fallback after 400");
    expect(calls).toEqual([{ provider: "gemini" }, { provider: "openai" }]);
  });

  it("aborting a gemini/* leg inside a multi-model combo stops immediately with 499 without falling over to openai", async () => {
    state.connections = [
      makeGeminiConn("1", 1),
      makeGeminiConn("2", 2),
      {
        id: "oa-1",
        provider: "openai",
        authType: "apikey",
        apiKey: "oa-key-1",
        priority: 1,
        isActive: true,
        name: "OpenAI-1",
        providerSpecificData: {},
      },
    ];
    state.combos = [
      {
        name: "gem-fallback",
        models: ["gemini/gemini-2.5-flash", "openai/gpt-4o"],
        strategy: "fallback",
      },
    ];

    // 1. Abort during Gemini 30s wait inside combo
    vi.useFakeTimers();
    const calls = [];
    upstreamMocks.fetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        calls.push("gemini");
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      calls.push("openai");
      return new Response("unexpected", { status: 200 });
    });

    const acWait = new AbortController();
    const pWait = handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: acWait.signal,
        body: JSON.stringify({ model: "gem-fallback", stream: false, messages: [{ role: "user", content: "abort combo wait" }] }),
      })
    );
    await vi.advanceTimersByTimeAsync(1000);
    acWait.abort();
    const resWait = await pWait;
    expect(resWait.status).toBe(499);
    expect(calls).toEqual(["gemini"]);

    vi.useRealTimers();

    // 2. Abort during Gemini in-flight fetch inside combo
    calls.length = 0;
    state.updatePatches = [];
    upstreamMocks.fetch.mockReset();
    const acFetch = new AbortController();
    upstreamMocks.fetch.mockImplementation((url, opts) => {
      const urlStr = String(url);
      if (!urlStr.includes("generativelanguage.googleapis.com")) {
        calls.push("openai");
        return Promise.resolve(new Response("unexpected", { status: 200 }));
      }
      calls.push("gemini");
      return new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });

    const pFetch = handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: acFetch.signal,
        body: JSON.stringify({ model: "gem-fallback", stream: false, messages: [{ role: "user", content: "abort combo fetch" }] }),
      })
    );
    setTimeout(() => acFetch.abort(), 30);
    const resFetch = await pFetch;
    expect(resFetch.status).toBe(499);
    expect(calls).toEqual(["gemini"]);
    expect(state.updatePatches).toEqual([]);
  });

  it("handles concurrent Gemini chat requests without corrupting shared cursor", async () => {
    let callNum = 0;
    upstreamMocks.fetch.mockImplementation(async () => {
      const n = ++callNum;
      await Promise.resolve();
      if (n === 1) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return geminiOkResponse(`ok-${n}`);
    });

    const req1 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "r1" }] }),
    });
    const req2 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "r2" }] }),
    });

    const [res1, res2] = await Promise.all([handleChat(req1), handleChat(req2)]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(["1", "2", "3"]).toContain(getGeminiRotationCursor("gemini"));
  });

  it("handleChat returns 499 immediately without 502 retry when aborted with a custom non-AbortError reason", async () => {
    const ac = new AbortController();
    upstreamMocks.fetch.mockImplementation(async () => {
      ac.abort(new Error("custom-socket-close"));
      throw new Error("socket hang up");
    });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "abort" }] }),
      signal: ac.signal,
    });

    const res = await handleChat(req);
    expect(res.status).toBe(499);
    expect(upstreamMocks.fetch).toHaveBeenCalledTimes(1);
    expect(state.updatePatches).toEqual([]);
  });

  it("body-phase client abort after upstream 200 headers returns 499 (not 502) and does not fail over inside a combo", async () => {
    state.combos = [
      {
        name: "gem-body-abort",
        models: ["gemini/gemini-2.5-flash", "openai/gpt-4o"],
        strategy: "fallback",
      },
    ];
    state.connections.push({
      id: "oai-1",
      provider: "openai",
      authType: "apikey",
      apiKey: "sk-oai-1",
      priority: 1,
      isActive: true,
      name: "OpenAI-1",
      providerSpecificData: {},
    });

    const ac = new AbortController();
    const calls = [];
    upstreamMocks.fetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (!urlStr.includes("generativelanguage.googleapis.com")) {
        calls.push("openai");
        return new Response("unexpected", { status: 200 });
      }
      calls.push("gemini");
      const stream = new ReadableStream({
        pull() {
          return new Promise((_, reject) => {
            const onAbort = () => reject(Object.assign(new Error("Client aborted body read"), { name: "AbortError" }));
            if (ac.signal.aborted) return onAbort();
            ac.signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const p = handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({ model: "gem-body-abort", stream: false, messages: [{ role: "user", content: "body abort" }] }),
      })
    );
    setTimeout(() => ac.abort(), 30);
    const res = await p;

    expect(res.status).toBe(499);
    expect(calls).toEqual(["gemini"]);
    expect(state.updatePatches).toEqual([]);
  });

  it("real loopback TCP socket close aborts Gemini 30s rotation wait immediately on /v1/chat/completions and /v1beta", async () => {
    for (const targetPath of ["/v1/chat/completions", "/v1beta/models/gemini-2.5-flash:generateContent"]) {
      resetGeminiRotationCursors();
      upstreamMocks.fetch.mockReset();

      let resolveFetchEntered;
      const fetchEntered = new Promise((resolve) => { resolveFetchEntered = resolve; });
      upstreamMocks.fetch.mockImplementation(async () => {
        resolveFetchEntered();
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      });

      let handlerPromise;
      const server = http.createServer((req, res) => {
        const ac = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) ac.abort();
        });
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const webReq = new Request(`http://127.0.0.1${req.url}`, {
            method: req.method,
            headers: { "content-type": req.headers["content-type"] || "application/json" },
            body: rawBody,
            signal: ac.signal,
          });
          handlerPromise = (async () => {
            const response = req.url.startsWith("/v1beta/")
              ? await v1betaPost(webReq, { params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }) })
              : await handleChat(webReq);
            if (!res.writableEnded) {
              res.statusCode = response.status;
              res.end(await response.text());
            }
            return response;
          })();
        });
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();

      try {
        const payload = targetPath.startsWith("/v1beta/")
          ? JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] })
          : JSON.stringify({ model: "gemini/gemini-2.5-flash", stream: false, messages: [{ role: "user", content: "hi" }] });

        const clientReq = http.request({
          hostname: "127.0.0.1",
          port,
          path: targetPath,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        });
        clientReq.on("error", () => {});
        clientReq.write(payload);
        clientReq.end();

        await fetchEntered;
        // Let rotation enter the 30s wait, then close the real TCP socket.
        await new Promise((resolve) => setTimeout(resolve, 40));
        const abortStart = Date.now();
        clientReq.destroy();

        const handlerRes = await handlerPromise;
        const abortElapsed = Date.now() - abortStart;

        expect(handlerRes.status).toBe(499);
        expect(abortElapsed).toBeLessThan(2000);
        expect(upstreamMocks.fetch).toHaveBeenCalledTimes(1);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });

  it("returns 499 when request.json() or forced SSE->JSON conversion aborts on client disconnect", async () => {
    const ac = new AbortController();
    ac.abort();

    const abortedReq = {
      url: "http://localhost/v1/chat/completions",
      headers: new Headers(),
      signal: ac.signal,
      json: async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      },
    };
    const chatRes = await handleChat(abortedReq);
    expect(chatRes.status).toBe(499);

    const v1betaRes = await v1betaPost(abortedReq, {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });
    expect(v1betaRes.status).toBe(499);

    const sseRes = await handleForcedSSEToJson({
      providerResponse: {
        headers: new Headers({ "content-type": "text/event-stream" }),
        text: async () => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      },
      sourceFormat: "openai",
      targetFormat: "openai",
      provider: "openai",
      model: "gpt-4o",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      trackDone: () => {},
      appendLog: () => {},
      clientSignal: ac.signal,
    });
    expect(sseRes.success).toBe(false);
    expect(sseRes.status).toBe(499);
    expect(sseRes.response.status).toBe(499);
  });
});
