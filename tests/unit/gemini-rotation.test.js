import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));

const proxyMocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
    strictProxy: false,
  })),
}));

const proxyFetchMocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => proxyMocks);
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyFetchMocks.proxyAwareFetch,
}));

import { GEMINI_ROTATION } from "open-sse/config/runtimeConfig.js";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { DefaultExecutor } from "open-sse/executors/default.js";
import {
  isGeminiRotationProvider,
  orderFromCursor,
  abortableSleep,
  runGeminiRotation,
  resetGeminiRotationCursors,
  getGeminiRotationCursor,
} from "../../src/sse/services/geminiRotation.js";
import {
  buildCredentialsFromConnection,
  recordAccountError,
} from "../../src/sse/services/geminiCredentials.js";

function makeConn(id, priority, overrides = {}) {
  return {
    id,
    provider: "gemini",
    authType: "apikey",
    apiKey: `key-${id}`,
    priority,
    isActive: true,
    name: `acc-${id}`,
    providerSpecificData: {},
    ...overrides,
  };
}

describe("geminiRotation config & error classification", () => {
  it("exposes expected GEMINI_ROTATION constants", () => {
    expect(GEMINI_ROTATION.providerId).toBe("gemini");
    expect(GEMINI_ROTATION.waitStatuses).toEqual([429, 503]);
    expect(GEMINI_ROTATION.waitMs).toBe(30000);
    expect(GEMINI_ROTATION.cycles).toBe(3);
  });

  it("disables executor built-in 429 and 503 retries for gemini only", () => {
    const geminiExecutor = new DefaultExecutor("gemini");
    expect(geminiExecutor.config.retry[429].attempts).toBe(0);
    expect(geminiExecutor.config.retry[503].attempts).toBe(0);
    // Non-gemini default retry config remains untouched
    const otherExecutor = new DefaultExecutor("openai");
    expect(otherExecutor.config.retry).toBeUndefined();
  });

  it("executor.execute makes only 1 upstream call on 503 for gemini (no 3x2s retry)", async () => {
    proxyFetchMocks.proxyAwareFetch.mockReset();
    proxyFetchMocks.proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    );
    const executor = new DefaultExecutor("gemini");
    const res = await executor.execute({
      model: "gemini-2.5-flash",
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      stream: false,
      credentials: { apiKey: "test-key", authType: "apikey" },
    });
    expect(res.response.status).toBe(503);
    expect(proxyFetchMocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("treats Google AI Studio invalid/expired API key 400s as account-scoped for gemini, while preserving requestScoped for malformed requests", () => {
    expect(
      checkFallbackError(400, "API key not valid. Please pass a valid API key.", 0, "gemini")
    ).toMatchObject({ shouldFallback: true });
    expect(
      checkFallbackError(400, '{"details":[{"reason":"API_KEY_INVALID"}]}', 0, "gemini")
    ).toMatchObject({ shouldFallback: true });
    expect(
      checkFallbackError(400, "API key expired. Please renew the API key.", 0, "gemini")
    ).toMatchObject({ shouldFallback: true });
    expect(
      checkFallbackError(400, '{"details":[{"reason":"API_KEY_EXPIRED"}]}', 0, "gemini")
    ).toMatchObject({ shouldFallback: true });

    expect(
      checkFallbackError(400, "Invalid value at contents[0]", 0, "gemini")
    ).toMatchObject({ shouldFallback: false, requestScoped: true });

    // Other providers are unaffected
    expect(
      checkFallbackError(400, "API key not valid", 0, "openai")
    ).toMatchObject({ shouldFallback: false, requestScoped: true });
  });

  it("identifies only 'gemini' for rotation", () => {
    expect(isGeminiRotationProvider("gemini")).toBe(true);
    expect(isGeminiRotationProvider("gemini-cli")).toBe(false);
    expect(isGeminiRotationProvider("gemini-web")).toBe(false);
    expect(isGeminiRotationProvider("antigravity")).toBe(false);
    expect(isGeminiRotationProvider("vertex")).toBe(false);
    expect(isGeminiRotationProvider("openai")).toBe(false);
    expect(isGeminiRotationProvider("")).toBe(false);
    expect(isGeminiRotationProvider(null)).toBe(false);
  });
});

describe("orderFromCursor & abortableSleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("orders connections defensively by priority and rotates circularly after cursor", () => {
    const a = makeConn("A", 1);
    const b = makeConn("B", 2);
    const c = makeConn("C", 3);
    const unsorted = [c, a, b];

    expect(orderFromCursor(unsorted, null).map((x) => x.id)).toEqual(["A", "B", "C"]);
    expect(orderFromCursor(unsorted, "A").map((x) => x.id)).toEqual(["B", "C", "A"]);
    expect(orderFromCursor(unsorted, "B").map((x) => x.id)).toEqual(["C", "A", "B"]);
    expect(orderFromCursor(unsorted, "C").map((x) => x.id)).toEqual(["A", "B", "C"]);
    expect(orderFromCursor(unsorted, "deleted-id").map((x) => x.id)).toEqual(["A", "B", "C"]);
    expect(orderFromCursor([a], "A").map((x) => x.id)).toEqual(["A"]);
    expect(orderFromCursor([], "A")).toEqual([]);
  });

  it("abortableSleep completes normally and aborts cleanly before timeout", async () => {
    vi.useFakeTimers();

    const p1 = abortableSleep(30000, null);
    await vi.advanceTimersByTimeAsync(30000);
    await expect(p1).resolves.toBe(true);

    const acPre = new AbortController();
    acPre.abort();
    await expect(abortableSleep(30000, acPre.signal)).resolves.toBe(false);

    const acMid = new AbortController();
    const pMid = abortableSleep(30000, acMid.signal);
    await vi.advanceTimersByTimeAsync(5000);
    acMid.abort();
    await expect(pMid).resolves.toBe(false);
  });
});

