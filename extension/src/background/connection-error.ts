import { t } from "../shared/i18n";

/**
 * `serverRestarting`: the last connection ended with the server's
 * graceful-shutdown close, so a server that cannot be reached is expected to be
 * the one restarting. It never overrides an authoritative rejection — a server
 * that answered and refused the origin is not restarting.
 */
export function getConnectionErrorMessage(args: {
  healthcheckReachable: boolean;
  extensionOrigin?: string | null;
  reason?: string | null;
  serverRestarting?: boolean;
}): string {
  if (!args.healthcheckReachable) {
    return args.serverRestarting
      ? t("connectionServerRestarting")
      : t("connectionServerUnreachable");
  }

  if (
    args.reason &&
    args.reason !== "origin_not_allowed" &&
    args.reason !== "origin_missing"
  ) {
    return t("connectionHandshakeRejected");
  }

  const extensionOrigin = args.extensionOrigin?.trim();
  if (extensionOrigin) {
    return t("connectionOriginRejected", { extensionOrigin });
  }

  return t("connectionAllowedOriginsRejected");
}

/**
 * Message for a WebSocket `error` event. Unlike `getConnectionErrorMessage`
 * (used when the server's connection-check endpoint authoritatively rejected
 * the origin), a raw socket error carries no rejection reason, so it must not
 * blame ALLOWED_ORIGINS with confidence:
 * - after `open` the connection was healthy and simply dropped (e.g. a server
 *   restart), which is not a handshake failure at all;
 * - before `open` the failure may equally be a restarting backend behind a
 *   reverse proxy whose HTTP layer still answers probes.
 *
 * After the server's graceful-shutdown close every one of those is the restart
 * still in progress (the proxy answers while the backend is down), so
 * `serverRestarting` takes precedence.
 */
export function getSocketErrorMessage(args: {
  sawOpen: boolean;
  healthcheckReachable: boolean;
  serverRestarting?: boolean;
}): string {
  if (args.serverRestarting) {
    return t("connectionServerRestarting");
  }
  if (args.sawOpen) {
    return t("connectionLostReconnecting");
  }
  if (!args.healthcheckReachable) {
    return t("connectionServerUnreachable");
  }
  return t("connectionWebsocketFailed");
}
