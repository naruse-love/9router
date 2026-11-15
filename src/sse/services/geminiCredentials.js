import { updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

export async function buildCredentialsFromConnection(connection) {
  const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

  return {
    authType: connection.authType,
    apiKey: connection.apiKey,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt,
    expiresIn: connection.expiresIn,
    lastRefreshAt: connection.lastRefreshAt,
    projectId: connection.projectId,
    connectionName: connection.displayName || connection.name || connection.email || connection.id,
    copilotToken: connection.providerSpecificData?.copilotToken,
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
      connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
      connectionProxyUrl: resolvedProxy.connectionProxyUrl,
      connectionNoProxy: resolvedProxy.connectionNoProxy,
      connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
      vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      strictProxy: resolvedProxy.strictProxy === true,
    },
    connectionId: connection.id,
    testStatus: connection.testStatus,
    lastError: connection.lastError,
    _connection: connection,
  };
}

export async function recordAccountError(connectionId, status, errorText) {
  const message =
    typeof errorText === "string" && errorText.trim()
      ? errorText.trim().slice(0, 500)
      : status
        ? `HTTP ${status}`
        : "Unknown error";

  await updateProviderConnection(connectionId, {
    testStatus: "unavailable",
    lastError: message,
    errorCode: status ?? null,
    lastErrorAt: new Date().toISOString(),
  });
}