describe("geminiCredentials helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recordAccountError updates dashboard status fields without writing any modelLock_* keys", async () => {
    await recordAccountError("conn-1", 429, "Quota exceeded for model");

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const [id, patch] = dbMocks.updateProviderConnection.mock.calls[0];
    expect(id).toBe("conn-1");
    expect(patch.testStatus).toBe("unavailable");
    expect(patch.lastError).toBe("Quota exceeded for model");
    expect(patch.errorCode).toBe(429);
    expect(typeof patch.lastErrorAt).toBe("string");
    expect(patch.backoffLevel).toBeUndefined();
    expect(
      Object.keys(patch).some((k) => k.startsWith("modelLock_"))
    ).toBe(false);
  });

  it("recordAccountError truncates overly long error messages", async () => {
    await recordAccountError("conn-2", 500, "x".repeat(800));
    const [, patch] = dbMocks.updateProviderConnection.mock.calls[0];
    expect(patch.lastError.length).toBe(500);
  });

  it("buildCredentialsFromConnection maps proxy config and connection metadata", async () => {
    const conn = makeConn("conn-3", 1, { displayName: "Primary Gemini" });
    const creds = await buildCredentialsFromConnection(conn);
    expect(creds.connectionId).toBe("conn-3");
    expect(creds.apiKey).toBe("key-conn-3");
    expect(creds.connectionName).toBe("Primary Gemini");
    expect(creds._connection).toBe(conn);
  });
});

