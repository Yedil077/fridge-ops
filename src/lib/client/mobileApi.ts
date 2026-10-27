"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useForecastMode } from "./forecastMode";
import type { MobileFridge, MobileFridges, MobileHome, MobileRating, MobileRoute, MobileTasks } from "@/lib/server/mobile";

export type { MobileFridge, MobileFridges, MobileHome, MobileRating, MobileRoute, MobileTasks };

export function useMobileHome() {
  const [mode] = useForecastMode();
  return useQuery({ queryKey: ["m", "home", mode], queryFn: () => api<MobileHome>(`/api/mobile/home?mode=${mode}`), refetchInterval: 30_000 });
}

export function useMobileTasks() {
  const [mode] = useForecastMode();
  return useQuery({ queryKey: ["m", "tasks", mode], queryFn: () => api<MobileTasks>(`/api/mobile/tasks?mode=${mode}`), refetchInterval: 30_000 });
}

export function useMobileTask(id: string) {
  return useQuery({ queryKey: ["m", "task", id], queryFn: () => api<{ now: number; route: MobileRoute }>(`/api/mobile/tasks/${id}`) });
}

export function useMobileFridges() {
  return useQuery({ queryKey: ["m", "fridges"], queryFn: () => api<MobileFridges>("/api/mobile/fridges"), refetchInterval: 60_000 });
}

export function useMobileFridge(id: string) {
  return useQuery({ queryKey: ["m", "fridge", id], queryFn: () => api<MobileFridge>(`/api/mobile/fridges/${id}`) });
}

export interface OpsAlert {
  id: string;
  at: number;
  level: "critical" | "warning";
  title: string;
  body: string;
  fridge: string;
  missionId: string | null;
}

export function useAlerts() {
  return useQuery({ queryKey: ["m", "alerts"], queryFn: () => api<{ now: number; notifications: OpsAlert[] }>("/api/notifications"), refetchInterval: 60_000 });
}

export function useMobileRating() {
  return useQuery({ queryKey: ["m", "rating"], queryFn: () => api<MobileRating>("/api/mobile/rating") });
}
