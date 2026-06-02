import type { SecurityConfig, VoiceConfig } from "./types.js";

export function applyVoiceRoomCapacity(
  securityConfig: SecurityConfig,
  voiceConfig: VoiceConfig,
): SecurityConfig {
  if (!voiceConfig.enabled) {
    return securityConfig;
  }

  const maxMembersPerRoom = Math.min(
    securityConfig.maxMembersPerRoom,
    voiceConfig.maxMembers,
  );
  if (maxMembersPerRoom === securityConfig.maxMembersPerRoom) {
    return securityConfig;
  }

  return {
    ...securityConfig,
    maxMembersPerRoom,
  };
}
