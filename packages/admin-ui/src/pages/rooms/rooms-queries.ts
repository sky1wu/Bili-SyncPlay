import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/auth-context.js";
import type { RoomListQuery } from "../../api/types.js";

export const ROOMS_REFRESH_MS = 15_000;

export function useRoomsQuery(query: RoomListQuery, autoRefresh: boolean) {
  const { api } = useAuth();
  return useQuery({
    queryKey: ["rooms", query],
    queryFn: () => api.listRooms(query),
    refetchInterval: autoRefresh ? ROOMS_REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });
}

export function useRoomDetailQuery(
  roomCode: string | null,
  autoRefresh: boolean,
) {
  const { api } = useAuth();
  return useQuery({
    queryKey: ["room", roomCode],
    queryFn: () => api.getRoomDetail(roomCode ?? ""),
    enabled: roomCode !== null,
    refetchInterval: autoRefresh ? ROOMS_REFRESH_MS : false,
    // 故意不用 keepPreviousData：切换房间瞬间若沿用上一个房间的 detail，
    // 抽屉里的治理按钮会作用在错误的房间上，宁可显示加载态。
  });
}
