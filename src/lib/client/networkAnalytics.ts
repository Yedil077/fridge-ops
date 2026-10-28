"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { NetworkAnalyticsView } from "@/lib/server/networkAnalyticsView";

export type { NetworkAnalyticsView };

/** Аналитика «Все холодильники»: только когда выбран этот режим. */
export function useNetworkAnalytics(enabled: boolean) {
  return useQuery({ queryKey: ["network-analytics"], queryFn: () => api<NetworkAnalyticsView>("/api/analytics/network"), refetchInterval: 60_000, enabled });
}
