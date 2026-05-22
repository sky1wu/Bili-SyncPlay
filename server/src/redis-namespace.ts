function normalizeNamespaceBase(namespace?: string): string {
  if (!namespace || namespace.trim().length === 0) {
    return "bsp:";
  }

  const trimmed = namespace.trim();
  return trimmed.endsWith(":") ? trimmed : `${trimmed}:`;
}

export function getRedisNamespaceBase(namespace?: string): string {
  return normalizeNamespaceBase(namespace);
}

export function getRedisRoomStoreKeys(namespace?: string) {
  const base = normalizeNamespaceBase(namespace);
  return {
    roomKeyPrefix: `${base}room:`,
    roomExpiryKey: `${base}room-expiry`,
    roomIndexKey: `${base}room-index`,
  };
}

export function getRedisRuntimeKeyPrefix(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}runtime:`;
}

export function getRedisAdminSessionKeyPrefix(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}admin:session:`;
}

export function getRedisEventStreamKey(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}events`;
}

export function getRedisEventCountsKey(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}event_counts`;
}

export function getRedisEventWindowIndexKeyPrefix(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}event_window_index`;
}

export function getRedisAuditStreamKey(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}audit-logs`;
}

export function getRedisRoomEventChannel(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}room-events`;
}

export function getRedisAdminCommandChannelPrefix(namespace?: string): string {
  return `${normalizeNamespaceBase(namespace)}admin-command:`;
}

export function getRedisAdminCommandResultChannelPrefix(
  namespace?: string,
): string {
  return `${normalizeNamespaceBase(namespace)}admin-command-result:`;
}
