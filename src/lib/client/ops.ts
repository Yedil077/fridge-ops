"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { sendOrQueue } from "./offline";
import type { OpView, opsCatalog, opsList } from "@/lib/server/opsViews";

/**
 * KiT Shop operations from the phone. The phone talks ONLY to our backend; our backend talks to KiT Shop.
 * Every operation gets an id (operation_uuid) created here, BEFORE the first send: a double tap, a reload
 * or an offline re-send reuse the same id, so the server never applies it twice.
 */

export type { OpView };
export type OpsCatalog = Awaited<ReturnType<typeof opsCatalog>>;
export type OpsList = ReturnType<typeof opsList>;
export type OpType = OpView["type"];

export function newOperationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function useOpsCatalog(fridgeId: string | null) {
  return useQuery({
    queryKey: ["ops", "catalog", fridgeId],
    queryFn: () => api<OpsCatalog>(`/api/ops/catalog?fridgeId=${encodeURIComponent(fridgeId!)}`),
    enabled: !!fridgeId,
    // live stock sync: every 5 minutes, and right after every write (invalidate)
    refetchInterval: 5 * 60_000,
  });
}

export function useOps(params: { status?: "open"; missionId?: string; enabled?: boolean } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.missionId) q.set("missionId", params.missionId);
  return useQuery({
    queryKey: ["ops", "list", params.status ?? "all", params.missionId ?? ""],
    queryFn: () => api<OpsList>(`/api/ops?${q}`),
    enabled: params.enabled ?? true,
    refetchInterval: 15_000,
  });
}

export interface SubmitBody {
  id: string;
  type: OpType;
  fridgeId: string;
  items: { productId: string; qty: number }[];
  reason?: string;
}

export type SubmitResult =
  | { kind: "answer"; op: OpView; duplicate: boolean }
  /** the phone is offline: kept on the phone with the same id, sent once when online */
  | { kind: "queued" }
  | { kind: "error"; message: string; code?: string; details?: unknown };

export async function submitOperation(body: SubmitBody): Promise<SubmitResult> {
  try {
    const res = await sendOrQueue<{ operation: OpView; duplicate: boolean }>("/api/ops", "POST", body);
    if (res.queued) return { kind: "queued" };
    return { kind: "answer", op: res.data.operation, duplicate: res.data.duplicate };
  } catch (e) {
    const err = e as Error & { status?: number; code?: string; details?: unknown };
    return { kind: "error", message: err.message, code: err.code, details: err.details };
  }
}

export async function opAction(id: string, body: { action: "verify" } | { action: "retry" } | { action: "resolve"; decision: "confirmed" | "failed"; note?: string }) {
  return api<{ operation: OpView }>(`/api/ops/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) });
}

export async function getOp(id: string) {
  return api<{ operation: OpView }>(`/api/ops/${encodeURIComponent(id)}`);
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export const STATUS_TONE: Record<OpView["status"], string> = {
  DRAFT: "text-ink-3",
  PENDING: "text-accent",
  CONFIRMED: "text-good-ink",
  FAILED: "text-crit-ink",
  UNKNOWN: "text-warn",
  REQUIRES_REVIEW: "text-warn",
  WAITING_FOR_CONNECTION: "text-warn",
};

export const MODE_NOTE: Record<OpView["adapterMode"], string> = {
  mock: "ТЕСТ: тренировочный KiT Shop, реальные данные не изменены",
  "dry-run": "DRY-RUN: в KiT Shop ничего не отправлено, запрос записан в журнал",
  live: "KiT Shop",
};
