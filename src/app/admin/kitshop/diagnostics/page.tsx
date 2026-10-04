"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/client/api";
import type { diagnostics } from "@/lib/server/kitshopAdmin";
import type { StepResult, TestLeg } from "@/lib/kitshop-ops/writeTest";
import type { RealDiagnosticReport, RealStep, StepStatus } from "@/lib/server/kitshopAdmin";

type Diag = Awaited<ReturnType<typeof diagnostics>>;
interface Check {
  auth: string;
  ms: number;
  signCase: string;
  shops: { shopId: string; name: string; stocksAccounting: boolean | null }[];
  note: string | null;
}
interface Candidate {
  productId: string;
  name: string;
  barcode: string | null;
  stock: number;
}

const fmt = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" }) : "—");
const TONE: Record<StepResult, string> = { PASS: "text-good-ink", FAIL: "text-crit-ink", REQUIRES_REVIEW: "text-warn", PENDING: "text-ink-3" };

/**
 * KiT Shop diagnostics + PHASE D REAL WRITE TEST (one shop, one product, ±1).
 * Everything is read-only except the explicit "ПОДТВЕРДИТЬ ТЕСТОВУЮ ..." buttons.
 * Write permission itself is server configuration — this page only shows it (and can PAUSE all writes).
 */
export default function KitShopDiagnosticsPage() {
  const qc = useQueryClient();
  const { data: d, error } = useQuery({ queryKey: ["admin", "kitshop"], queryFn: () => api<Diag>("/api/admin/kitshop"), refetchInterval: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [q, setQ] = useState("");
  const [cands, setCands] = useState<Candidate[] | null>(null);

  async function post<T>(key: string, body: Record<string, unknown>): Promise<T | null> {
    setBusy(key);
    setMsg(null);
    try {
      const res = await api<T>("/api/admin/kitshop", { method: "POST", body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: ["admin", "kitshop"] });
      return res;
    } catch (e) {
      setMsg((e as Error).message);
      await qc.invalidateQueries({ queryKey: ["admin", "kitshop"] });
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (error) return <Shell><p className="p-6 text-crit-ink">{(error as Error).message}</p></Shell>;
  if (!d) return <Shell><p className="p-6 text-ink-3">Загрузка…</p></Shell>;

  const run = d.run;
  const allowed = new Set(d.allowedShops.map((s) => s.shopId));
  const btn = (key: string, label: string, onClick: () => void, tone = "bg-surface-3", disabled = false) => (
    <button onClick={onClick} disabled={!!busy || disabled} className={clsx("h-10 rounded-lg px-4 text-[13px] font-semibold disabled:opacity-40", tone)}>
      {busy === key ? "…" : label}
    </button>
  );

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
        <div
          className={clsx(
            "rounded-xl px-4 py-2 text-center text-[15px] font-extrabold tracking-[0.2em] text-white",
            d.target.real ? "bg-crit" : "bg-surface-3 text-ink",
          )}
        >
          {d.target.label}
          <span className="ml-2 text-[11px] font-semibold tracking-normal opacity-80">· host {d.target.host}</span>
        </div>
        <div>
          <h1 className="text-[22px] font-bold">KiT Shop · диагностика и Phase D</h1>
          <p className="mt-1 text-[13px] text-ink-3">Пароли и подписи не показываются. Право на запись задаётся только настройками сервера.</p>
        </div>
        {msg && <p className="rounded-lg bg-crit/15 px-3 py-2 text-[13px] text-crit-ink">{msg}</p>}

        {/* ── status ── */}
        <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Tile label="Последний REAL API TEST" value={d.connection} tone={d.realTest ? (d.realTest.failingStep ? "bad" : "good") : undefined} small />
          <Tile label="Company ID" value={d.companyId ?? "missing"} tone={d.companyId ? undefined : "bad"} />
          <Tile label="API user" value={d.apiUser} tone={d.apiUser === "configured" ? undefined : "bad"} />
          <Tile label="Write mode" value={d.paused.on ? `${d.writeMode} · PAUSED` : d.writeMode} tone={d.paused.on ? "bad" : d.writeMode === "LIMITED PRODUCTION" ? "warn" : undefined} />
          <Tile label="Last successful request" value={d.lastSuccess ? `${fmt(d.lastSuccess.at)} · ${d.lastSuccess.method} · ${d.lastSuccess.ms} ms` : "—"} small />
          <Tile label="Last stock sync" value={d.lastStockSync ? `${fmt(d.lastStockSync.at)}${d.lastStockSync.ok ? "" : " (ошибка)"}` : "—"} small />
          <Tile label="Allowed write shops" value={d.allowedShops.length ? d.allowedShops.map((s) => `${s.shopId}${s.name ? ` ${s.name}` : ""}`).join(", ") : "нет"} small />
          <Tile label="Sign / scope / timeout" value={`${d.signCase} · ${d.scope} · ${d.timeoutMs / 1000}s`} small />
          <Tile label="Pending operations" value={String(d.counts.pending)} />
          <Tile label="Unknown operations" value={String(d.counts.unknown)} tone={d.counts.unknown ? "warn" : undefined} />
          <Tile label="Failed operations" value={String(d.counts.failed)} tone={d.counts.failed ? "warn" : undefined} />
          <Tile label="Last error" value={d.lastError ? `${fmt(d.lastError.at)} · ${d.lastError.method}: ${d.lastError.error ?? d.lastError.resultCode}` : "—"} small />
        </section>

        <RealApiTest d={d} busy={busy} run={() => post("real", { action: "real-test" })} runAuth={() => post("real-auth", { action: "real-test-auth" })} />

        {/* ── switches ── */}
        <Card title="KITSHOP WRITE">
          <div className="flex flex-wrap items-center gap-3">
            <span className={clsx("rounded-lg px-3 py-2 text-[14px] font-bold", d.writeEnabledEnv && !d.dryRunEnv ? "bg-warn/20 text-warn" : "bg-surface-3 text-ink-2")}>
              {d.writeEnabledEnv && !d.dryRunEnv ? "ON" : "OFF"}
            </span>
            <span className="text-[13px] text-ink-3">
              Только индикатор (переменные сервера): WRITE_ENABLED={String(d.writeEnabledEnv)}, WRITE_DRY_RUN={String(d.dryRunEnv)}, WRITE_SCOPE={d.scope}. Меняется в Render → Environment, не здесь.
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {d.paused.on
              ? btn("pause", "▶ RESUME WRITES", () => confirm("Снять паузу записи?") && post("pause", { action: "pause", on: false }), "bg-surface-3")
              : btn("pause", "⏸ PAUSE ALL WRITES", () => post("pause", { action: "pause", on: true }), "bg-crit/25 text-crit-ink")}
            <span className="text-[13px] text-ink-3">
              {d.paused.on ? `Пауза с ${fmt(d.paused.at)} (${d.paused.by}). Любые загрузки, снятия и списания блокируются до отправки. Чтение работает.` : "Мгновенно блокирует любую запись (флаг в базе). Чтение продолжает работать."}
            </span>
          </div>
        </Card>

        {/* ── connection ── */}
        <Card title="Соединение (только чтение)">
          {btn("check", "ПРОВЕРИТЬ СОЕДИНЕНИЕ", async () => setCheck(await post<Check>("check", { action: "check" })), "bg-accent/20 text-accent", !d.readEnabled)}
          {!d.readEnabled && <p className="mt-2 text-[13px] text-warn">Чтение KiT Shop выключено в настройках сервера (ENABLED=false).</p>}
          {check && (
            <div className="mt-3 text-[13px]">
              <div className={check.auth === "PASS" ? "text-good-ink" : "text-crit-ink"}>
                CheckAuth: {check.auth} · {check.ms} ms · Sign {check.signCase}
              </div>
              {check.note && <div className="mt-1 text-warn">{check.note}</div>}
              {check.shops.length > 0 && <div className="mt-1 text-ink-3">GetShops: {check.shops.length} точек</div>}
            </div>
          )}
        </Card>

        {/* ── test shop / product ── */}
        <Card title="TEST SHOP">
          <p className="text-[13px] text-ink-3">Одна точка для первого теста. Хранится стабильный KiT Shop ShopId. Для реальной записи она же должна быть единственной в списке WRITE_SHOPS на сервере.</p>
          <select
            value={d.testShop?.shopId ?? ""}
            disabled={!!busy}
            onChange={(e) => e.target.value && post("shop", { action: "set-test-shop", shopId: e.target.value })}
            className="mt-2 h-10 w-full max-w-md rounded-lg border border-line bg-surface px-3 text-[14px]"
          >
            <option value="">— выберите —</option>
            {d.fridges
              .filter((f) => f.shopId)
              .map((f) => {
                const ks = check?.shops.find((s) => s.shopId === f.shopId);
                return (
                  <option key={f.id} value={f.shopId!}>
                    {f.name} · ShopId {f.shopId}
                    {allowed.has(f.shopId!) ? " · в allowlist" : ""}
                    {ks ? (ks.stocksAccounting === false ? " · учёт остатков ВЫКЛ" : " · есть в KiT Shop") : ""}
                  </option>
                );
              })}
          </select>
        </Card>

        <Card title="TEST PRODUCT">
          {d.testProduct ? (
            <p className="text-[14px]">
              {d.testProduct.name} · ProductId {d.testProduct.productId} · штрихкод {d.testProduct.barcode ?? "—"}
            </p>
          ) : (
            <p className="text-[13px] text-ink-3">Не выбран.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ProductId, штрихкод или название (пусто — остатки точки)" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[14px]" />
            {btn("products", "ПОКАЗАТЬ", async () => {
              const r = await post<{ items: Candidate[] }>("products", { action: "products", q });
              if (r) setCands(r.items);
            }, "bg-surface-3", !d.testShop || !d.readEnabled)}
          </div>
          {cands && (
            <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
              {cands.length === 0 && <p className="text-[13px] text-ink-3">Ничего не найдено (или учёт остатков на точке не ведётся).</p>}
              {cands.map((c) => (
                <button
                  key={c.productId}
                  disabled={!!busy}
                  onClick={() => post("product", { action: "set-test-product", productId: c.productId, name: c.name, barcode: c.barcode }).then(() => setCands(null))}
                  className="flex w-full justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-left text-[13px] active:bg-surface-3"
                >
                  <span>
                    {c.name} <span className="text-ink-3">#{c.productId} · {c.barcode ?? "—"}</span>
                  </span>
                  <span className="num shrink-0">остаток {c.stock}</span>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* ── wizard ── */}
        <Card title="REAL WRITE TEST">
          <p className="text-[13px] text-ink-3">
            Одна точка, один товар, +1 и обратно −1. Ничего не отправляется без кнопки «ПОДТВЕРДИТЬ». Успех засчитывается только если остаток, прочитанный из KiT Shop после операции, совпал с ожидаемым.
          </p>
          <p className={clsx("mt-2 text-[13px]", d.liveBlocked ? "text-warn" : "text-good-ink")}>
            {d.liveBlocked ? `Реальная запись сейчас невозможна: ${d.liveBlocked}` : "Реальная запись для тестовой точки разрешена сервером (только из этого мастера)."}
          </p>
          <div className="mt-3">{btn("start", run ? "НАЧАТЬ НОВЫЙ ТЕСТ" : "НАЧАТЬ ТЕСТ", () => post("start", { action: "test-start" }), "bg-surface-3", !d.testShop || !d.testProduct)}</div>

          {run && (
            <div className="mt-4 space-y-4">
              <div className="text-[13px] text-ink-3">
                Тест {run.id.slice(0, 8)} · {run.shop.name} (ShopId {run.shop.shopId}) · {run.product.name} (ProductId {run.product.productId}) · начат {fmt(run.startedAt)} ({run.startedBy})
              </div>

              <Step n={1} title="Проверка подключения" result={run.auth?.result ?? "PENDING"}>
                {run.auth && <div className="text-[13px] text-ink-3">{run.auth.detail} · {run.auth.ms} ms</div>}
                {btn("t-check", "ПРОВЕРИТЬ", () => post("t-check", { action: "test-check" }), "bg-surface-3", !d.readEnabled)}
              </Step>

              <LegView n={2} leg={run.load} kind="LOAD" run={run} busy={busy} post={post} enabled={run.auth?.result === "PASS"} blocked={d.liveBlocked} paused={d.paused.on} />
              <LegView n={3} leg={run.unload} kind="UNLOAD" run={run} busy={busy} post={post} enabled={run.load?.result === "PASS"} blocked={d.liveBlocked} paused={d.paused.on} />

              <div className="rounded-xl border border-line-strong p-4">
                <div className="text-[15px] font-bold">KITSHOP WRITE VALIDATION</div>
                <div className="mt-2 space-y-1 text-[14px]">
                  {d.summary.lines.map((l) => (
                    <div key={l.label} className="flex justify-between gap-3">
                      <span>{l.label}</span>
                      <span className={clsx("font-semibold", TONE[l.result])}>{l.result}</span>
                    </div>
                  ))}
                </div>
                <div className={clsx("mt-3 text-[16px] font-bold", d.summary.ready ? "text-good-ink" : "text-warn")}>
                  Production write readiness: {d.summary.ready ? "READY" : "NOT READY"}
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card title="Последние запросы к KiT Shop">
          {d.calls.length === 0 ? (
            <p className="text-[13px] text-ink-3">С момента запуска сервера запросов не было.</p>
          ) : (
            <table className="w-full text-[12px]">
              <tbody>
                {d.calls.map((c) => (
                  <tr key={c.method} className="border-b border-line">
                    <td className="py-1.5">{c.method}</td>
                    <td>{fmt(c.at)}</td>
                    <td className="num">{c.ms} ms</td>
                    <td className={c.ok ? "text-good-ink" : "text-crit-ink"}>{c.ok ? `OK (${c.resultCode})` : (c.error ?? c.resultCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </Shell>
  );
}

function LegView({
  n,
  leg,
  kind,
  run,
  busy,
  post,
  enabled,
  blocked,
  paused,
}: {
  n: number;
  leg: TestLeg | null;
  kind: "LOAD" | "UNLOAD";
  run: NonNullable<Diag["run"]>;
  busy: string | null;
  post: (key: string, body: Record<string, unknown>) => Promise<unknown>;
  enabled: boolean;
  blocked: string | null;
  paused: boolean;
}) {
  const sign = kind === "LOAD" ? "+1" : "−1";
  const label = kind === "LOAD" ? "ЗАГРУЗКУ +1" : "СНЯТИЕ −1";
  const b = (key: string, text: string, body: Record<string, unknown>, tone: string, disabled = false) => (
    <button onClick={() => post(key, body)} disabled={!!busy || disabled} className={clsx("h-10 rounded-lg px-4 text-[13px] font-semibold disabled:opacity-40", tone)}>
      {busy === key ? "…" : text}
    </button>
  );
  return (
    <Step n={n} title={`${kind === "LOAD" ? "ЗАГРУЗКА" : "СНЯТИЕ"} ${sign}`} result={leg?.result ?? "PENDING"}>
      {!enabled && <div className="text-[13px] text-ink-3">{kind === "LOAD" ? "После успешной проверки подключения." : "Только после успешной загрузки +1."}</div>}
      {enabled && !leg?.sentAt && b(`prep-${kind}`, leg ? "ОБНОВИТЬ ОСТАТОК И UUID" : "ПОЛУЧИТЬ ОСТАТОК И ПОДГОТОВИТЬ", { action: "test-prepare", kind }, "bg-surface-3")}
      {leg && (
        <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-ink-3">Shop / ShopId</dt>
          <dd>
            {run.shop.name} · {run.shop.shopId}
          </dd>
          <dt className="text-ink-3">Product / ProductId</dt>
          <dd>
            {run.product.name} · {run.product.productId}
          </dd>
          <dt className="text-ink-3">Barcode</dt>
          <dd>{run.product.barcode ?? "—"}</dd>
          <dt className="text-ink-3">Quantity</dt>
          <dd>{sign}</dd>
          <dt className="text-ink-3">Operation UUID</dt>
          <dd className="font-mono">{leg.opId}</dd>
          <dt className="text-ink-3">Notes</dt>
          <dd className="font-mono">{leg.notes}</dd>
          <dt className="text-ink-3">Before</dt>
          <dd className="num">{leg.before ?? "—"}</dd>
          <dt className="text-ink-3">Expected</dt>
          <dd className="num">{leg.expected ?? "—"}</dd>
          <dt className="text-ink-3">Actual</dt>
          <dd className="num">{leg.actual ?? "—"}</dd>
          <dt className="text-ink-3">Статус операции</dt>
          <dd>{leg.opStatus ?? "не отправлено"}</dd>
          <dt className="text-ink-3">Ответ KiT Shop</dt>
          <dd>{leg.responseMs !== null ? `${leg.responseMs} ms` : "—"}</dd>
          <dt className="text-ink-3">UUID в GetFillUps</dt>
          <dd>{leg.fillUpsMatch ?? "—"}</dd>
        </dl>
      )}
      {leg?.detail && <div className={clsx("text-[13px]", TONE[leg.result])}>{leg.detail}</div>}
      {leg && !leg.sentAt && (
        <div className="space-y-1">
          {b(
            `confirm-${kind}`,
            `ПОДТВЕРДИТЬ ТЕСТОВУЮ ${label}`,
            { action: "test-confirm", kind, opId: leg.opId },
            "bg-warn/25 text-warn",
            !!blocked || paused,
          )}
          {(blocked || paused) && <div className="text-[12px] text-ink-3">Кнопка недоступна: {paused ? "пауза записи" : blocked}</div>}
        </div>
      )}
      {leg?.sentAt && leg.result !== "PASS" && leg.result !== "FAIL" && b(`eval-${kind}`, "ПРОВЕРИТЬ ЕЩЁ РАЗ (только чтение)", { action: "test-evaluate", kind }, "bg-surface-3")}
    </Step>
  );
}

function Step({ n, title, result, children }: { n: number; title: string; result: StepResult; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[14px] font-bold">
          ШАГ {n} · {title}
        </span>
        <span className={clsx("text-[13px] font-semibold", TONE[result])}>{result}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="label mb-2">{title}</div>
      {children}
    </section>
  );
}

function Tile({ label, value, tone, small }: { label: string; value: string; tone?: "good" | "bad" | "warn"; small?: boolean }) {
  return (
    <div className={clsx("card px-3 py-2", tone === "bad" && "border-crit/50", tone === "warn" && "border-warn/50")}>
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={clsx("mt-0.5 break-words font-semibold", small ? "text-[12px]" : "text-[16px]", tone === "good" && "text-good-ink", tone === "bad" && "text-crit-ink", tone === "warn" && "text-warn")}>
        {value}
      </div>
    </div>
  );
}

// ───────────────────────── REAL API TEST ─────────────────────────

const REAL_TONE: Record<StepStatus, string> = { PASS: "text-good-ink", FAIL: "text-crit-ink", WARN: "text-warn", NOT_TESTED: "text-ink-3" };
const REAL_LABEL: Record<StepStatus, string> = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN", NOT_TESTED: "NOT TESTED" };

/** Five independent steps — never one generic "connected". Read-only; never mock data. */
function RealApiTest({ d, busy, run, runAuth }: { d: Diag; busy: string | null; run: () => void; runAuth: () => void }) {
  const r: RealDiagnosticReport | null = d.realTest;
  const byId = (id: RealStep["id"]) => r?.steps.find((x) => x.id === id);
  const status = (id: RealStep["id"]): StepStatus => byId(id)?.status ?? "NOT_TESTED";
  // HTTPS also fails when the endpoint itself does not answer as KiT Shop
  const https: StepStatus = status("https") === "FAIL" || status("endpoint") === "FAIL" ? "FAIL" : status("https");
  const chips: [string, StepStatus][] = [
    ["HTTPS", r ? https : "NOT_TESTED"],
    ["AUTH", status("auth")],
    ["SHOPS", status("shops")],
    ["STOCKS", status("stocks")],
    ["SALES", status("sales")],
  ];
  return (
    <section className={clsx("card p-4", d.target.real && "border-crit/50")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="label">REAL API TEST · только чтение</div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={runAuth}
            disabled={!!busy || (!d.target.realDiagnostics && !d.target.readEnabled)}
            className="h-10 rounded-lg bg-surface-3 px-4 text-[13px] font-semibold disabled:opacity-40"
          >
            {busy === "real-auth" ? "Проверяем…" : "ТОЛЬКО CheckAuth"}
          </button>
          <button
            onClick={run}
            disabled={!!busy || (!d.target.realDiagnostics && !d.target.readEnabled)}
            className="h-10 rounded-lg bg-crit/25 px-4 text-[13px] font-semibold text-crit-ink disabled:opacity-40"
          >
            {busy === "real" ? "Проверяем…" : "ЗАПУСТИТЬ REAL API TEST"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-[12px] text-ink-3">
        CheckAuth → GetShops → GetShopStocks (одна точка) → GetSales (последний час). Через тот же клиент, что и приложение. Никаких записей, никаких данных симулятора.
        {!d.target.realDiagnostics && !d.target.readEnabled && " Выключено: задайте REAL_DIAGNOSTICS=true в переменных сервера."}
      </p>
      <div className="mt-3 grid grid-cols-5 gap-2">
        {chips.map(([label, st]) => (
          <div key={label} className="rounded-lg bg-surface-2 px-2 py-2 text-center">
            <div className="text-[11px] text-ink-3">{label}</div>
            <div className={clsx("text-[13px] font-bold", REAL_TONE[st])}>{REAL_LABEL[st]}</div>
          </div>
        ))}
      </div>
      {r && (
        <>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-ink-3">Environment</dt>
              <dd>{r.environment}</dd>
              <dt className="text-ink-3">API host</dt>
              <dd className={r.realHost ? "" : "text-warn"}>{r.apiHost}{r.realHost ? "" : " (НЕ настоящий KiT Shop)"}</dd>
              <dt className="text-ink-3">Проверено</dt>
              <dd>{fmt(r.at)}</dd>
              <dt className="text-ink-3">Sign принят</dt>
              <dd>{r.signCaseAccepted ?? "—"}</dd>
            </dl>
            <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-[13px]">
              {(
                [
                  ["Transport", r.summary.transport],
                  ["Authentication", r.summary.authentication],
                  ["API permission", r.summary.permission],
                  ["Company", r.summary.company],
                  ["Shops", r.summary.shops],
                  ["Stocks", r.summary.stocks],
                  ["Sales", r.summary.sales],
                ] as [string, StepStatus][]
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className={clsx("font-semibold", REAL_TONE[v])}>{REAL_LABEL[v]}</dd>
                </div>
              ))}
            </dl>
          </div>
          {r.failingStep ? (
            <div className="mt-3 rounded-lg border border-crit/50 bg-crit/10 px-3 py-2 text-[13px]">
              <b className="text-crit-ink">REAL KITSHOP UNAVAILABLE</b> — падает шаг «{r.failingStep}»{r.failingCategory ? `, категория ${r.failingCategory}` : ""}.
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-good/50 bg-good/10 px-3 py-2 text-[13px] text-good-ink">Все шаги прошли на реальном KiT Shop.</div>
          )}
          <div className="mt-4 space-y-2">
            {r.steps.map((st) => (
              <details key={st.id} className="rounded-lg bg-surface-2 px-3 py-2" open={st.status === "FAIL"}>
                <summary className="cursor-pointer text-[13px]">
                  <span className={clsx("mr-2 font-bold", REAL_TONE[st.status])}>{REAL_LABEL[st.status]}</span>
                  {st.title}
                  {st.category && <span className="ml-2 rounded bg-crit/20 px-1.5 text-[11px] text-crit-ink">{st.category}</span>}
                  {st.ms !== null && <span className="ml-2 text-ink-3">{st.ms} ms</span>}
                  {st.message && <span className="ml-2 text-ink-3">— {st.message}</span>}
                </summary>
                <dl className="mt-2 grid grid-cols-[170px_1fr] gap-x-3 gap-y-0.5 text-[12px]">
                  {Object.entries(st.details)
                    .filter(([, v]) => v !== null && v !== "")
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-ink-3">{k}</dt>
                        <dd className="break-all font-mono">{String(v)}</dd>
                      </div>
                    ))}
                </dl>
                {st.rows && st.rows.length > 0 && (
                  <table className="mt-2 w-full text-[12px]">
                    <tbody>
                      {st.rows.map((row, i) => (
                        <tr key={i} className="border-t border-line">
                          {Object.entries(row).map(([k, v]) => (
                            <td key={k} className="py-1 pr-3 font-mono">
                              <span className="text-ink-3">{k}=</span>
                              {String(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
