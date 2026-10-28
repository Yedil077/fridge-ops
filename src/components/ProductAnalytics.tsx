"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { api, useProductAnalytics, type ProductAnalyticsView } from "@/lib/client/api";
import type { SheetCompare } from "@/lib/server/sheetCompare";

type Row = ProductAnalyticsView["products"][number];
type Check = ProductAnalyticsView["fridge"]["checks"][number];

const STATUS_CLS: Record<Row["status"], string> = {
  NORMAL: "bg-good/15 text-good-ink",
  MORE: "bg-crit/15 text-crit-ink",
  TOO_MUCH: "bg-warn/20 text-warn",
  LESS: "bg-warn/20 text-warn",
  RARE: "bg-surface-3 text-ink-2",
  NO_DATA: "bg-surface-3 text-ink-3",
  UNUSED: "bg-surface-3 text-ink-3",
};
const QUALITY_CLS: Record<Row["quality"], string> = { GOOD: "text-good-ink", INCOMPLETE: "text-warn", BAD: "text-crit-ink" };
const CHECK_ICON: Record<Check["level"], string> = { OK: "✅", WARN: "⚠️", FAIL: "❌" };

const FILTERS = [
  { id: "all", label: "Все", test: () => true },
  { id: "high", label: "Высокий спрос", test: (r: Row) => r.demand === "HIGH" },
  { id: "low", label: "Низкий спрос", test: (r: Row) => r.demand === "LOW" || r.status === "RARE" },
  { id: "out", label: "Часто не хватает", test: (r: Row) => r.status === "MORE" },
  { id: "much", label: "Много остатков/снятий", test: (r: Row) => r.status === "TOO_MUCH" || r.status === "LESS" },
  { id: "need", label: "Добавить сегодня", test: (r: Row) => (r.today?.need ?? 0) > 0 },
  { id: "new", label: "Новые", test: (r: Row) => r.isNew },
  { id: "nodata", label: "Нет данных", test: (r: Row) => r.status === "NO_DATA" },
  { id: "unused", label: "Не используются", test: (r: Row) => r.status === "UNUSED" },
] as const;

type SortKey = "name" | "sold7" | "sold30" | "days" | "loaded" | "stock" | "norm" | "need" | "quality" | "status";
const SORTS: Record<SortKey, (r: Row) => number | string> = {
  name: (r) => r.name,
  sold7: (r) => r.sold.d7,
  sold30: (r) => r.sold.d30,
  days: (r) => r.salesDays30,
  loaded: (r) => r.removed30 + r.writtenOff30,
  stock: (r) => r.stock,
  norm: (r) => r.norm?.rec ?? -1,
  need: (r) => (r.today?.need ?? 0) * 100 - (r.today?.surplus ?? 0),
  quality: (r) => ["BAD", "INCOMPLETE", "GOOD"].indexOf(r.quality),
  status: (r) => ["MORE", "TOO_MUCH", "LESS", "RARE", "NORMAL", "NO_DATA", "UNUSED"].indexOf(r.status),
};

const pcs = (n: number) => `${n} шт.`;
const range = (a: number, b: number) => (a === b ? pcs(a) : `${a}–${b} шт.`);
const STORE_KEY = "analytics-fridge";

