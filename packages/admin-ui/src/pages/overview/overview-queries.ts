import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/auth-context.js";

export const OVERVIEW_REFRESH_MS = 15_000;

export function useOverviewQuery(autoRefresh: boolean) {
  const { api } = useAuth();
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api.getOverview(),
    refetchInterval: autoRefresh ? OVERVIEW_REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });
}

export function useReadyQuery(autoRefresh: boolean) {
  const { api } = useAuth();
  return useQuery({
    queryKey: ["ready"],
    queryFn: () => api.getReady(),
    refetchInterval: autoRefresh ? OVERVIEW_REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });
}
