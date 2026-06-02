import type { ErrorCode } from "@bili-syncplay/protocol";
import { isVoiceConfigReady } from "./config/voice-config.js";
import {
  VOICE_TOKEN_FAILED_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
} from "./messages.js";
import type { Session, VoiceConfig } from "./types.js";

export type VoiceMemberAccess = {
  roomCode: string;
  memberId: string;
  displayName: string;
};

export type LiveKitTokenInput = {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  participantIdentity: string;
  participantName: string;
  ttlSeconds: number;
};

export type LiveKitTokenSigner = (input: LiveKitTokenInput) => Promise<string>;

export type VoiceAccessDetails = {
  livekitUrl: string;
  token: string;
  roomName: string;
  participantIdentity: string;
  expiresAt: number;
};

type VoiceServiceErrorReason = "voice_unavailable" | "voice_token_failed";

export class VoiceServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason: VoiceServiceErrorReason,
  ) {
    super(message);
  }
}

export function createVoiceAccessService(options: {
  config: VoiceConfig;
  validateMemberAccess: (
    session: Session,
    memberToken: string,
  ) => Promise<VoiceMemberAccess>;
  signToken: LiveKitTokenSigner;
  now?: () => number;
}): {
  issueAccess: (
    session: Session,
    memberToken: string,
  ) => Promise<VoiceAccessDetails>;
} {
  const { config, validateMemberAccess, signToken } = options;
  const now = options.now ?? Date.now;

  async function issueAccess(
    session: Session,
    memberToken: string,
  ): Promise<VoiceAccessDetails> {
    if (!isVoiceConfigReady(config)) {
      throw new VoiceServiceError(
        "voice_unavailable",
        VOICE_UNAVAILABLE_MESSAGE,
        "voice_unavailable",
      );
    }

    const memberAccess = await validateMemberAccess(session, memberToken);
    const roomName = `bili-syncplay:${memberAccess.roomCode}`;
    const participantIdentity = memberAccess.memberId;
    let token: string;

    try {
      token = await signToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        roomName,
        participantIdentity,
        participantName: memberAccess.displayName,
        ttlSeconds: config.tokenTtlSeconds,
      });
    } catch {
      throw new VoiceServiceError(
        "voice_token_failed",
        VOICE_TOKEN_FAILED_MESSAGE,
        "voice_token_failed",
      );
    }

    return {
      livekitUrl: config.livekitUrl,
      token,
      roomName,
      participantIdentity,
      expiresAt: now() + config.tokenTtlSeconds * 1000,
    };
  }

  return { issueAccess };
}
