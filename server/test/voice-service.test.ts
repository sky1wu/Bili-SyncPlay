import assert from "node:assert/strict";
import test from "node:test";
import type { Session, VoiceConfig } from "../src/types.js";
import { createLiveKitTokenSigner } from "../src/livekit-token.js";
import {
  createVoiceAccessService,
  VoiceServiceError,
} from "../src/voice-service.js";

const READY_CONFIG: VoiceConfig = {
  enabled: true,
  livekitUrl: "wss://voice.example.com",
  apiKey: "livekit-key",
  apiSecret: "livekit-secret",
  tokenTtlSeconds: 600,
  maxMembers: 4,
};

function createSession(): Session {
  return {
    id: "session-1",
    connectionState: "attached",
    socket: {} as Session["socket"],
    instanceId: "node-a",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: "ABC123",
    memberId: "member-1",
    displayName: "Alice",
    memberToken: "member-token-1",
    protocolVersion: 3,
    joinedAt: 1_725_000_000_000,
    invalidMessageCount: 0,
    rateLimitState: {} as Session["rateLimitState"],
  };
}

test("voice access service issues scoped LiveKit access for a valid room member", async () => {
  const signerCalls: unknown[] = [];
  const service = createVoiceAccessService({
    config: READY_CONFIG,
    now: () => 1_725_000_000_000,
    async validateMemberAccess(session, memberToken) {
      assert.equal(session.id, "session-1");
      assert.equal(memberToken, "member-token-1");
      return {
        roomCode: "ABC123",
        memberId: "member-1",
        displayName: "Alice Chen",
      };
    },
    async signToken(input) {
      signerCalls.push(input);
      return "signed-livekit-token";
    },
  });

  const access = await service.issueAccess(createSession(), "member-token-1");

  assert.deepEqual(access, {
    livekitUrl: "wss://voice.example.com",
    token: "signed-livekit-token",
    roomName: "bili-syncplay:ABC123",
    participantIdentity: "member-1",
    expiresAt: 1_725_000_600_000,
  });
  assert.deepEqual(signerCalls, [
    {
      apiKey: "livekit-key",
      apiSecret: "livekit-secret",
      roomName: "bili-syncplay:ABC123",
      participantIdentity: "member-1",
      participantName: "Alice Chen",
      ttlSeconds: 600,
    },
  ]);
});

test("voice access service rejects access when voice is disabled", async () => {
  const service = createVoiceAccessService({
    config: {
      ...READY_CONFIG,
      enabled: false,
    },
    async validateMemberAccess() {
      throw new Error("validateMemberAccess should not be called");
    },
    async signToken() {
      throw new Error("signToken should not be called");
    },
  });

  await assert.rejects(
    () => service.issueAccess(createSession(), "member-token-1"),
    (error) =>
      error instanceof VoiceServiceError && error.code === "voice_unavailable",
  );
});

test("voice access service rejects access when LiveKit secrets are missing", async () => {
  const service = createVoiceAccessService({
    config: {
      ...READY_CONFIG,
      apiSecret: undefined,
    },
    async validateMemberAccess() {
      throw new Error("validateMemberAccess should not be called");
    },
    async signToken() {
      throw new Error("signToken should not be called");
    },
  });

  await assert.rejects(
    () => service.issueAccess(createSession(), "member-token-1"),
    (error) =>
      error instanceof VoiceServiceError && error.code === "voice_unavailable",
  );
});

test("voice access service maps signer failures to voice token errors", async () => {
  const service = createVoiceAccessService({
    config: READY_CONFIG,
    async validateMemberAccess() {
      return {
        roomCode: "ABC123",
        memberId: "member-1",
        displayName: "Alice",
      };
    },
    async signToken() {
      throw new Error("secret should not be exposed");
    },
  });

  await assert.rejects(
    () => service.issueAccess(createSession(), "member-token-1"),
    (error) =>
      error instanceof VoiceServiceError && error.code === "voice_token_failed",
  );
});

test("LiveKit token signer scopes JWT grants to the voice room and participant", async () => {
  const signer = createLiveKitTokenSigner();
  const token = await signer({
    apiKey: "livekit-key",
    apiSecret: "livekit-secret",
    roomName: "bili-syncplay:ABC123",
    participantIdentity: "member-1",
    participantName: "Alice",
    ttlSeconds: 600,
  });
  const [, payload] = token.split(".");

  assert.ok(payload);
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as {
    iss?: string;
    sub?: string;
    name?: string;
    video?: {
      room?: string;
      roomJoin?: boolean;
      canPublish?: boolean;
      canPublishSources?: string[];
      canSubscribe?: boolean;
    };
  };

  assert.equal(claims.iss, "livekit-key");
  assert.equal(claims.sub, "member-1");
  assert.equal(claims.name, "Alice");
  assert.deepEqual(claims.video, {
    roomJoin: true,
    room: "bili-syncplay:ABC123",
    canPublish: true,
    canPublishSources: ["microphone"],
    canSubscribe: true,
  });
});
