"use client";

/**
 * Bad-connection safety for staff on the floor.
 *  • Checklist progress is saved locally after every tap — a lost connection or a closed tab loses nothing.
 *  • Mission actions that fail because of the network go to a local outbox and are re-sent when online.
 * Only OUR API is called. KitShop is read-only and never touched from here.
 */

const PROGRESS_KEY = (id: string) => `fo-progress-${id}`;
const OUTBOX_KEY = "fo-outbox";

export interface RouteProgress {
  /** "pick" → collecting at the source; "drop" → delivering to stop `stopIndex`; "done" */
  phase: "pick" | "drop" | "done";
  stopIndex: number;
  /** checked items: key = `${lineIndex}:${productId}` */
  checked: Record<string, boolean>;
  /** actual quantities when the fridge had less ("Есть только N") */
  actual: Record<string, number>;
  updatedAt: number;
}

function safeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) — progress simply isn't persisted */
  }
}

export function loadProgress(id: string): RouteProgress | null {
  return safeGet<RouteProgress>(PROGRESS_KEY(id));
}

export function saveProgress(id: string, p: RouteProgress) {
  safeSet(PROGRESS_KEY(id), { ...p, updatedAt: Date.now() });
}

export function clearProgress(id: string) {
  try {
    localStorage.removeItem(PROGRESS_KEY(id));
  } catch {
    /* ignore */
  }
}

interface OutboxItem {
  id: string;
  url: string;
  method: string;
  body: unknown;
  createdAt: number;
}

export function outboxSize(): number {
  return safeGet<OutboxItem[]>(OUTBOX_KEY)?.length ?? 0;
}

/**
 * Sends a request; if the network is down, keeps it in the outbox and returns { queued: true }.
 * Server-side errors (4xx/5xx) are NOT queued — they are real answers.
 */
export async function sendOrQueue<T>(url: string, method: string, body: unknown): Promise<{ queued: true } | { queued: false; data: T }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status });
    return { queued: false, data: data as T };
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    const box = safeGet<OutboxItem[]>(OUTBOX_KEY) ?? [];
    box.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, url, method, body, createdAt: Date.now() });
    safeSet(OUTBOX_KEY, box);
    return { queued: true };
  }
}

/** Re-sends queued actions. 409 (already done) and other server answers remove the item. */
export async function flushOutbox(): Promise<number> {
  const box = safeGet<OutboxItem[]>(OUTBOX_KEY) ?? [];
  if (!box.length) return 0;
  const left: OutboxItem[] = [];
  let sent = 0;
  for (const item of box) {
    try {
      await fetch(item.url, { method: item.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.body) });
      sent++;
    } catch {
      left.push(item);
    }
  }
  safeSet(OUTBOX_KEY, left);
  return sent;
}
