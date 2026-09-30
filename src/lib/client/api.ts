"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Mission } from "@/lib/domain/types";
import { useForecastMode } from "./forecastMode";
import type { analyticsView, DashboardView, fridgeDetailView, historyView } from "@/lib/server/views";

export type AnalyticsView = ReturnType<typeof analyticsView>;
export type FridgeDetailView = NonNullable<ReturnType<typeof fridgeDetailView>>;
export type HistoryView = ReturnType<typeof historyView>;
export type { DashboardView };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    window.location.href = "/login";
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Me {
  id: string;
  login: string;
  name: string;
  role: "EMPLOYEE" | "MANAGER" | "ADMIN";
  mode: string;
  /** closing time from Настройки, e.g. "20:00" — label of the second forecast mode */
  closeTime?: string;
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/auth/me"), staleTime: 5 * 60_000 });
}

export const atLeast = (me: Me | undefined, role: Me["role"]) =>
  !!me && { EMPLOYEE: 1, MANAGER: 2, ADMIN: 3 }[me.role] >= { EMPLOYEE: 1, MANAGER: 2, ADMIN: 3 }[role];

/** Logout: revoke the session on the server and wipe cached personal data on this device. */
export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* offline — cookie is still cleared below by navigation to /login */
  }
  try {
    if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    /* ignore */
  }
  window.location.href = "/login";
}

export function useDashboard() {
  const [mode] = useForecastMode();
  return useQuery({ queryKey: ["dashboard", mode], queryFn: () => api<DashboardView>(`/api/dashboard?mode=${mode}`), refetchInterval: 30_000 });
}

export function useFridge(id: string) {
  return useQuery({ queryKey: ["fridge", id], queryFn: () => api<FridgeDetailView>(`/api/fridges/${id}`), refetchInterval: 30_000 });
}

export function useAnalytics() {
  return useQuery({ queryKey: ["analytics"], queryFn: () => api<AnalyticsView>("/api/analytics") });
}

export function useHistory(range: number, fridge: string | null) {
  return useQuery({
    queryKey: ["history", range, fridge],
    queryFn: () => api<HistoryView>(`/api/history?range=${range}${fridge ? `&fridge=${encodeURIComponent(fridge)}` : ""}`),
  });
}

export type MissionActionBody =
  | { action: "accept" }
  | { action: "start" }
  | { action: "complete"; quantities?: Record<string, number>; items?: { lineIndex: number; productId: string; qty: number; unavailable?: boolean }[] }
  | { action: "skip"; reason?: string };

export interface XpGain {
  amount: number;
  points: number;
  reason: string;
}

export interface CompletionImpact {
  savedSales: number;
  wasteReduced: number;
  unlockedRewards: string[];
  unlockedAchievements: string[];
}

export interface MissionActionResult {
  mission: Mission;
  xp: XpGain[];
  impact?: CompletionImpact;
}

export function useMissionAction(onXp?: (xp: XpGain[], impact?: CompletionImpact) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: MissionActionBody }) =>
      api<MissionActionResult>(`/api/missions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      if (data.xp.length) onXp?.(data.xp, data.impact);
      qc.invalidateQueries();
    },
  });
}

export function useDevAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: string) =>
      api<{ message: string; log: { at: number; text: string }[] }>("/api/dev", { method: "POST", body: JSON.stringify({ action }) }),
    onSuccess: () => qc.invalidateQueries(),
  });
}
