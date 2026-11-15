import { GEMINI_ROTATION } from "open-sse/config/runtimeConfig.js";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { getProviderConnections } from "@/lib/localDb";
import { clearAccountError } from "./auth.js";
import {
  buildCredentialsFromConnection,
  recordAccountError,
} from "./geminiCredentials.js";

/**
 * In-memory per-provider cursor storing the ID of the last successful connection.
 * Anchored on globalThis via Symbol.for so separate Next.js route chunks / HMR reloads
 * share the same cursor within a process, while still resetting on process restart.
 */
const CURSORS_SYMBOL = Symbol.for("9router.geminiRotation.cursors");
const cursors = globalThis[CURSORS_SYMBOL] || (globalThis[CURSORS_SYMBOL] = new Map());

export function isGeminiRotationProvider(providerId) {
  return providerId === GEMINI_ROTATION.providerId;
}

export function getGeminiRotationCursor(providerId = GEMINI_ROTATION.providerId) {
  return cursors.get(providerId) ?? null;
}

export function resetGeminiRotationCursors() {
  cursors.clear();
}

export function orderFromCursor(connections, lastSuccessId) {
  if (!Array.isArray(connections) || connections.length === 0) return [];
  const sorted = [...connections].sort(
    (a, b) => (a?.priority ?? 999) - (b?.priority ?? 999)
  );
  if (!lastSuccessId) return sorted;

  const idx = sorted.findIndex((c) => c?.id === lastSuccessId);
  if (idx === -1) return sorted;

  return [...sorted.slice(idx + 1), ...sorted.slice(0, idx + 1)];
}

export function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  if (!ms || ms <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getSafeConnLabel(conn) {
  return conn?.displayName || conn?.name || conn?.email || conn?.id || "unknown";
}

function logEvent(log, level, message, data) {
  if (log && typeof log[level] === "function") {
    log[level]("GEMINI_ROTATION", message, data);
  }
}

export async function runGeminiRotation({
  providerId = GEMINI_ROTATION.providerId,
  model = null,
  signal = null,
  attempt,
  onSuccess = async (conn) => clearAccountError(conn.id, conn, model),
  onError = recordAccountError,
  listConnections = () =>
    getProviderConnections({ provider: providerId, isActive: true }),
  buildCredentials = buildCredentialsFromConnection,
  sleep = abortableSleep,
  waitMs = GEMINI_ROTATION.waitMs,
  cycles = GEMINI_ROTATION.cycles,
  waitStatuses = GEMINI_ROTATION.waitStatuses,
  log = null,
}) {
  if (signal?.aborted) {
    return { status: "aborted" };
  }

  const initialConns = await listConnections();
  if (!initialConns || initialConns.length === 0) {
    return { status: "noCredentials" };
  }

  const cursorId = cursors.get(providerId) || null;
  const orderedIds = orderFromCursor(initialConns, cursorId).map((c) => c.id);
  const initialById = new Map(initialConns.map((c) => [c.id, c]));

  let lastFailure = null;

  for (let cycle = 0; cycle < cycles; cycle++) {
    let connById;
    if (cycle === 0) {
      connById = initialById;
    } else {
      const latestConns = await listConnections();
      connById = new Map((latestConns || []).map((c) => [c.id, c]));
    }

    const cycleConns = orderedIds.map((id) => connById.get(id)).filter(Boolean);
    if (cycleConns.length === 0) {
      break;
    }

    for (let i = 0; i < cycleConns.length; i++) {
      if (signal?.aborted) {
        return { status: "aborted" };
      }

      const conn = cycleConns[i];
      const connLabel = getSafeConnLabel(conn);
      const credentials = await buildCredentials(conn);

      if (signal?.aborted) {
        return { status: "aborted" };
      }

      let result;
      try {
        result = await attempt(credentials, {
          cycle,
          index: i,
          connection: conn,
        });
      } catch (err) {
        if (signal?.aborted) {
          return { status: "aborted" };
        }
        throw err;
      }

      if (signal?.aborted) {
        if (result?.ok) {
          result.response?.body?.cancel?.().catch?.(() => {});
        }
        return { status: "aborted" };
      }

      if (result?.ok) {
        cursors.set(providerId, conn.id);
        if (typeof onSuccess === "function") {
          try {
            await onSuccess(conn, credentials, result);
          } catch (err) {
            logEvent(log, "warn", `onSuccess cleanup failed for ${connLabel}`, {
              error: err?.message,
            });
          }
        }
        logEvent(log, "info", `Succeeded on cycle ${cycle + 1}/${cycles}`, {
          connectionId: conn.id,
          connection: connLabel,
          model,
        });
        return {
          status: "ok",
          response: result.response,
          connection: conn,
        };
      }

      const failureStatus = result?.status ?? 500;
      if (failureStatus === 499) {
        return { status: "aborted" };
      }

      const failureText = result?.errorText || "";
      const fallbackCheck = checkFallbackError(
        failureStatus,
        failureText,
        0,
        providerId
      );
      const isRequestScoped =
        result?.requestScoped === true || fallbackCheck?.requestScoped === true;

      if (isRequestScoped) {
        logEvent(log, "warn", `Request-scoped error ${failureStatus}, aborting rotation`, {
          connectionId: conn.id,
          model,
        });
        return {
          status: "requestError",
          response: result?.response,
          errorText: failureText,
          httpStatus: failureStatus,
        };
      }

      if (typeof onError === "function") {
        try {
          await onError(conn.id, failureStatus, failureText);
        } catch (err) {
          logEvent(log, "warn", `Failed to record account error for ${connLabel}`, {
            error: err?.message,
          });
        }
      }

      lastFailure = {
        response: result?.response,
        errorText: failureText,
        httpStatus: failureStatus,
      };

      const isLastAttempt =
        cycle === cycles - 1 && i === cycleConns.length - 1;
      const shouldWait =
        !isLastAttempt &&
        Array.isArray(waitStatuses) &&
        waitStatuses.includes(failureStatus);

      if (shouldWait) {
        logEvent(
          log,
          "warn",
          `Account ${connLabel} returned ${failureStatus} (cycle ${cycle + 1}/${cycles}, #${i + 1}/${cycleConns.length}), waiting ${waitMs}ms before next account`,
          { connectionId: conn.id, model, status: failureStatus }
        );
        const completedSleep = await sleep(waitMs, signal);
        if (!completedSleep || signal?.aborted) {
          logEvent(log, "info", "Client disconnected during wait, aborting rotation", {
            connectionId: conn.id,
            model,
          });
          return { status: "aborted" };
        }
      } else if (!isLastAttempt) {
        logEvent(
          log,
          "warn",
          `Account ${connLabel} returned ${failureStatus} (cycle ${cycle + 1}/${cycles}, #${i + 1}/${cycleConns.length}), switching immediately`,
          { connectionId: conn.id, model, status: failureStatus }
        );
      }
    }
  }

  if (!lastFailure) {
    return { status: "noCredentials" };
  }

  logEvent(log, "warn", `All ${cycles} rotation cycles exhausted`, {
    model,
    lastStatus: lastFailure.httpStatus,
  });

  return {
    status: "exhausted",
    response: lastFailure.response,
    errorText: lastFailure.errorText,
    httpStatus: lastFailure.httpStatus,
  };
}
