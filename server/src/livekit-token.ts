import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { LiveKitTokenSigner } from "./voice-service.js";

export function createLiveKitTokenSigner(): LiveKitTokenSigner {
  return async ({
    apiKey,
    apiSecret,
    roomName,
    participantIdentity,
    participantName,
    ttlSeconds,
  }) => {
    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: participantName,
      ttl: ttlSeconds,
    });
    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
    });
    return accessToken.toJwt();
  };
}
