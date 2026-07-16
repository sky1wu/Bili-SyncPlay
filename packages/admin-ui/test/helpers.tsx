import { vi } from "vitest";
import type { AuthContextValue } from "../src/auth/auth-context.js";

export function createStubApi(
  overrides: Partial<AuthContextValue["api"]> = {},
): AuthContextValue["api"] {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    getMe: vi.fn(),
    getOverview: vi.fn(),
    getReady: vi.fn(),
    listRooms: vi.fn(),
    getRoomDetail: vi.fn(),
    listEvents: vi.fn(),
    listAuditLogs: vi.fn(),
    closeRoom: vi.fn(),
    expireRoom: vi.fn(),
    clearRoomVideo: vi.fn(),
    kickMember: vi.fn(),
    disconnectSession: vi.fn(),
    ...overrides,
  };
}

export function createAuthValue(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    token: "",
    me: null,
    initializing: false,
    meError: "",
    api: createStubApi(),
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    retryLoadMe: vi.fn(),
    ...overrides,
  };
}
