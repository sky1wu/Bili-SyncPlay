import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultSecurityConfig } from "../src/app.js";
import { getDefaultVoiceConfig } from "../src/config/voice-config.js";
import { applyVoiceRoomCapacity } from "../src/voice-capacity.js";

test("voice room capacity keeps configured member limit when voice is disabled", () => {
  const securityConfig = {
    ...getDefaultSecurityConfig(),
    maxMembersPerRoom: 8,
  };

  assert.equal(
    applyVoiceRoomCapacity(securityConfig, getDefaultVoiceConfig())
      .maxMembersPerRoom,
    8,
  );
});

test("voice room capacity caps enabled rooms at the voice member limit", () => {
  const securityConfig = {
    ...getDefaultSecurityConfig(),
    maxMembersPerRoom: 8,
  };
  const voiceConfig = {
    ...getDefaultVoiceConfig(),
    enabled: true,
    maxMembers: 4,
  };

  assert.equal(
    applyVoiceRoomCapacity(securityConfig, voiceConfig).maxMembersPerRoom,
    4,
  );
});

test("voice room capacity respects lower deployment room limits", () => {
  const securityConfig = {
    ...getDefaultSecurityConfig(),
    maxMembersPerRoom: 3,
  };
  const voiceConfig = {
    ...getDefaultVoiceConfig(),
    enabled: true,
    maxMembers: 4,
  };

  assert.equal(
    applyVoiceRoomCapacity(securityConfig, voiceConfig).maxMembersPerRoom,
    3,
  );
});
