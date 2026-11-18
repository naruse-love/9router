import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("undici keep-alive dead-socket protection & fresh-socket retry", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.FETCH_KEEPALIVE_TIMEOUT_MS;
    delete process.env.FETCH_FRESH_RETRY;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.doUnmock("undici");
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });

  it("keeps the existing 4s default, clamps keepAliveMaxTimeout, and honors FETCH_KEEPALIVE_TIMEOUT_MS", async () => {
    const { resolveKeepAliveTimeouts } = await import("../../open-sse/config/runtimeConfig.js");

    expect(resolveKeepAliveTimeouts()).toEqual({
      keepAliveTimeout: 4_000,
      keepAliveMaxTimeout: 4_000,
    });

    process.env.FETCH_KEEPALIVE_TIMEOUT_MS = "1";
    expect(resolveKeepAliveTimeouts()).toEqual({
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    });
  });

  it("creates distinct shared direct and fresh-retry dispatchers", async () => {
    const {
      getDirectDispatcher,
      getFreshRetryDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const direct1 = await getDirectDispatcher(false);
    const direct2 = await getDirectDispatcher(false);
    const fresh1 = await getFreshRetryDispatcher(false);
    const fresh2 = await getFreshRetryDispatcher(false);

    expect(direct1).not.toBeNull();
    expect(direct1).toBe(direct2);
    expect(fresh1).not.toBeNull();
    expect(fresh1).toBe(fresh2);
    expect(fresh1).not.toBe(direct1);
  });

  it("classifies only provable dead-socket errors and excludes aborts/DNS/TLS/bare fetch failed", async () => {
    const { isStaleSocketError } = await import("../../open-sse/utils/proxyFetch.js");

    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "EPIPE" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: new Error("other side closed") }))).toBe(true);
    expect(isStaleSocketError(new Error("socket hang up"))).toBe(true);

    // A bare "fetch failed" with no code is ambiguous: the upstream may already have the
    // request, so replaying it could double-charge. Never treat it as a stale socket.
    expect(isStaleSocketError(new TypeError("fetch failed"))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_INVALID_ARG" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("aborted"), { name: "AbortError", cause: { code: "UND_ERR_SOCKET" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }))).toBe(false);
    expect(isStaleSocketError(null)).toBe(false);
  });

  it("replays once on the fresh-socket dispatcher when a pooled socket dies", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))
      .mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const {
      proxyAwareFetch,
      getDirectDispatcher,
      getFreshRetryDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const res = await proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer nvapi-test" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const directDispatcher = await getDirectDispatcher(false);
    const freshDispatcher = await getFreshRetryDispatcher(false);

    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(directDispatcher);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(freshDispatcher);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer nvapi-test" });
  });

  it("does not replay on the fresh socket when the caller aborted or the body is a locked stream", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const controller = new AbortController();
    controller.abort();
    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay on an ambiguous bare fetch failed (request may have been served)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay when FETCH_FRESH_RETRY=off", async () => {
    process.env.FETCH_FRESH_RETRY = "off";
    const fetchMock = vi.fn()
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the fresh-socket dispatcher immediately when forceFreshSocket is requested", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, getFreshRetryDispatcher, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await proxyAwareFetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { forceFreshSocket: true }
    );

    const freshDispatcher = await getFreshRetryDispatcher(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(freshDispatcher);
  });

  it("BaseExecutor.execute sets forceFreshSocket=true when retrying after connect timeout or 502", async () => {
    const fetchMock = vi.fn();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const ex = new BaseExecutor("nvidia", {
      baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
      timeoutMs: 15,
      retry: { 502: { attempts: 2, delayMs: 0 } },
    });

    fetchMock
      .mockImplementationOnce((_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("fetch connect timeout");
          err.name = "AbortError";
          reject(err);
        });
      }))
      .mockResolvedValueOnce({ status: 200, headers: { get: () => "application/json" } });

    const out = await ex.execute({
      model: "deepseek-ai/deepseek-v4-flash",
      body: { messages: [] },
      stream: true,
      credentials: { apiKey: "nvapi-key" },
    });

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][2]).toBeNull();
    expect(fetchMock.mock.calls[1][2]).toEqual({ forceFreshSocket: true });
  });

  it("DefaultExecutor.transformRequest strips stream_options on non-streaming calls without mutating input body", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("nvidia");
    const input = {
      model: "deepseek-ai/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
    };

    const nonStreamBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input, false, { apiKey: "nvapi-x" });
    expect(nonStreamBody.stream_options).toBeUndefined();
    expect(input.stream_options).toEqual({ include_usage: true });

    const omittedStreamArgBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input);
    expect(omittedStreamArgBody.stream_options).toBeUndefined();

    const streamBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input, true, { apiKey: "nvapi-x" });
    expect(streamBody.stream_options).toEqual({ include_usage: true });
  });

  it("ProxyAgent receives clamped keepAliveTimeout/keepAliveMaxTimeout and distinct fresh dispatcher when forceFreshSocket is true", async () => {
    const proxyAgentCalls = [];
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      class SpyProxyAgent extends actual.ProxyAgent {
        constructor(opts) {
          proxyAgentCalls.push(opts);
          super(opts);
        }
      }
      return { ...actual, ProxyAgent: SpyProxyAgent };
    });

    const { getProxyDispatcher, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const pooled1 = await getProxyDispatcher("http://127.0.0.1:7890", false, false);
    const pooled2 = await getProxyDispatcher("http://127.0.0.1:7890", false, false);
    const fresh = await getProxyDispatcher("http://127.0.0.1:7890", false, true);

    expect(pooled1).toBe(pooled2);
    expect(fresh).not.toBe(pooled1);
    expect(proxyAgentCalls).toHaveLength(2);
    expect(proxyAgentCalls[0].keepAliveTimeout).toBe(4_000);
    expect(proxyAgentCalls[0].keepAliveMaxTimeout).toBe(4_000);
    expect(proxyAgentCalls[1].keepAliveTimeout).toBe(1);
    expect(proxyAgentCalls[1].keepAliveMaxTimeout).toBe(1);

    await pooled1.close();
    await fresh.close();
  });

  it("replays stale-socket error (UND_ERR_SOCKET) once on a fresh proxy dispatcher without falling back to direct", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))
      .mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const {
      proxyAwareFetch,
      getProxyDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const proxyOpts = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890", strictProxy: true };
    const res = await proxyAwareFetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      proxyOpts
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pooledProxyDispatcher = await getProxyDispatcher("http://127.0.0.1:7890", false, false);
    const freshProxyDispatcher = await getProxyDispatcher("http://127.0.0.1:7890", false, true);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(pooledProxyDispatcher);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(freshProxyDispatcher);
  });

  it("does not fall back to direct or wrap AbortError when options.signal is aborted with proxyUrl", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      controller.abort(new Error("fetch connect timeout"));
      const err = new Error("fetch connect timeout");
      err.name = "AbortError";
      throw opts.signal.reason || err;
    });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    // Non-strict proxy: aborted signal must NOT fall back to direct fetch
    await expect(
      proxyAwareFetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: "{}", signal: controller.signal },
        { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890", strictProxy: false }
      )
    ).rejects.toThrow("fetch connect timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Strict proxy: aborted AbortError must NOT be wrapped into a generic strictProxy Error
    const abortCtrl = new AbortController();
    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    fetchMock.mockReset().mockImplementation(async () => {
      abortCtrl.abort(abortErr);
      throw abortErr;
    });
    await expect(
      proxyAwareFetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: "{}", signal: abortCtrl.signal },
        { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890", strictProxy: true }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("BaseExecutor.execute detects connect timeout when connectCtrl.abort(new Error(...)) produces error.name === 'Error' and caps retries to 1", async () => {
    const fetchMock = vi.fn();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const ex = new BaseExecutor("gemini", {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      timeoutMs: 15,
      // Even if a provider has retry attempts: 3, connect timeout must cap at 1 retry
      retry: { 502: { attempts: 3, delayMs: 0 } },
    });

    fetchMock.mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        // Real AbortController.abort(new Error("fetch connect timeout")) yields name === "Error"
        reject(new Error("fetch connect timeout"));
      });
    }));

    await expect(
      ex.execute({
        model: "gemini-2.5-flash",
        body: { contents: [] },
        stream: true,
        credentials: { apiKey: "gem-key" },
      })
    ).rejects.toThrow("fetch connect timeout");

    // 1 initial attempt + 1 fresh-socket retry = 2 total (NOT 4)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][2]).toBeNull();
    expect(fetchMock.mock.calls[1][2]).toEqual({ forceFreshSocket: true });
  });

  it("real undici ProxyAgent recovers once through a real loopback HTTP proxy when the first socket resets before headers", async () => {
    const http = await import("node:http");

    // Disable env proxies for deterministic loopback test
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
      upstreamHits++;
      req.resume();
      req.on("end", () => {
        if (upstreamHits === 1) {
          res.socket.resetAndDestroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, attempt: upstreamHits }));
      });
    });

    let proxyHits = 0;
    const proxy = http.createServer((req, res) => {
      proxyHits++;
      const target = new URL(req.url);
      const upReq = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: req.method,
          headers: req.headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(res);
        }
      );
      upReq.on("error", () => {
        // Simulate proxy closing/resetting client socket when upstream dies mid-request
        res.socket.resetAndDestroy();
      });
      req.pipe(upReq);
    });

    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));

    try {
      const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1/models/gemini-2.5-flash:generateContent`;
      const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
      resetDirectDispatchersForTests();

      const res = await proxyAwareFetch(
        upstreamUrl,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        { connectionProxyEnabled: true, connectionProxyUrl: proxyUrl, strictProxy: true }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, attempt: 2 });
      expect(upstreamHits).toBe(2);
      expect(proxyHits).toBe(2);
    } finally {
      await Promise.all([
        new Promise((r) => proxy.close(r)),
        new Promise((r) => upstream.close(r)),
      ]);
    }
  });

  it("classifies and replays ProxyConnectionError wrapping UND_ERR_SOCKET while rejecting AggregateError ECONNREFUSED", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("Proxy Connection failed"), {
            code: "UND_ERR_PRX_CONN",
            cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
          }),
        })
      )
      .mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const {
      isStaleSocketError,
      proxyAwareFetch,
      getProxyDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const aggRefused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(
        new AggregateError([Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })], ""),
        { code: "ECONNREFUSED" }
      ),
    });
    expect(isStaleSocketError(aggRefused)).toBe(false);

    const res = await proxyAwareFetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890", strictProxy: true }
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const freshDispatcher = await getProxyDispatcher("http://127.0.0.1:7890", false, true);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(freshDispatcher);
  });

  it("BaseExecutor.execute aborts retry backoff sleep immediately when signal aborts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("socket down"), { cause: { code: "ECONNRESET" } }));
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const ex = new BaseExecutor("gemini", {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      timeoutMs: 5000,
      retry: { 502: { attempts: 1, delayMs: 5000 } },
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("client cancelled")), 25);
    const t0 = Date.now();
    await expect(
      ex.execute({
        model: "gemini-2.5-flash",
        body: { contents: [] },
        stream: true,
        credentials: { apiKey: "gem-key" },
        signal: ac.signal,
      })
    ).rejects.toThrow("socket down");

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("real undici ProxyAgent recovers over an HTTPS CONNECT tunnel when the first tunnel socket resets before headers", async () => {
    const crypto = await import("node:crypto");
    const https = await import("node:https");
    const http = await import("node:http");
    const net = await import("node:net");

    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    // Generate a minimal self-signed X.509 cert in pure Node for 127.0.0.1
    const derLen = (len) => {
      if (len < 0x80) return Buffer.from([len]);
      const bytes = [];
      for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
      return Buffer.from([0x80 | bytes.length, ...bytes]);
    };
    const derTag = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
    const derSeq = (...items) => derTag(0x30, Buffer.concat(items));
    const derSet = (...items) => derTag(0x31, Buffer.concat(items));
    const derInt = (buf) => derTag(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
    const derOid = (bytes) => derTag(0x06, Buffer.from(bytes));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const sha256RsaOid = derSeq(derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
    const cn = derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derTag(0x0c, Buffer.from("127.0.0.1", "utf8")))));
    const validity = derSeq(derTag(0x17, Buffer.from("250101000000Z", "ascii")), derTag(0x17, Buffer.from("491231235959Z", "ascii")));
    const sanExt = derTag(0xa3, derSeq(derSeq(derOid([0x55, 0x1d, 0x11]), derTag(0x04, derSeq(derTag(0x87, Buffer.from([127, 0, 0, 1])))))));
    const tbs = derSeq(derTag(0xa0, derInt(Buffer.from([2]))), derInt(Buffer.from([1])), sha256RsaOid, cn, validity, cn, spki, sanExt);
    const sig = crypto.sign("RSA-SHA256", tbs, privateKey);
    const certDer = derSeq(tbs, sha256RsaOid, derTag(0x03, Buffer.concat([Buffer.from([0]), sig])));
    const cert = `-----BEGIN CERTIFICATE-----\n${certDer.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
    const key = privateKey.export({ type: "pkcs8", format: "pem" });

    let upstreamHits = 0;
    const upstream = https.createServer({ key, cert }, (req, res) => {
      upstreamHits++;
      req.resume();
      req.on("end", () => {
        if (upstreamHits === 1) {
          res.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tunnelRecovered: true, attempt: upstreamHits }));
      });
    });

    let connectCount = 0;
    const proxy = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on("connect", (req, clientSocket, head) => {
      connectCount++;
      const [host, port] = req.url.split(":");
      const srvSocket = net.connect(Number(port), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) srvSocket.write(head);
        srvSocket.pipe(clientSocket);
        clientSocket.pipe(srvSocket);
      });
      srvSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => srvSocket.destroy());
    });

    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));

    try {
      const upstreamUrl = `https://127.0.0.1:${upstream.address().port}/v1beta/models/gemini-2.5-flash:generateContent`;
      const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
      const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
      resetDirectDispatchersForTests();

      const res = await proxyAwareFetch(
        upstreamUrl,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        { connectionProxyEnabled: true, connectionProxyUrl: proxyUrl, strictProxy: true }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ tunnelRecovered: true, attempt: 2 });
      expect(upstreamHits).toBe(2);
      expect(connectCount).toBeGreaterThanOrEqual(2);
    } finally {
      await Promise.all([
        new Promise((r) => proxy.close(r)),
        new Promise((r) => upstream.close(r)),
      ]);
    }
  });
});
