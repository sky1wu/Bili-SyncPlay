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
    // One sorted set holds every room, scored by its expiry (+inf when the
    // room does not expire), so enumeration, counting and reaping all read
    // the same source instead of reconciling separate indexes against each
    // other. It supersedes the room-index and room-expiry pair.
    roomsByExpiryKey: `${base}rooms-by-expiry`,
    // Kept as a write-only mirror for one release so a rollback stays safe.
    // The previous build rebuilds room-index from room bodies on startup but
    // has no equivalent repair for room-expiry, so without this mirror any
    // room whose expiry was set while the new build was live would become
    // invisible to the old reaper and linger forever. Nothing reads it here.
    legacyRoomExpiryKey: `${base}room-expiry`,
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
