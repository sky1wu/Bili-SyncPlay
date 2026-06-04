import { isIP } from "node:net";

export function normalizeIpAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  if (isIP(unwrapped) === 0) {
    return null;
  }

  const mappedIpv4Match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(unwrapped);
  if (mappedIpv4Match && isIP(mappedIpv4Match[1]) === 4) {
    return mappedIpv4Match[1];
  }

  return unwrapped;
}