export function ProductAnalytics({ mobile = false }: { mobile?: boolean }) {
  const [fridgeId, setFridgeId] = useState<string | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORE_KEY);
      if (v) setFridgeId(v);
    } catch {
      /* private mode */
    }
  }, []);
  const pick = (id: string) => {
    setFridgeId(id);
    try {
      localStorage.setItem(STORE_KEY, id);
    } catch {
      /* private mode */
    }
  };
  const { data, error, isFetching } = useProductAnalytics(fridgeId);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "sold30", desc: true });
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!data) return [];
    const f = FILTERS.find((x) => x.id === filter)!;
    const needle = q.trim().toLowerCase();
    const get = SORTS[sort.key];
    return data.products
      .filter((r) => f.test(r) && (!needle || r.name.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const x = get(a);
        const y = get(b);
        const c = typeof x === "string" ? x.localeCompare(String(y), "ru") : x - (y as number);
        return sort.desc ? -c : c;
      });
  }, [data, filter, q, sort]);

  if (error) return <p className="p-6 text-crit-ink">{(error as Error).message}</p>;
  if (!data) return <p className="p-6 text-ink-3">Считаю продажи, загрузки и снятия по каждому блюду…</p>;

  const s = data.fridge.summary;
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, data.products.filter((r) => f.test(r)).length]));
  const detail = data.products.find((r) => r.productId === open) ?? null;
  const groups = [...new Set(data.fridges.map((f) => f.group ?? "без группы"))];

  return (
    <div>
      {/* 1. fridge */}
      <div className={clsx("mb-3 flex flex-wrap items-center gap-3", mobile && "flex-col items-stretch")}>
        <select value={data.fridge.id} onChange={(e) => pick(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[16px] font-bold" aria-label="Холодильник">
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {data.fridges
                .filter((f) => (f.group ?? "без группы") === g)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <span className="text-[12px] text-ink-3">
          {data.fridge.group ? `группа ${data.fridge.group} · ` : ""}блюд: {data.data.productsHere}
          {isFetching ? " · обновляю…" : ""}
        </span>
      </div>

      {/* 2. summary — whole units */}
      <section className={clsx("card grid gap-px overflow-hidden bg-line p-0", mobile ? "grid-cols-2" : "grid-cols-3 lg:grid-cols-6")}>
        <Kpi label="Продано за 30 дн." value={pcs(s.sold30)} />
        <Kpi label="Загружено за 30 дн." value={pcs(s.loaded30)} />
        <Kpi label="Снято за 30 дн." value={pcs(s.removed30)} sub="разгрузки: перенос, возврат…" />
        <Kpi label="Списано (подтверждено)" value={pcs(s.writtenOff30)} sub="операции «Списание» KiT Shop" />
        <Kpi label="Сейчас в холодильнике" value={pcs(s.stockNow)} />
        <Kpi label="Блюд: больше / меньше" value={`${s.more} / ${s.tooMuch}`} sub={`добавить сегодня: ${s.needNow} · забрать: ${s.canGiveNow}`} />
      </section>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {data.fridge.categories
          .filter((c) => c.sold30 > 0)
          .map((c) => (
            <span key={c.id}>
              {c.emoji} {c.name}: <b className={clsx(c.level === "высокий спрос" ? "text-good-ink" : c.level === "низкий спрос" ? "text-warn" : "text-ink")}>{c.level}</b>
              <span className="text-ink-3"> ({pcs(c.sold30)} за 30 дн.)</span>
            </span>
          ))}
      </div>

      <Checks checks={data.fridge.checks} />
      {data.data.notes.map((n) => (
        <p key={n} className="mt-2 rounded-xl bg-warn/10 px-3 py-2 text-[12px] text-ink-2">⚠ {n}</p>
      ))}
      <SheetCompareBox fridgeId={data.fridge.id} />

      {/* 3. all products */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск блюда" className={clsx("h-10 rounded-xl border border-line bg-surface px-3 text-[15px]", mobile ? "w-full" : "w-64")} />
        {mobile && (
          <select value={sort.key} onChange={(e) => setSort({ key: e.target.value as SortKey, desc: e.target.value !== "name" })} className="h-10 flex-1 rounded-xl border border-line bg-surface px-2 text-[14px]" aria-label="Сортировка">
            <option value="sold30">по продажам</option>
            <option value="need">что добавить сегодня</option>
            <option value="loaded">по снятиям и списаниям</option>
            <option value="stock">по остатку</option>
            <option value="quality">по качеству данных</option>
            <option value="name">по названию</option>
          </select>
        )}
      </div>
      <div className={clsx("mt-2 flex gap-1.5", mobile ? "-mx-1 overflow-x-auto px-1 pb-1" : "flex-wrap")}>
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={clsx("h-9 shrink-0 rounded-lg px-3 text-[13px] font-semibold", filter === f.id ? "bg-ink text-bg" : "bg-surface-2 text-ink-2")}>
            {f.label} <span className="opacity-60">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {mobile ? (
        <div className="mt-3 space-y-2">
          {rows.map((r) => (
            <button key={r.productId} onClick={() => setOpen(r.productId)} className="card block w-full p-3 text-left">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-[15px] font-semibold leading-snug">{r.name}</div>
                <StatusChip r={r} />
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[12px] text-ink-2">
                <span>30 дн.: <b className="text-ink">{pcs(r.sold.d30)}</b></span>
                <span>есть: <b className="text-ink">{pcs(r.stock)}</b></span>
                <span>норма: <b className="text-ink">{r.norm ? pcs(r.norm.rec) : "—"}</b></span>
              </div>
              <div className="mt-0.5 text-[12px] text-ink-3">
                покупали в {r.salesDays30} дн. из {r.openDays30} · данные: <span className={QUALITY_CLS[r.quality]}>{r.qualityText}</span>
              </div>
              <TodayLine r={r} />
            </button>
          ))}
        </div>
      ) : (
        <div className="card mt-3 overflow-x-auto p-0">
          <table className="w-full min-w-[1080px] text-[13px] [&_td]:px-2 [&_th]:px-2">
            <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                <Th k="name" sort={sort} setSort={setSort}>Блюдо</Th>
                <Th k="sold7" sort={sort} setSort={setSort} right>Продано 7д</Th>
                <Th k="sold30" sort={sort} setSort={setSort} right>Продано 30д</Th>
                <Th k="days" sort={sort} setSort={setSort} right title="дней с продажами из открытых дней холодильника">Дней с продажами</Th>
                <th className="py-2 text-right" title="сколько штук уходило в день, когда покупали">Обычно</th>
                <Th k="loaded" sort={sort} setSort={setSort} right title="загружено / снято / подтверждённо списано за 30 дней">Загр. / снято / спис.</Th>
                <Th k="stock" sort={sort} setSort={setSort} right>Остаток</Th>
                <Th k="norm" sort={sort} setSort={setSort} right>Норма (мин–макс)</Th>
                <Th k="need" sort={sort} setSort={setSort} right>Сегодня</Th>
                <Th k="quality" sort={sort} setSort={setSort}>Данные</Th>
                <Th k="status" sort={sort} setSort={setSort}>Статус</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.productId} onClick={() => setOpen(r.productId)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="py-2">
                    <div className="font-semibold">{r.name}</div>
                    <div className="text-[11px] text-ink-3">
                      {r.category.emoji} {r.category.name}
                      {r.isNew ? " · НОВОЕ" : ""}
                    </div>
                  </td>
                  <td className="num text-right">{r.sold.d7}</td>
                  <td className="num text-right">{r.sold.d30}</td>
                  <td className="num text-right">
                    {r.salesDays30} <span className="text-ink-3">из {r.openDays30}</span>
                  </td>
                  <td className="num whitespace-nowrap text-right">{r.usual ? range(r.usual.low, r.usual.high) : "—"}</td>
                  <td className="num whitespace-nowrap text-right">
                    {r.loaded30} / {r.removed30} / <span className={r.writtenOff30 ? "text-crit-ink" : ""}>{r.writtenOff30}</span>
                  </td>
                  <td className="num text-right">{r.stock}</td>
                  <td className="num whitespace-nowrap text-right font-bold">{r.norm ? (r.norm.rec === 0 ? "не ежедневно" : `${r.norm.rec} (${r.norm.min}–${r.norm.max})`) : "—"}</td>
                  <td className="whitespace-nowrap text-right">
                    <TodayCell r={r} />
                  </td>
                  <td className={clsx("whitespace-nowrap text-[12px] font-semibold", QUALITY_CLS[r.quality])} title={r.qualityReason}>
                    {r.qualityText}
                  </td>
                  <td>
                    <StatusChip r={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="p-6 text-center text-ink-3">Ничего не найдено</p>}
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-3">Все количества — целые штуки. Нажмите на блюдо — подробный разбор и «почему».</p>

      <details className="mt-4 text-[12px] text-ink-2">
        <summary className="cursor-pointer font-semibold">Как считается норма и откуда данные</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {data.data.formula.map((x) => (
            <li key={x}>{x}</li>
          ))}
          <li>
            Продажи по блюдам полные с {data.data.salesFrom ?? "—"}; загрузки/снятия — с {data.data.fillupsFrom ?? "ещё не прочитаны"}; история остатков (каждые 5 минут) — с{" "}
            {data.data.stockHistoryFrom ?? "только начинает копиться"}.
          </li>
          <li>Списание = {data.data.writeOffRule ?? "не определяется"}.</li>
          <li>Всего блюд в анализе по всем холодильникам: {data.data.productsAll}.</li>
        </ul>
      </details>

      {detail && <ProductDetail r={detail} fridge={data.fridge.name} untilTime={data.untilTime} onClose={() => setOpen(null)} mobile={mobile} />}
    </div>
  );
}

function Checks({ checks }: { checks: Check[] }) {
  const bad = checks.filter((c) => c.level !== "OK");
  const [open, setOpen] = useState(false);
  if (!checks.length) return null;
  const fail = checks.some((c) => c.level === "FAIL");
  return (
    <section className={clsx("mt-3 rounded-xl px-3 py-2 text-[12px]", fail ? "bg-crit/10" : bad.length ? "bg-warn/10" : "bg-good/10")}>
      <button onClick={() => setOpen(!open)} className="w-full text-left font-semibold">
        {fail ? "❌ Проверка данных не пройдена — нормы этой точки не уверенные" : bad.length ? `⚠️ Проверка данных: ${bad.length} замечаний` : "✅ Проверка данных пройдена"}
        <span className="ml-2 font-normal text-ink-3">{open ? "скрыть" : "подробнее"}</span>
      </button>
      {checks.some((c) => (c.id === "clock" || c.id === "fresh") && c.level === "FAIL") && (
        <a href="/admin/kitshop/clock" className="mt-1 block font-semibold underline">
          Диагностика времени и новых чеков на реальных ответах KiT Shop (для администратора) →
        </a>
      )}
      {(open ? checks : bad.filter((c) => c.level === "FAIL")).map((c) => (
        <div key={c.id} className="mt-1 flex gap-2">
          <span>{CHECK_ICON[c.level]}</span>
          <span>
            <b>{c.label}:</b> {c.detail}
          </span>
        </div>
      ))}
    </section>
  );
}

function SheetCompareBox({ fridgeId }: { fridgeId: string }) {
  const [state, setState] = useState<{ loading: boolean; data: (SheetCompare & { fridge: string }) | null; error: string | null }>({ loading: false, data: null, error: null });
  useEffect(() => setState({ loading: false, data: null, error: null }), [fridgeId]);
  const run = async () => {
    setState({ loading: true, data: null, error: null });
    try {
      setState({ loading: false, data: await api<SheetCompare & { fridge: string }>(`/api/analytics/sheet-compare?fridge=${encodeURIComponent(fridgeId)}`), error: null });
    } catch (e) {
      setState({ loading: false, data: null, error: (e as Error).message });
    }
  };
  const d = state.data;
  const LABEL = { sold: "Продано", loaded: "Загружено", unloaded: "Снято", writtenOff: "Списано" } as const;
  return (
    <section className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <b>Сверка с Google Sheets</b>
        <span className="text-ink-3">30 полных дней: KiT Shop (наша копия) ↔ таблица «Интеграция kitshop»</span>
        <button onClick={run} disabled={state.loading} className="ml-auto h-8 rounded-lg bg-ink px-3 font-semibold text-bg disabled:opacity-50">
          {state.loading ? "Сверяю…" : d ? "Сверить ещё раз" : "Сверить"}
        </button>
      </div>
      {state.error && <p className="mt-1 text-crit-ink">{state.error}</p>}
      {d && !d.configured && <p className="mt-1 text-ink-2">Таблица не подключена: на сервере нужна переменная GOOGLE_SHEET_ID (id из ссылки на таблицу).</p>}
      {d && d.configured && (
        <div className="mt-2">
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {(Object.keys(LABEL) as (keyof typeof LABEL)[]).map((k) => (
              <div key={k} className={clsx("rounded-lg bg-surface px-2 py-1", d.totals[k].ours !== d.totals[k].sheet && "ring-1 ring-warn")}>
                <div className="text-ink-3">{LABEL[k]}</div>
                <div className="num font-semibold">
                  {d.totals[k].ours} <span className="text-ink-3">vs</span> {d.totals[k].sheet}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-ink-3">
            {d.time.sheetMinusOursMinutes === null
              ? "Время чеков сравнить не удалось."
              : d.time.sheetMinusOursMinutes === 0
                ? `Время одних и тех же чеков совпадает (${d.time.checked} чеков).`
                : `Время одних и тех же чеков в таблице отличается на ${d.time.sheetMinusOursMinutes > 0 ? "+" : ""}${d.time.sheetMinusOursMinutes} мин (${d.time.checked} чеков) — учтено при сравнении по дням.`}
            {d.receiptsUndetailed ? ` У нас ещё ${d.receiptsUndetailed} чеков без состава.` : ""}
            {d.fillupsUndetailed ? ` ${d.fillupsUndetailed} загрузок/снятий без состава.` : ""}
          </p>
          {d.mismatches.length === 0 ? (
            <p className="mt-1 font-semibold text-good-ink">Расхождений по {d.products} блюдам нет.</p>
          ) : (
            <div className="mt-1 max-h-72 overflow-auto">
              <table className="w-full text-[12px]">
                <thead className="text-left text-ink-3">
                  <tr>
                    <th className="py-1">Блюдо ({d.mismatches.length} с расхождениями)</th>
                    <th className="text-right">Продано</th>
                    <th className="text-right">Загружено</th>
                    <th className="text-right">Снято</th>
                    <th className="text-right">Списано</th>
                  </tr>
                </thead>
                <tbody>
                  {d.mismatches.slice(0, 100).map((m) => (
                    <tr key={m.productId} className="border-t border-line">
                      <td className="py-1">{m.name}</td>
                      {(["sold", "loaded", "unloaded", "writtenOff"] as const).map((k) => (
                        <td key={k} className={clsx("num whitespace-nowrap text-right", m.ours[k] !== m.sheet[k] && "font-bold text-warn")}>
                          {m.ours[k]} / {m.sheet[k]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-ink-3">В каждой ячейке: наша копия KiT Shop / таблица.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Th({ k, sort, setSort, right, title, children }: { k: SortKey; sort: { key: SortKey; desc: boolean }; setSort: (s: { key: SortKey; desc: boolean }) => void; right?: boolean; title?: string; children: React.ReactNode }) {
  const on = sort.key === k;
  return (
    <th className={clsx("cursor-pointer select-none whitespace-nowrap py-2", right && "text-right", on && "text-ink")} title={title} onClick={() => setSort({ key: k, desc: on ? !sort.desc : k !== "name" })}>
      {children}
      {on ? (sort.desc ? " ↓" : " ↑") : ""}
    </th>
  );
}

function StatusChip({ r }: { r: Row }) {
  return (
    <span className={clsx("whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold", STATUS_CLS[r.status])} title={r.statusReason}>
      {r.statusText}
    </span>
  );
}

function TodayCell({ r }: { r: Row }) {
  const t = r.today;
  if (!t || !r.norm) return <span className="text-ink-3">—</span>;
  if (t.need > 0) return <span className="font-bold text-crit-ink">добавить {pcs(t.need)}</span>;
  if (t.surplus > 0) return <span className="font-semibold text-good-ink">забрать {pcs(t.surplus)}</span>;
  return <span className="text-ink-3">хватает</span>;
}

function TodayLine({ r }: { r: Row }) {
  const t = r.today;
  if (!t || !r.norm || (t.need === 0 && t.surplus === 0)) return null;
  return (
    <div className={clsx("mt-1 text-[13px] font-semibold", t.need > 0 ? "text-crit-ink" : "text-good-ink")}>
      Сегодня иметь {pcs(t.target)}, сейчас {pcs(t.stock)} → {t.need > 0 ? `добавить ${pcs(t.need)}` : `можно забрать ${pcs(t.surplus)}`}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="label leading-tight">{label}</div>
      <div className="num mt-1 text-[22px] font-semibold leading-none">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

function ProductDetail({ r, fridge, untilTime, onClose, mobile }: { r: Row; fridge: string; untilTime: string; onClose: () => void; mobile: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const t = r.today;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className={clsx("h-full overflow-y-auto bg-bg p-4 shadow-xl", mobile ? "w-full" : "w-[520px]")} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={r.name}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[20px] font-bold uppercase leading-tight">{r.name}</h2>
            <div className="text-[13px] text-ink-3">
              {fridge} · {r.category.emoji} {r.category.name}
              {r.isNew ? " · НОВОЕ" : ""}
            </div>
          </div>
          <button onClick={onClose} className="h-9 w-9 shrink-0 rounded-lg bg-surface-2 text-[18px]" aria-label="Закрыть">
            ×
          </button>
        </div>

        <section className="card mt-3 p-4">
          <div className="text-[22px] font-bold leading-tight">{r.recommendation}</div>
          {r.norm && r.norm.rec > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <Big label="минимум" value={pcs(r.norm.min)} />
              <Big label="норма" value={pcs(r.norm.rec)} strong />
              <Big label="максимум" value={pcs(r.norm.max)} />
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
            <StatusChip r={r} />
            <span className="text-ink-2">{r.statusReason}</span>
          </div>
          <div className="mt-3">
            <div className="label">Почему</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px]">
              {r.why.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
          <div className="mt-3 text-[12px]">
            Уверенность: <b>{r.confidenceText}</b> — {r.confidenceReason}
          </div>
          <div className="mt-1 text-[12px]">
            Данные: <b className={QUALITY_CLS[r.quality]}>{r.qualityText}</b> — {r.qualityReason}
          </div>
        </section>

        {t && r.norm && (
          <section className="card mt-3 p-4">
            <div className="label">Сегодня</div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-center">
              <Big label="иметь" value={pcs(t.target)} />
              <Big label="сейчас" value={pcs(t.stock)} />
              <Big label={t.need > 0 ? "добавить" : t.surplus > 0 ? "можно забрать" : "итог"} value={t.need > 0 ? pcs(t.need) : t.surplus > 0 ? pcs(t.surplus) : "хватает"} tone={t.need > 0 ? "crit" : t.surplus > 0 ? "good" : undefined} />
            </div>
            <div className="mt-2 text-[12px] text-ink-3">
              {t.reason}
              {t.eveningTarget !== null ? ` · до ${untilTime} нужно ${pcs(t.eveningTarget)}` : ""}
              {t.inbound ? ` · уже едет ${pcs(t.inbound)}` : ""}
              {t.outbound ? ` · уже отдаём ${pcs(t.outbound)}` : ""}
            </div>
          </section>
        )}

        <section className="card mt-3 p-4">
          <div className="label mb-2">Продано</div>
          <div className="grid grid-cols-5 gap-1 text-center text-[12px]">
            <Small label="7 дн." value={r.sold.d7} />
            <Small label="30 дн." value={r.sold.d30} />
            <Small label="60 дн." value={r.sold.d60} />
            <Small label="90 дн." value={r.sold.d90} />
            <Small label="180 дн." value={r.sold.d180} />
          </div>
          <Lines
            rows={[
              ["Сегодня", pcs(r.soldToday)],
              ["Дней с продажами (30 дн.)", `${r.salesDays30} из ${r.openDays30}`],
              ["Обычно продаётся", r.usual ? `${range(r.usual.low, r.usual.high)} за день${r.basis === "FACT" ? " с наличием" : ", когда покупают"}` : "—"],
              ["В дни высокого спроса", r.strongDay !== null ? pcs(r.strongDay) : "—"],
              ["30 дней к предыдущим 30", r.sales30VsPrevPct === null ? "—" : `${r.sales30VsPrevPct > 0 ? "+" : ""}${r.sales30VsPrevPct}%`],
            ]}
          />
        </section>

        <section className="card mt-3 p-4">
          <div className="label mb-2">Остаток и движение (30 дней)</div>
          <Lines
            rows={[
              ["Текущий остаток", pcs(r.stock)],
              ["Загружено", pcs(r.loaded30)],
              ["Снято (разгрузки: перенос, возврат…)", pcs(r.removed30)],
              ["Подтверждённо списано", pcs(r.writtenOff30)],
            ]}
          />
        </section>

        <section className="card mt-3 p-4">
          <div className="label mb-2">Наличие</div>
          <div className="text-[12px] font-semibold text-ink-2">ФАКТ — история остатков каждые 5 минут</div>
          {r.fact.days ? (
            <Lines
              rows={[
                ["Дней с подтверждённым наличием", `${r.fact.inStock} из ${r.fact.days}`],
                ["Дней без товара", String(r.fact.out)],
                ["Сколько раз закончился", String(r.fact.ranOut)],
              ]}
            />
          ) : (
            <p className="mt-1 text-[12px] text-ink-3">Пока нет ни одного полного дня истории остатков.</p>
          )}
          <div className="mt-3 text-[12px] font-semibold text-ink-2">ОЦЕНКА — восстановлено по продажам и загрузкам (в норму не входит)</div>
          {r.estimate ? (
            <Lines
              rows={[
                ["Дней в наличии (оценка)", `${r.estimate.inStock} из ${r.estimate.days}`],
                ["Дней без товара (оценка)", String(r.estimate.out)],
                ["Закончился (оценка)", String(r.estimate.ranOut)],
              ]}
            />
          ) : (
            <p className="mt-1 text-[12px] text-ink-3">Оценки нет: загрузки и продажи не позволяют её построить.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Big({ label, value, tone, strong }: { label: string; value: string; tone?: "crit" | "good"; strong?: boolean }) {
  return (
    <div className={clsx("rounded-lg px-1 py-2", strong ? "bg-ink text-bg" : "bg-surface-2")}>
      <div className={clsx("num text-[20px] font-bold leading-none", tone === "crit" && "text-crit-ink", tone === "good" && "text-good-ink")}>{value}</div>
      <div className={clsx("mt-1 text-[10px] uppercase tracking-wide", strong ? "opacity-70" : "text-ink-3")}>{label}</div>
    </div>
  );
}

function Small({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-surface-2 py-1.5">
      <div className="num text-[16px] font-bold">{value}</div>
      <div className="text-[10px] text-ink-3">{label}</div>
    </div>
  );
}

function Lines({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-2 space-y-1 text-[13px]">
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="flex justify-between gap-3 border-b border-line pb-1 last:border-0">
          <dt className="text-ink-2">{k}</dt>
          <dd className="num text-right font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
