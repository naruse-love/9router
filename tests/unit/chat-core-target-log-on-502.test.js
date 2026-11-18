import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("handleChatCore target & error logging on 502/499 execute failure", () => {
  const savedEnv = { ...process.env };
  let tempDir;
  let cwdSpy;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv, ENABLE_REQUEST_LOGS: "true" };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-reqlog-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    process.env = { ...savedEnv };
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    vi.doUnmock("../../open-sse/executors/index.js");
    vi.doUnmock("@/lib/usageDb.js");
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes 1_req_client, 2_req_source, 4_req_target, and 6_error (with cause) when Gemini BaseExecutor throws 502", async () => {
    const undiciErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const proxyAwareFetchMock = vi.fn().mockRejectedValue(undiciErr);
    const saveRequestDetailMock = vi.fn(async () => {});
    const appendRequestLogMock = vi.fn(async () => {});
    const trackPendingRequestMock = vi.fn();

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: proxyAwareFetchMock,
    }));
    vi.doMock("@/lib/usageDb.js", () => ({
      trackPendingRequest: trackPendingRequestMock,
      appendRequestLog: appendRequestLogMock,
      saveRequestDetail: saveRequestDetailMock,
    }));

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");

    expect(PROVIDERS.gemini.timeoutMs).toBe(180000);
    expect(PROVIDERS.gemini.retry[502]).toEqual({ attempts: 1, delayMs: 1000 });

    const clientBody = {
      model: "gemini/gemini-2.5-flash",
      stream: true,
      messages: [{ role: "user", content: "hello gemini" }],
    };

    const result = await handleChatCore({
      body: clientBody,
      modelInfo: { provider: "gemini", model: "gemini-2.5-flash" },
      credentials: { apiKey: "gem-secret-key", authType: "apikey", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
      connectionId: "conn-gem-1",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: clientBody,
        headers: { "content-type": "application/json" },
      },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("fetch failed");
    expect(result.error).toContain("UND_ERR_SOCKET");
    expect(result.error).toContain("other side closed");

    // Gemini retry[502].attempts = 1 -> initial attempt + 1 fresh-socket retry = 2 fetches
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetchMock.mock.calls[1][2]).toMatchObject({ forceFreshSocket: true });

    const logsRoot = path.join(tempDir, "logs");
    const sessions = fs.readdirSync(logsRoot);
    expect(sessions).toHaveLength(1);
    const sessionDir = path.join(logsRoot, sessions[0]);
    const files = fs.readdirSync(sessionDir).sort();
    expect(files).toEqual([
      "1_req_client.json",
      "2_req_source.json",
      "4_req_target.json",
      "6_error.json",
    ]);

    const targetLog = JSON.parse(fs.readFileSync(path.join(sessionDir, "4_req_target.json"), "utf8"));
    expect(targetLog.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
    expect(targetLog.headers["x-goog-api-key"]).toBe("gem-secret-key");
    expect(targetLog.body.contents).toEqual([
      { role: "user", parts: [{ text: "hello gemini" }] },
    ]);

    const errorLog = JSON.parse(fs.readFileSync(path.join(sessionDir, "6_error.json"), "utf8"));
    expect(errorLog.error).toBe("fetch failed");
    expect(errorLog.cause).toEqual({
      code: "UND_ERR_SOCKET",
      message: "other side closed",
    });
    expect(errorLog.stack).toContain("fetch failed");
    expect(errorLog.requestBody).toEqual(targetLog.body);

    expect(saveRequestDetailMock).toHaveBeenCalledOnce();
    const detail = saveRequestDetailMock.mock.calls[0][0];
    expect(detail.status).toBe("error");
    expect(detail.statusCode).toBe(502);
    expect(detail.providerRequest).toEqual(targetLog.body);
    expect(detail.response.error).toContain("UND_ERR_SOCKET");
  });

  it("writes 4_req_target and 6_error with 499 status when clientSignal aborts during execute", async () => {
    const ac = new AbortController();
    const proxyAwareFetchMock = vi.fn().mockImplementation(async () => {
      ac.abort(new Error("client closed"));
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    const saveRequestDetailMock = vi.fn(async () => {});

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: proxyAwareFetchMock,
    }));
    vi.doMock("@/lib/usageDb.js", () => ({
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(async () => {}),
      saveRequestDetail: saveRequestDetailMock,
    }));

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore({
      body: { model: "gemini/gemini-2.5-flash", stream: false, messages: [{ role: "user", content: "abort me" }] },
      modelInfo: { provider: "gemini", model: "gemini-2.5-flash" },
      credentials: { apiKey: "gem-secret-key", authType: "apikey", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
      connectionId: "conn-gem-abort",
      clientSignal: ac.signal,
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);

    const logsRoot = path.join(tempDir, "logs");
    const sessionDir = path.join(logsRoot, fs.readdirSync(logsRoot)[0]);
    expect(fs.existsSync(path.join(sessionDir, "4_req_target.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "6_error.json"))).toBe(true);
    expect(saveRequestDetailMock.mock.calls[0][0].statusCode).toBe(499);
  });

  it("keeps fallback logTargetRequest on custom executors that omit onTargetRequest and handles circular/code-only error causes", async () => {
    const customExecute = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
        url: "https://custom.example/v1/chat",
        headers: { "x-custom": "1" },
        transformedBody: { custom: true },
      })
      .mockRejectedValueOnce((() => {
        const inner = { code: "ECONNRESET" };
        const err = new Error("socket closed");
        err.cause = inner;
        return err;
      })());

    vi.doMock("../../open-sse/executors/index.js", () => ({
      getExecutor: () => ({
        noAuth: true,
        execute: customExecute,
      }),
    }));
    vi.doMock("@/lib/usageDb.js", () => ({
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(async () => {}),
      saveRequestDetail: vi.fn(async () => {}),
    }));

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");

    // 1. Custom executor succeeds without calling onTargetRequest -> fallback still writes 4_req_target.json
    const okRes = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "k", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "c1",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
    });
    expect(okRes.success).toBe(true);

    // 2. Custom executor throws with code-only cause -> 6_error.json preserves code without "[object Object]"
    const errRes = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "k", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
      connectionId: "c2",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
    });
    expect(errRes.success).toBe(false);
    expect(errRes.status).toBe(502);

    const logsRoot = path.join(tempDir, "logs");
    const sessions = fs.readdirSync(logsRoot).sort();
    expect(sessions.length).toBe(2);
    const hasCustomTarget = sessions.some((s) => {
      const p = path.join(logsRoot, s, "4_req_target.json");
      return fs.existsSync(p) && JSON.parse(fs.readFileSync(p, "utf8")).url === "https://custom.example/v1/chat";
    });
    expect(hasCustomTarget).toBe(true);

    const errSession = sessions.find((s) => fs.existsSync(path.join(logsRoot, s, "6_error.json")));
    const errJson = JSON.parse(fs.readFileSync(path.join(logsRoot, errSession, "6_error.json"), "utf8"));
    expect(errJson.cause).toEqual({ code: "ECONNRESET" });

    // 3. Direct circular cause check on requestLogger.logError (stops immediately on cycle)
    const directLogger = await createRequestLogger("openai", "openai", "gpt-4o");
    const circular = new Error("outer");
    const causeErr = new Error("inner");
    causeErr.cause = causeErr;
    circular.cause = causeErr;
    directLogger.logError(circular, { test: 1 });
    const directErrJson = JSON.parse(fs.readFileSync(path.join(directLogger.sessionPath, "6_error.json"), "utf8"));
    expect(directErrJson.error).toBe("outer");
    expect(directErrJson.cause.message).toBe("inner");
    expect(directErrJson.cause.cause).toBeUndefined();
  });

  it("serializes AggregateError.errors and nested ProxyConnectionError causes in 6_error.json and formatProviderError", async () => {
    const aggErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(
        new AggregateError(
          [
            Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), { code: "ECONNREFUSED" }),
            Object.assign(new Error("connect EACCES ::1:7890"), { code: "EACCES" }),
          ],
          ""
        ),
        { code: "ECONNREFUSED" }
      ),
    });

    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const { formatProviderError } = await import("../../open-sse/utils/error.js");

    const logger = await createRequestLogger("openai", "gemini", "gemini-2.5-flash");
    logger.logError(aggErr, { contents: [] });
    const aggJson = JSON.parse(fs.readFileSync(path.join(logger.sessionPath, "6_error.json"), "utf8"));
    expect(aggJson.cause.code).toBe("ECONNREFUSED");
    expect(aggJson.cause.errors).toHaveLength(2);
    expect(aggJson.cause.errors[0].message).toContain("127.0.0.1:7890");

    const formattedAgg = formatProviderError(aggErr, "gemini", "gemini-2.5-flash", 502);
    expect(formattedAgg).toContain("connect ECONNREFUSED 127.0.0.1:7890");

    const nestedProxyErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Proxy Connection failed"), {
        code: "UND_ERR_PRX_CONN",
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
    });
    const formattedProxy = formatProviderError(nestedProxyErr, "gemini", "gemini-2.5-flash", 502);
    expect(formattedProxy).toContain("UND_ERR_PRX_CONN");
    expect(formattedProxy).toContain("UND_ERR_SOCKET: other side closed");
  });

  it("does not misclassify BaseExecutor internal connect timeout AbortError as 499 when clientSignal is not aborted", async () => {
    const proxyAwareFetchMock = vi.fn().mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const abortErr = Object.assign(new Error("fetch connect timeout"), { name: "AbortError" });
        reject(abortErr);
      });
    }));

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: proxyAwareFetchMock,
    }));
    vi.doMock("@/lib/usageDb.js", () => ({
      trackPendingRequest: vi.fn(),
      appendRequestLog: vi.fn(async () => {}),
      saveRequestDetail: vi.fn(async () => {}),
    }));

    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    const savedTimeout = PROVIDERS.gemini.timeoutMs;
    PROVIDERS.gemini.timeoutMs = 15;
    PROVIDERS.gemini.retry[502] = { attempts: 1, delayMs: 0 };

    try {
      const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
      const clientCtrl = new AbortController();
      const result = await handleChatCore({
        body: { model: "gemini/gemini-2.5-flash", stream: true, messages: [{ role: "user", content: "slow" }] },
        modelInfo: { provider: "gemini", model: "gemini-2.5-flash" },
        credentials: { apiKey: "gem-secret", authType: "apikey", providerSpecificData: {} },
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
        connectionId: "conn-timeout-502",
        clientSignal: clientCtrl.signal,
        rtkEnabled: false,
        headroomEnabled: false,
        cavemanEnabled: false,
        ponytailEnabled: false,
        clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(proxyAwareFetchMock).toHaveBeenCalledTimes(2);
      const logsRoot = path.join(tempDir, "logs");
      const sessionDir = path.join(logsRoot, fs.readdirSync(logsRoot)[0]);
      expect(fs.existsSync(path.join(sessionDir, "4_req_target.json"))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, "6_error.json"))).toBe(true);
    } finally {
      PROVIDERS.gemini.timeoutMs = savedTimeout;
      PROVIDERS.gemini.retry[502] = { attempts: 1, delayMs: 1000 };
    }
  });
});
