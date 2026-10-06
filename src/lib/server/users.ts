import "server-only";
import type { AppState, Role, Session, User } from "../store/appStore";
import { hashPin, isValidPin, newId, newToken, tokenHash, verifyPin } from "./pin";

/**
 * Users, PIN login and revocable sessions — kept in OUR database (same state document as missions).
 * Employees log in once per device with login + PIN; the device keeps an httpOnly session cookie.
 */

export const ROLE_RANK: Record<Role, number> = { EMPLOYEE: 1, MANAGER: 2, ADMIN: 3 };
export const SESSION_DAYS = 180;
const LAST_SEEN_STEP_MS = 10 * 60_000;

export interface SessionUser {
  id: string;
  login: string;
  name: string;
  role: Role;
  sessionId: string;
}

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// login throttling: 5 wrong PINs → 5 minutes lock (per login, in memory)
const attempts = new Map<string, { count: number; until: number }>();

export function publicUser(u: User) {
  return { id: u.id, login: u.login, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt, pinUpdatedAt: u.pinUpdatedAt };
}

export function createUser(state: AppState, input: { login: string; name: string; role: Role; pin: string }): User {
  const login = input.login.trim().toLowerCase();
  if (!/^[a-zа-яё0-9._-]{2,32}$/i.test(login)) throw new AuthError(400, "Логин: 2–32 символа (буквы, цифры, . _ -)");
  if (!input.name.trim()) throw new AuthError(400, "Укажите имя");
  if (!isValidPin(input.pin)) throw new AuthError(400, "PIN: от 4 до 8 цифр");
  if (state.users.some((u) => u.login === login)) throw new AuthError(409, "Такой логин уже есть");
  if (state.users.some((u) => u.name.toLowerCase() === input.name.trim().toLowerCase())) throw new AuthError(409, "Такое имя уже есть");
  const now = Date.now();
  const user: User = { id: newId("U"), login, name: input.name.trim(), role: input.role, pinHash: hashPin(input.pin), active: true, createdAt: now, pinUpdatedAt: now };
  state.users.push(user);
  return user;
}

export function updateUser(state: AppState, id: string, patch: { name?: string; role?: Role; pin?: string; active?: boolean }, by: SessionUser): User {
  const u = state.users.find((x) => x.id === id);
  if (!u) throw new AuthError(404, "Пользователь не найден");
  if (u.id === by.id && (patch.active === false || (patch.role && patch.role !== "ADMIN"))) throw new AuthError(400, "Нельзя отключить или понизить самого себя");
  if (patch.name) u.name = patch.name.trim();
  if (patch.role) u.role = patch.role;
  if (patch.pin !== undefined) {
    if (!isValidPin(patch.pin)) throw new AuthError(400, "PIN: от 4 до 8 цифр");
    u.pinHash = hashPin(patch.pin);
    u.pinUpdatedAt = Date.now();
    revokeUserSessions(state, u.id, by.name); // new PIN logs the user out everywhere
  }
  if (patch.active !== undefined) {
    u.active = patch.active;
    if (!patch.active) revokeUserSessions(state, u.id, by.name);
  }
  return u;
}

export function login(state: AppState, loginName: string, pin: string, device: string): { token: string; user: User; session: Session } {
  const key = loginName.trim().toLowerCase();
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw new AuthError(429, "Слишком много попыток. Подождите 5 минут.");
  const user = state.users.find((u) => u.login === key || u.name.toLowerCase() === key);
  if (!user || !user.active || !verifyPin(pin, user.pinHash)) {
    const cur = attempts.get(key) ?? { count: 0, until: 0 };
    cur.count += 1;
    if (cur.count >= 5) {
      cur.until = Date.now() + 5 * 60_000;
      cur.count = 0;
    }
    attempts.set(key, cur);
    throw new AuthError(401, "Неверный логин или PIN");
  }
  attempts.delete(key);
  const token = newToken();
  const now = Date.now();
  const session: Session = {
    id: newId("S"),
    userId: user.id,
    tokenHash: tokenHash(token),
    device: device.slice(0, 120) || "unknown",
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_DAYS * 86_400_000,
    revokedAt: null,
    revokedBy: null,
  };
  state.sessions.push(session);
  return { token, user, session };
}

/** Validates a session cookie. Returns the user and whether state changed (last seen / sliding expiry). */
export function validate(state: AppState, token: string | undefined | null): { user: SessionUser; touched: boolean } | null {
  if (!token || token.length < 20) return null;
  const h = tokenHash(token);
  const s = state.sessions.find((x) => x.tokenHash === h);
  if (!s || s.revokedAt || s.expiresAt < Date.now()) return null;
  const u = state.users.find((x) => x.id === s.userId);
  if (!u || !u.active) return null;
  let touched = false;
  if (Date.now() - s.lastSeenAt > LAST_SEEN_STEP_MS) {
    s.lastSeenAt = Date.now();
    s.expiresAt = Date.now() + SESSION_DAYS * 86_400_000;
    touched = true;
  }
  return { user: { id: u.id, login: u.login, name: u.name, role: u.role, sessionId: s.id }, touched };
}

export function revokeSession(state: AppState, sessionId: string, by: string): void {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) throw new AuthError(404, "Сессия не найдена");
  s.revokedAt = s.revokedAt ?? Date.now();
  s.revokedBy = s.revokedBy ?? by;
}

export function revokeUserSessions(state: AppState, userId: string, by: string): number {
  let n = 0;
  for (const s of state.sessions)
    if (s.userId === userId && !s.revokedAt) {
      s.revokedAt = Date.now();
      s.revokedBy = by;
      n++;
    }
  return n;
}

/**
 * First start: create accounts.
 *  • production — only from ADMIN_LOGIN / ADMIN_PIN (+ ADMIN_NAME) when there are no users yet;
 *  • development — demo accounts (documented in README), never in production.
 */
export function bootstrapUsers(state: AppState): string[] {
  if (state.users.length > 0) return [];
  const created: string[] = [];
  const envLogin = process.env.ADMIN_LOGIN;
  const envPin = process.env.ADMIN_PIN;
  if (envLogin && envPin) {
    createUser(state, { login: envLogin, name: process.env.ADMIN_NAME || "Администратор", role: "ADMIN", pin: envPin });
    created.push(envLogin);
  } else if (process.env.NODE_ENV !== "production") {
    createUser(state, { login: "admin", name: "Администратор", role: "ADMIN", pin: "1111" });
    createUser(state, { login: "manager", name: "Менеджер", role: "MANAGER", pin: "2222" });
    createUser(state, { login: "anna", name: "Анна", role: "EMPLOYEE", pin: "3333" });
    created.push("admin", "manager", "anna");
  } else {
    console.warn("[apps-holodosov] No users yet. Set ADMIN_LOGIN and ADMIN_PIN to create the first administrator.");
  }
  return created;
}
