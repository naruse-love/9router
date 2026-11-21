import { SSE_DONE, SSE_HEADERS_CORS } from "open-sse/utils/sseConstants.js";

export const STREAM_STATUS_HEADER = "x-9router-stream-status";

const sharedEncoder = new TextEncoder();

/**
 * Read a header value case-insensitively from either a Fetch Headers instance
 * or a plain object map.
 */
function getHeaderValue(headers, targetName) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(targetName);
  }
  if (typeof headers === "object") {
    const lowerTarget = targetName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === lowerTarget) {
        return Array.isArray(value) ? value[0] : value;
      }
    }
  }
  return null;
}

/**
 * Determine whether the caller opted into immediate SSE headers, keepalive pings,
 * and inline `_9r_status` status events.
 * Enabled when `X-9Router-Stream-Status` is "1" or "true" (case-insensitive)
 * and the request is streaming (`body?.stream !== false`).
 */
export function wantsStreamStatus(request, body) {
  if (body?.stream === false) return false;
  const raw = getHeaderValue(request?.headers, STREAM_STATUS_HEADER);
  if (raw === null || raw === undefined) return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

async function extractErrorMessage(response) {
  const rawText = await response.text().catch(() => "");
  let msg = rawText;

  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      const errObj = parsed?.error;
      if (errObj && typeof errObj === "object") {
        msg = errObj.message || errObj.error || (typeof parsed.message === "string" ? parsed.message : rawText);
      } else if (typeof errObj === "string") {
        msg = errObj;
      } else if (typeof parsed?.message === "string") {
        msg = parsed.message;
      }
    } catch {
      // Non-JSON error body; fall back to raw text
    }
  }

  if (typeof msg !== "string") {
    try {
      msg = JSON.stringify(msg);
    } catch {
      msg = String(msg ?? "");
    }
  }

  return msg.trim() || response.statusText || `HTTP ${response.status}`;
}

function normalizeSingleLineJson(rawText) {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) return "{}";
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return trimmed.replace(/\r?\n/g, " ");
    }
  }
  return trimmed;
}

function isSseDoneLine(trimmedLine) {
  return trimmedLine.startsWith("data:") && trimmedLine.slice(5).trim() === "[DONE]";
}

/**
 * Create an immediate 200 SSE `Response` (0ms TTFB) that emits inline `_9r_status`
 * frames and periodic `: keepalive` comments while `run({ emitStatus, signal })`
 * executes asynchronously.
 */