describe("runGeminiRotation core state machine", () => {
  beforeEach(() => {
    resetGeminiRotationCursors();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls all active accounts in priority order for 3 cycles, waiting 30s on 429/503 except after final attempt", async () => {
    const conns = [makeConn("A", 1), makeConn("B", 2), makeConn("C", 3)];
    const sleepCalls = [];
    const attemptOrder = [];
    const onError = vi.fn(async () => {});

    const outcome = await runGeminiRotation({
      model: "gemini-2.5-flash",
      listConnections: async () => conns,
      buildCredentials: async (c) => ({ connectionId: c.id, apiKey: c.apiKey }),
      sleep: async (ms) => {
        sleepCalls.push(ms);
        return true;
      },
      onError,
      attempt: async (creds, { cycle }) => {
        attemptOrder.push(`${cycle}:${creds.connectionId}`);
        const status = attemptOrder.length % 2 === 1 ? 429 : 503;
        return {
          ok: false,
          status,
          errorText: `Error ${status}`,
          response: new Response("err", { status }),
        };
      },
    });

    expect(outcome.status).toBe("exhausted");
    expect(outcome.httpStatus).toBe(429); // 9th attempt is odd -> 429
    expect(attemptOrder).toEqual([
      "0:A", "0:B", "0:C",
      "1:A", "1:B", "1:C",
      "2:A", "2:B", "2:C",
    ]);
    // 9 attempts -> 8 waits of 30000ms (no wait after 9th attempt)
    expect(sleepCalls).toEqual(Array(8).fill(30000));
    expect(onError).toHaveBeenCalledTimes(9);
    expect(getGeminiRotationCursor("gemini")).toBeNull();
  });

  it("switches immediately (0 sleep) on 401/403/500/502/504/400(API_KEY_INVALID)", async () => {
    const conns = [makeConn("A", 1), makeConn("B", 2)];
    const statuses = [401, 403, 500, 502, 400];
    const sleep = vi.fn(async () => true);
    const onError = vi.fn(async () => {});
    const onSuccess = vi.fn(async () => {});
    const attempted = [];

    const outcome = await runGeminiRotation({
      model: "gemini-2.5-pro",
      listConnections: async () => conns,
      buildCredentials: async (c) => ({ connectionId: c.id, apiKey: c.apiKey }),
      sleep,
      onError,
      onSuccess,
      attempt: async (creds) => {
        const idx = attempted.length;
        attempted.push(creds.connectionId);
        if (idx < statuses.length) {
          const st = statuses[idx];
          return {
            ok: false,
            status: st,
            errorText: st === 400 ? "API key not valid. Please pass a valid API key." : `status ${st}`,
            response: new Response("fail", { status: st }),
          };
        }
        return { ok: true, response: new Response("ok", { status: 200 }) };
      },
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.connection.id).toBe("B");
    expect(attempted).toEqual(["A", "B", "A", "B", "A", "B"]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(5);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(getGeminiRotationCursor("gemini")).toBe("B");
  });

  it("returns request-scoped 400 immediately without rotating, sleeping, or marking account error", async () => {
    const conns = [makeConn("A", 1), makeConn("B", 2)];
    const sleep = vi.fn(async () => true);
    const onError = vi.fn(async () => {});
    const attempted = [];

    const outcome = await runGeminiRotation({
      model: "gemini-2.5-flash",
      listConnections: async () => conns,
      buildCredentials: async (c) => ({ connectionId: c.id, apiKey: c.apiKey }),
      sleep,
      onError,
      attempt: async (creds) => {
        attempted.push(creds.connectionId);
        return {
          ok: false,
          status: 400,
          errorText: "Invalid value at contents[0].role",
          response: new Response("bad request", { status: 400 }),
        };
      },
    });

    expect(outcome.status).toBe("requestError");
    expect(outcome.httpStatus).toBe(400);
    expect(attempted).toEqual(["A"]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(getGeminiRotationCursor("gemini")).toBeNull();
  });

  it("advances shared cursor across models on success, preserves cursor on failure, and recovers to #1 if cursor disappears", async () => {
    let conns = [makeConn("A", 1), makeConn("B", 2), makeConn("C", 3)];
    const orders = [];

    const runOne = (succeedOnId, model) =>
      runGeminiRotation({
        model,
        listConnections: async () => conns,
        buildCredentials: async (c) => ({ connectionId: c.id, apiKey: c.apiKey }),
        sleep: async () => true,
        onError: async () => {},
        onSuccess: async () => {},
        attempt: async (creds) => {
          orders.push(creds.connectionId);
          if (creds.connectionId === succeedOnId) {
            return { ok: true, response: new Response("ok", { status: 200 }) };
          }
          return { ok: false, status: 500, errorText: "err" };
        },
      });

    // Req 1: starts at A, fails A -> succeeds on B (cursor = B)
    orders.length = 0;
    expect((await runOne("B", "gemini-2.5-flash")).status).toBe("ok");
    expect(orders).toEqual(["A", "B"]);
    expect(getGeminiRotationCursor("gemini")).toBe("B");

    // Req 2 (different model!): starts at C -> A -> B, succeeds on C immediately (cursor = C)
    orders.length = 0;
    expect((await runOne("C", "gemini-2.5-pro")).status).toBe("ok");
    expect(orders).toEqual(["C"]);
    expect(getGeminiRotationCursor("gemini")).toBe("C");

    // Req 3: fails all 3 cycles -> cursor MUST stay C
    orders.length = 0;
    expect((await runOne("NONE", "gemini-2.5-flash")).status).toBe("exhausted");
    expect(orders).toEqual(["A", "B", "C", "A", "B", "C", "A", "B", "C"]);
    expect(getGeminiRotationCursor("gemini")).toBe("C");

    // Req 4: cursor account C was disabled -> reset to highest priority A
    conns = [makeConn("A", 1), makeConn("B", 2)];
    orders.length = 0;
    expect((await runOne("A", "gemini-2.5-flash")).status).toBe("ok");
    expect(orders).toEqual(["A"]);
    expect(getGeminiRotationCursor("gemini")).toBe("A");
  });

  it("handles single account across 3 cycles (2 waits on 429)", async () => {
    const conns = [makeConn("only", 1)];
    const sleep = vi.fn(async () => true);
    const attempt = vi.fn(async () => ({
      ok: false,
      status: 503,
      errorText: "unavailable",
    }));

    const outcome = await runGeminiRotation({
      listConnections: async () => conns,
      buildCredentials: async (c) => ({ connectionId: c.id }),
      sleep,
      onError: async () => {},
      attempt,
    });

    expect(outcome.status).toBe("exhausted");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 30000, null);
    expect(sleep).toHaveBeenNthCalledWith(2, 30000, null);
  });

  it("returns noCredentials when no active gemini accounts exist", async () => {
    const attempt = vi.fn();
    const outcome = await runGeminiRotation({
      listConnections: async () => [],
      attempt,
    });
    expect(outcome).toEqual({ status: "noCredentials" });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("stops immediately on pre-abort, mid-sleep abort (real timer), and in-flight attempt abort", async () => {
    const conns = [makeConn("A", 1), makeConn("B", 2)];
    const onError = vi.fn(async () => {});

    // 1. Pre-aborted
    const ac1 = new AbortController();
    ac1.abort();
    const attempt1 = vi.fn();
    const res1 = await runGeminiRotation({
      signal: ac1.signal,
      listConnections: async () => conns,
      attempt: attempt1,
      onError,
    });
    expect(res1).toEqual({ status: "aborted" });
    expect(attempt1).not.toHaveBeenCalled();

    // 2. Abort during 30s sleep using fake timers + real abortableSleep
    vi.useFakeTimers();
    const ac2 = new AbortController();
    const attempt2 = vi.fn(async () => ({ ok: false, status: 429, errorText: "rate limit" }));
    const p2 = runGeminiRotation({
      signal: ac2.signal,
      listConnections: async () => conns,
      buildCredentials: async (c) => ({ connectionId: c.id }),
      onError,
      attempt: attempt2,
    });
    await vi.advanceTimersByTimeAsync(1000); // now sleeping 30s after A returned 429
    ac2.abort();
    const res2 = await p2;
    expect(res2).toEqual({ status: "aborted" });
    expect(attempt2).toHaveBeenCalledTimes(1); // B was never tried
    vi.useRealTimers();

    // 3. Abort while attempt() is in-flight -> does NOT call onError or advance cursor
    onError.mockClear();
    const ac3 = new AbortController();
    const res3 = await runGeminiRotation({
      signal: ac3.signal,
      listConnections: async () => conns,
      buildCredentials: async (c) => ({ connectionId: c.id }),
      onError,
      attempt: async () => {
        ac3.abort();
        return { ok: false, status: 499, errorText: "aborted" };
      },
    });
    expect(res3).toEqual({ status: "aborted" });
    expect(onError).not.toHaveBeenCalled();
    expect(getGeminiRotationCursor("gemini")).toBeNull();
  });

  it("re-reads fresh connection state on cycle 2+ (skips disabled account and passes updated DB row to onSuccess)", async () => {
    const store = new Map([
      ["A", makeConn("A", 1, { testStatus: "active" })],
      ["B", makeConn("B", 2, { testStatus: "active" })],
    ]);
    const calls = [];
    const recoveredConns = [];

    const outcome = await runGeminiRotation({
      listConnections: async () => [...store.values()].filter((c) => c.isActive),
      buildCredentials: async (c) => ({ connectionId: c.id, _connection: c }),
      sleep: async () => true,
      onError: async (id, status, msg) => {
        const cur = store.get(id);
        store.set(id, { ...cur, testStatus: "unavailable", lastError: msg, errorCode: status });
      },
      onSuccess: async (conn) => {
        recoveredConns.push(conn);
      },
      attempt: async (creds, { cycle }) => {
        calls.push(`${cycle}:${creds.connectionId}`);
        if (cycle === 0 && creds.connectionId === "A") {
          return { ok: false, status: 429, errorText: "rate limited" };
        }
        if (cycle === 0 && creds.connectionId === "B") {
          // Disable B right as it fails Cycle 0
          store.set("B", { ...store.get("B"), isActive: false });
          return { ok: false, status: 500, errorText: "server error" };
        }
        return { ok: true, response: new Response("ok", { status: 200 }) };
      },
    });

    expect(outcome.status).toBe("ok");
    expect(calls).toEqual(["0:A", "0:B", "1:A"]);
    expect(recoveredConns).toHaveLength(1);
    expect(recoveredConns[0].id).toBe("A");
    expect(recoveredConns[0].testStatus).toBe("unavailable");
  });

  it("does not crash rotation if onError or onSuccess throws", async () => {
    const conns = [makeConn("A", 1), makeConn("B", 2)];
    const warn = vi.fn();
    const outcome = await runGeminiRotation({
      listConnections: async () => conns,
      buildCredentials: async (c) => ({ connectionId: c.id }),
      sleep: async () => true,
      log: { info: vi.fn(), warn },
      onError: async () => {
        throw new Error("DB locked");
      },
      onSuccess: async () => {
        throw new Error("DB busy");
      },
      attempt: async (creds) => {
        if (creds.connectionId === "A") {
          return { ok: false, status: 500, errorText: "fail" };
        }
        return { ok: true, response: new Response("ok", { status: 200 }) };
      },
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.connection.id).toBe("B");
    expect(warn).toHaveBeenCalled();
  });

  it("treats priority 0 as highest priority instead of falling back to 999", () => {
    const conns = [makeConn("A", 1), makeConn("Z", 0), makeConn("B", 2)];
    expect(orderFromCursor(conns, null).map((c) => c.id)).toEqual(["Z", "A", "B"]);
    expect(orderFromCursor(conns, "Z").map((c) => c.id)).toEqual(["A", "B", "Z"]);
  });

  it("cancels upstream response body and aborts if signal fires right as attempt resolves ok", async () => {
    const ac = new AbortController();
    const cancel = vi.fn(async () => {});
    const response = {
      status: 200,
      body: { cancel },
    };

    const outcome = await runGeminiRotation({
      listConnections: async () => [makeConn("A", 1), makeConn("B", 2)],
      buildCredentials: async (c) => ({ connectionId: c.id }),
      signal: ac.signal,
      sleep: async () => true,
      attempt: async () => {
        ac.abort(new Error("client closed"));
        return { ok: true, response };
      },
    });

    expect(outcome.status).toBe("aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getGeminiRotationCursor("gemini")).toBeNull();
  });

  it("treats status 499 from attempt as aborted even when outer signal is not aborted", async () => {
    const onError = vi.fn(async () => {});
    const attempt = vi.fn(async () => ({
      ok: false,
      status: 499,
      errorText: "Request aborted",
    }));

    const outcome = await runGeminiRotation({
      listConnections: async () => [makeConn("A", 1), makeConn("B", 2)],
      buildCredentials: async (c) => ({ connectionId: c.id }),
      onError,
      attempt,
    });

    expect(outcome).toEqual({ status: "aborted" });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(getGeminiRotationCursor("gemini")).toBeNull();
  });

  it("BaseExecutor aborts immediately on custom non-AbortError signal reason without 502 retry", async () => {
    const ac = new AbortController();
    proxyFetchMocks.proxyAwareFetch.mockReset();
    proxyFetchMocks.proxyAwareFetch.mockImplementation(async () => {
      ac.abort(new Error("custom-client-gone"));
      throw new Error("socket hang up");
    });

    const executor = new DefaultExecutor("gemini");
    await expect(
      executor.execute({
        model: "gemini-2.5-flash",
        body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        stream: false,
        credentials: { apiKey: "test-key", authType: "apikey" },
        signal: ac.signal,
      })
    ).rejects.toThrow("socket hang up");

    expect(proxyFetchMocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