export function createImmediateStatusStreamResponse({ signal = null, run, keepaliveMs = 15000 }) {
  const internalAbort = new AbortController();
  const validKeepaliveMs = Number.isFinite(keepaliveMs) && keepaliveMs > 0 ? keepaliveMs : 0;

  let streamController = null;
  let closed = false;
  let keepaliveTimer = null;
  let upstreamReader = null;
  let pipingUpstream = false;
  let deferredStatuses = [];
  let onExternalAbort = null;

  const clearKeepalive = () => {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  const cleanupSignal = () => {
    if (signal && onExternalAbort) {
      signal.removeEventListener("abort", onExternalAbort);
      onExternalAbort = null;
    }
  };

  const closeStream = () => {
    if (closed) return;
    closed = true;
    clearKeepalive();
    cleanupSignal();
    try {
      streamController?.close();
    } catch {
      // Controller may already be closed or cancelled
    }
  };

  const scheduleKeepalive = () => {
    clearKeepalive();
    if (closed || !validKeepaliveMs) return;
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      if (closed) return;
      enqueueText(": keepalive\n\n");
    }, validKeepaliveMs);
  };

  const enqueueText = (text) => {
    if (closed || !streamController || !text) return;
    try {
      streamController.enqueue(sharedEncoder.encode(text));
      scheduleKeepalive();
    } catch {
      closeStream();
    }
  };

  const flushDeferredStatuses = () => {
    if (deferredStatuses.length === 0) return;
    const queued = deferredStatuses;
    deferredStatuses = [];
    for (const frame of queued) {
      enqueueText(frame);
    }
  };

  const emitStatus = (payload) => {
    if (closed || internalAbort.signal.aborted) return;
    const frame = `data: ${JSON.stringify({ _9r_status: { ts: Date.now(), ...(payload || {}) } })}\n\n`;
    if (pipingUpstream || payload?.phase === "done") {
      deferredStatuses.push(frame);
      return;
    }
    // A new non-terminal attempt/posting/fallback clears any stale pre-return done
    // from an earlier discarded combo candidate (e.g. empty-peeked leg).
    if (deferredStatuses.length > 0) {
      deferredStatuses = [];
    }
    enqueueText(frame);
  };

  const abortAll = (reason, { closeClientStream = true } = {}) => {
    if (!internalAbort.signal.aborted) {
      internalAbort.abort(reason);
    }
    if (upstreamReader) {
      try {
        upstreamReader.cancel(reason).catch(() => {});
      } catch {
        // Ignore reader cancel errors
      }
    }
    if (closeClientStream) {
      closeStream();
    } else {
      closed = true;
      clearKeepalive();
      cleanupSignal();
    }
  };

  const pipeUpstreamSse = async (body) => {
    pipingUpstream = true;
    upstreamReader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let lineBuffer = "";
    let lastLineWasBlank = true;
    let skipNextBlankLine = false;

    try {
      while (true) {
        if (closed || internalAbort.signal.aborted) {
          try {
            await upstreamReader.cancel(internalAbort.signal.reason);
          } catch {
            // Ignore cancel errors
          }
          return false;
        }

        const { done, value } = await upstreamReader.read();
        if (done) break;
        if (closed || internalAbort.signal.aborted) return false;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        let out = "";
        for (const line of lines) {
          const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
          const trimmed = cleanLine.trim();
          if (isSseDoneLine(trimmed)) {
            if (lastLineWasBlank) {
              skipNextBlankLine = true;
            }
            continue;
          }
          if (skipNextBlankLine && trimmed === "") {
            skipNextBlankLine = false;
            continue;
          }
          skipNextBlankLine = false;
          lastLineWasBlank = trimmed === "";
          out += `${line}\n`;
        }

        if (out.length > 0) {
          enqueueText(out);
        }
      }

      if (closed || internalAbort.signal.aborted) return false;

      const tail = lineBuffer + decoder.decode();
      if (tail.length > 0) {
        const cleanTail = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
        const trimmedTail = cleanTail.trim();
        if (!isSseDoneLine(trimmedTail) && !(skipNextBlankLine && trimmedTail === "")) {
          if (trimmedTail !== "") {
            enqueueText(`${cleanTail}\n\n`);
            lastLineWasBlank = true;
          }
        }
      }

      if (!lastLineWasBlank) {
        enqueueText("\n");
      }
      return true;
    } catch (err) {
      if (closed || internalAbort.signal.aborted || err?.name === "AbortError") {
        return false;
      }
      pipingUpstream = false;
      const msg = err?.message || "Upstream stream interrupted";
      enqueueText(`data: ${JSON.stringify({ error: { code: 502, message: msg } })}\n\n`);
      enqueueText(SSE_DONE);
      closeStream();
      return false;
    } finally {
      pipingUpstream = false;
      try {
        upstreamReader?.releaseLock?.();
      } catch {
        // Reader may already be cancelled/released
      }
      upstreamReader = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;

      if (signal) {
        if (signal.aborted) {
          abortAll(signal.reason, { closeClientStream: true });
          return;
        }
        onExternalAbort = () => abortAll(signal.reason, { closeClientStream: true });
        signal.addEventListener("abort", onExternalAbort, { once: true });
      }

      scheduleKeepalive();

      (async () => {
        try {
          const finalResponse = await run({ emitStatus, signal: internalAbort.signal });
          if (closed || internalAbort.signal.aborted) {
            finalResponse?.body?.cancel?.().catch?.(() => {});
            closeStream();
            return;
          }

          if (!finalResponse) {
            deferredStatuses = [];
            enqueueText(SSE_DONE);
            closeStream();
            return;
          }

          if (!finalResponse.ok) {
            const msg = await extractErrorMessage(finalResponse);
            if (closed || internalAbort.signal.aborted) {
              closeStream();
              return;
            }
            deferredStatuses = [];
            enqueueText(`data: ${JSON.stringify({ error: { code: finalResponse.status, message: msg } })}\n\n`);
            enqueueText(SSE_DONE);
            closeStream();
            return;
          }

          const contentType = (finalResponse.headers?.get?.("content-type") || "").toLowerCase();
          if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
            const rawJson = await finalResponse.text().catch(() => "");
            if (closed || internalAbort.signal.aborted) {
              closeStream();
              return;
            }
            flushDeferredStatuses();
            enqueueText(`data: ${normalizeSingleLineJson(rawJson)}\n\n`);
            enqueueText(SSE_DONE);
            closeStream();
            return;
          }

          if (finalResponse.body) {
            const completedCleanly = await pipeUpstreamSse(finalResponse.body);
            if (!completedCleanly || closed || internalAbort.signal.aborted) {
              closeStream();
              return;
            }
          }

          flushDeferredStatuses();
          enqueueText(SSE_DONE);
          closeStream();
        } catch (err) {
          if (!closed && !internalAbort.signal.aborted && err?.name !== "AbortError") {
            const msg = err?.message || "Internal server error";
            enqueueText(`data: ${JSON.stringify({ error: { code: 500, message: msg } })}\n\n`);
            enqueueText(SSE_DONE);
          }
          closeStream();
        }
      })();
    },

    cancel(reason) {
      abortAll(reason || "cancelled", { closeClientStream: false });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: SSE_HEADERS_CORS,
  });
}
