"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useProductAnalytics, type ProductAnalyticsView } from "@/lib/client/api";

type Row = ProductAnalyticsView["products"][number];

const STATUS_CLS: Record<Row["status"], string> = {
  NORMAL: "bg-good/15 text-good-ink",
  MORE: "bg-crit/15 text-crit-ink",
  TOO_MUCH: "bg-warn/20 text-warn",
  LESS: "bg-warn/20 text-warn",
  NO_DATA: "bg-surface-3 text-ink-3",
  UNUSED: "bg-surface-3 text-ink-3",
};

const FILTERS = [
  { id: "all", label: "Все", test: () => true },
  { id: "high", label: "Высокий спрос", test: (r: Row) => r.demand === "HIGH" },
  { id: "low", label: "Низкий спрос", test: (r: Row) => r.demand === "LOW" },
  { id: "out", label: "Часто не хватает", test: (r: Row) => r.frequentlyOut },
  { id: "much", label: "Много остатков/снятий", test: (r: Row) => r.status === "TOO_MUCH" || r.status === "LESS" },
  { id: "need", label: "Добавить сегодня", test: (r: Row) => (r.today?.need ?? 0) > 0 },
  { id: "new", label: "Новые", test: (r: Row) => r.isNew },
  { id: "nodata", label: "Нет данных", test: (r: Row) => r.status === "NO_DATA" },
  { id: "unused", label: "Не используются", test: (r: Row) => r.status === "UNUSED" },
] as const;

type SortKey = "name" | "sold30" | "avg" | "removed" | "stock" | "out" | "norm" | "status" | "need";
const SORTS: Record<SortKey, (r: Row) => number | string> = {
  name: (r) => r.name,
  sold30: (r) => r.sold.d30,
  avg: (r) => r.rate,
  removed: (r) => r.removed30,
  stock: (r) => r.stock,
  out: (r) => r.daysOut30 + r.timesRanOut30 / 100,
  norm: (r) => r.norm.rec,
  status: (r) => ["MORE", "TOO_MUCH", "LESS", "NORMAL", "NO_DATA", "UNUSED"].indexOf(r.status),
  need: (r) => (r.today?.need ?? 0) - (r.today?.surplus ?? 0) / 100,
};

const fmt = (x: number | null | undefined, digits = 1) => (x === null || x === undefined ? "—" : (Math.round(x * 10 ** digits) / 10 ** digits).toString().replace(".", ","));
const signed = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : ""}${x}%`);
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

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
  if (!data) return <p className="p-6 text-ink-3">Считаю продажи, снятия и наличие по каждому блюду…</p>;

  const s = data.fridge.summary;
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, data.products.filter((r) => f.test(r)).length]));
  const detail = data.products.find((r) => r.productId === open) ?? null;
  const groups = [...new Set(data.fridges.map((f) => f.group ?? "без группы"))];

  return (
    <div>
      {/* 1. fridge */}
      <div className={clsx("mb-3 flex flex-wrap items-center gap-3", mobile && "flex-col items-stretch")}>
        <select
          value={data.fridge.id}
          onChange={(e) => pick(e.target.value)}
          className="h-11 rounded-xl border border-line bg-surface px-3 text-[16px] font-bold"
          aria-label="Холодильник"
        >
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
          {data.fridge.group ? `группа ${data.fridge.group} · ` : ""}блюд с данными: {data.data.productsHere}
          {isFetching ? " · обновляю…" : ""}
        </span>
      </div>

      {/* 2. summary */}
      <section className={clsx("card grid gap-px overflow-hidden bg-line p-0", mobile ? "grid-cols-2" : "grid-cols-3 lg:grid-cols-6")}>
        <Kpi label="Продано за 30 дн." value={String(s.sold30)} />
        <Kpi label="Снято за 30 дн." value={String(s.removed30)} sub={s.writtenOff30 ? `из них списание ${s.writtenOff30}` : "подтверждённых списаний нет"} />
        <Kpi label="Средний остаток" value={s.avgStock === null ? "—" : String(s.avgStock)} sub={s.avgStock === null ? "история остатков копится" : "к концу дня"} />
        <Kpi label="Сейчас в холодильнике" value={String(s.stockNow)} />
        <Kpi label="Товаров с дефицитом" value={String(s.deficit)} sub={`добавить сегодня: ${s.needNow}`} tone={s.deficit ? "crit" : undefined} />
        <Kpi label="Товаров с избытком" value={String(s.surplus)} sub={`можно отдать сейчас: ${s.canGiveNow}`} tone={s.surplus ? "warn" : undefined} />
      </section>

      {/* categories: only a short summary */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {data.fridge.categories
          .filter((c) => c.sold30 > 0)
          .map((c) => (
            <span key={c.id}>
              {c.emoji} {c.name}: <b className={clsx(c.level === "высокий спрос" ? "text-good-ink" : c.level === "низкий спрос" ? "text-warn" : "text-ink")}>{c.level}</b>
              <span className="text-ink-3"> ({c.sold30} за 30 дн.)</span>
            </span>
          ))}
      </div>

      {data.data.notes.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-xl bg-warn/10 px-3 py-2 text-[12px] text-ink-2">
          {data.data.notes.map((n) => (
            <li key={n}>⚠ {n}</li>
          ))}
        </ul>
      )}

      {/* 3. all products */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск блюда"
          className={clsx("h-10 rounded-xl border border-line bg-surface px-3 text-[15px]", mobile ? "w-full" : "w-64")}
        />
        {mobile && (
          <select
            value={sort.key}
            onChange={(e) => setSort({ key: e.target.value as SortKey, desc: e.target.value !== "name" })}
            className="h-10 flex-1 rounded-xl border border-line bg-surface px-2 text-[14px]"
            aria-label="Сортировка"
          >
            <option value="sold30">по продажам</option>
            <option value="need">что добавить сегодня</option>
            <option value="out">часто нет в наличии</option>
            <option value="removed">по снятиям</option>
            <option value="stock">по остатку</option>
            <option value="name">по названию</option>
          </select>
        )}
      </div>
      <div className={clsx("mt-2 flex gap-1.5", mobile ? "-mx-1 overflow-x-auto px-1 pb-1" : "flex-wrap")}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={clsx("h-9 shrink-0 rounded-lg px-3 text-[13px] font-semibold", filter === f.id ? "bg-ink text-bg" : "bg-surface-2 text-ink-2")}
          >
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
              <div className="mt-1 grid grid-cols-4 gap-1 text-[12px] text-ink-2">
                <span>30 дн.: <b className="text-ink">{r.sold.d30}</b></span>
                <span>в день: <b className="text-ink">{fmt(r.rate)}</b></span>
                <span>есть: <b className="text-ink">{r.stock}</b></span>
                <span>норма: <b className="text-ink">{r.norm.rec}</b></span>
              </div>
              <TodayLine r={r} />
            </button>
          ))}
        </div>
      ) : (
        <div className="card mt-3 overflow-x-auto p-0">
          <table className="w-full min-w-[980px] text-[13px] [&_td]:px-2 [&_th]:px-2">
            <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                <Th k="name" sort={sort} setSort={setSort}>Блюдо</Th>
                <Th k="sold30" sort={sort} setSort={setSort} right>Продано 30д</Th>
                <Th k="avg" sort={sort} setSort={setSort} right title="продажи за день, когда товар был в наличии">В день*</Th>
                <Th k="removed" sort={sort} setSort={setSort} right>Снято / списано</Th>
                <Th k="stock" sort={sort} setSort={setSort} right>Остаток</Th>
                <Th k="out" sort={sort} setSort={setSort} right title="открытых дней за 30, когда товара не было бóльшую часть продаж">Дней без наличия</Th>
                <Th k="norm" sort={sort} setSort={setSort} right>Норма на день</Th>
                <Th k="need" sort={sort} setSort={setSort} right>Сегодня</Th>
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
                      {r.isNew ? " · НОВЫЙ" : ""}
                    </div>
                  </td>
                  <td className="num text-right">{r.sold.d30}</td>
                  <td className="num text-right">{fmt(r.rate)}</td>
                  <td className="num text-right">
                    {r.removed30 ? fmt(r.removed30, 0) : "0"}
                    {r.writtenOff30 ? <span className="text-crit-ink"> / {fmt(r.writtenOff30, 0)}</span> : ""}
                  </td>
                  <td className="num text-right">{r.stock}</td>
                  <td className="num text-right">{r.knownDays30 ? r.daysOut30 : <span className="text-ink-3">?</span>}</td>
                  <td className="num text-right font-bold">{r.norm.rec ? (r.norm.min === r.norm.max ? r.norm.rec : `${r.norm.rec} (${r.norm.min}–${r.norm.max})`) : "—"}</td>
                  <td className="whitespace-nowrap text-right">
                    <TodayCell r={r} />
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
      <p className="mt-2 text-[11px] text-ink-3">
        * В день — продажи за день, когда товар реально был в холодильнике. Нажмите на блюдо — подробный разбор.
      </p>

      <details className="mt-4 text-[12px] text-ink-2">
        <summary className="cursor-pointer font-semibold">Как считается норма и откуда данные</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {data.data.formula.map((x) => (
            <li key={x}>{x}</li>
          ))}
          <li>Продажи по блюдам полные с {data.data.salesFrom ?? "—"}; загрузки/снятия — с {data.data.fillupsFrom ?? "ещё не прочитаны"}; наличие по дням — с {data.data.stockKnownFrom ?? "пока неизвестно"}; история остатков (каждые 5 минут) — с {data.data.stockHistoryFrom ?? "только начинает копиться"}.</li>
          <li>Списание = {data.data.writeOffRule ?? "не определяется"}. Отдельной операции «списание» в KiT Shop API нет — всё остальное показано как «снято» (это и списания без комментария, и перемещения в другие холодильники).</li>
          <li>Всего блюд в анализе по всем холодильникам: {data.data.productsAll}.</li>
        </ul>
      </details>

      {detail && <ProductDetail r={detail} fridge={data.fridge.name} untilTime={data.untilTime} onClose={() => setOpen(null)} mobile={mobile} />}
    </div>
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
  return <span className={clsx("whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold", STATUS_CLS[r.status])}>{r.statusText}</span>;
}

function TodayCell({ r }: { r: Row }) {
  const t = r.today;
  if (!t) return <span className="text-ink-3">—</span>;
  if (t.need > 0) return <span className="font-bold text-crit-ink">+{t.need}</span>;
  if (t.surplus > 0) return <span className="font-semibold text-good-ink">избыток {t.surplus}</span>;
  return <span className="text-ink-3">хватает</span>;
}

function TodayLine({ r }: { r: Row }) {
  const t = r.today;
  if (!t || (t.need === 0 && t.surplus === 0)) return null;
  return (
    <div className={clsx("mt-1 text-[13px] font-semibold", t.need > 0 ? "text-crit-ink" : "text-good-ink")}>
      Сегодня иметь {t.target}, сейчас {t.stock} → {t.need > 0 ? `добавить +${t.need}` : `избыток ${t.surplus}`}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "crit" | "warn" }) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="label leading-tight">{label}</div>
      <div className={clsx("num mt-1 text-[24px] font-semibold leading-none", tone === "crit" && "text-crit-ink", tone === "warn" && "text-warn")}>{value}</div>
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
      <div
        className={clsx("h-full overflow-y-auto bg-bg p-4 shadow-xl", mobile ? "w-full" : "w-[520px]")}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={r.name}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[20px] font-bold leading-tight">{r.name}</h2>
            <div className="text-[13px] text-ink-3">
              {fridge} · {r.category.emoji} {r.category.name}
              {r.isNew ? " · НОВЫЙ" : ""}
            </div>
          </div>
          <button onClick={onClose} className="h-9 w-9 shrink-0 rounded-lg bg-surface-2 text-[18px]" aria-label="Закрыть">
            ×
          </button>
        </div>

        {/* the answer first */}
        <section className="card mt-3 p-4">
          <div className="label">Норма на день</div>
          <div className="mt-1 text-[28px] font-bold leading-none">{r.norm.rec ? `${r.norm.rec} шт./день` : "нормы нет"}</div>
          {r.norm.rec > 0 && <div className="mt-1 text-[13px] text-ink-2">ставить {r.norm.min === r.norm.max ? r.norm.rec : `${r.norm.min}–${r.norm.max}`} шт. в день</div>}
          <div className="mt-2 flex items-center gap-2">
            <StatusChip r={r} />
            <span className="text-[12px] text-ink-2">{r.statusReason}</span>
          </div>
          <div className="mt-2 text-[12px] text-ink-3">
            Уверенность: {r.confidence === "HIGH" ? "высокая" : r.confidence === "MEDIUM" ? "средняя" : "низкая"} · история {r.historyDays} дн.
            {!r.availabilityKnown ? " · наличие по дням пока неизвестно" : ""}
          </div>
        </section>

        {t && (
          <section className="card mt-3 p-4">
            <div className="label">Сегодня</div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-center">
              <Big label="рекомендуется иметь" value={String(t.target)} />
              <Big label="сейчас" value={String(t.stock)} />
              <Big label={t.need > 0 ? "добавить" : t.surplus > 0 ? "избыток" : "итог"} value={t.need > 0 ? `+${t.need}` : t.surplus > 0 ? String(t.surplus) : "хватает"} tone={t.need > 0 ? "crit" : t.surplus > 0 ? "good" : undefined} />
            </div>
            <div className="mt-2 text-[12px] text-ink-3">
              {t.reason}
              {t.eveningTarget !== null ? ` · до ${untilTime} нужно ${t.eveningTarget}` : ""}
              {t.inbound ? ` · уже едет ${t.inbound}` : ""}
              {t.outbound ? ` · уже отдаём ${t.outbound}` : ""}
            </div>
          </section>
        )}

        <section className="card mt-3 p-4">
          <div className="label mb-2">Продажи</div>
          <div className="grid grid-cols-5 gap-1 text-center text-[12px]">
            <Small label="7 дн." value={r.sold.d7} />
            <Small label="30 дн." value={r.sold.d30} />
            <Small label="60 дн." value={r.sold.d60} />
            <Small label="90 дн." value={r.sold.d90} />
            <Small label="180 дн." value={r.sold.d180} />
          </div>
          <Lines
            rows={[
              ["Продано сегодня", String(r.soldToday)],
              ["Среднее за 30 дней (на открытый день)", `${fmt(r.avg30)} шт./день`],
              ["Среднее за 7 дней", `${fmt(r.avg7)} шт./день`],
              ["В день, когда товар был в наличии (30 дн.)", r.rate30 === null ? "мало данных" : `${fmt(r.rate30)} шт./день`],
              ["Тренд (7 дн. к 30 дн.)", signed(r.trendPct)],
              ["Продажи 30 дн. к предыдущим 30", signed(r.sales30VsPrevPct)],
              ["К этому блюду в других холодильниках", signed(r.vsNetworkPct)],
            ]}
          />
        </section>

        <section className="card mt-3 p-4">
          <div className="label mb-2">Наличие (30 дней)</div>
          <Lines
            rows={[
              ["Открытых дней у холодильника", String(r.openDays30)],
              ["Дней с товаром (с учётом части дня)", r.knownDays30 ? fmt(r.availDays30) : "неизвестно"],
              ["Дней без наличия (бóльшую часть продаж)", r.knownDays30 ? String(r.daysOut30) : "неизвестно"],
              ["Время продаж без товара", r.stockoutRate30 === null ? "неизвестно" : pct(r.stockoutRate30)],
              ["Сколько раз закончился (продали последний)", String(r.timesRanOut30)],
              ["Средний остаток к концу дня", r.avgEod30 === null ? "неизвестно" : fmt(r.avgEod30)],
              ["Наличие известно за дней", `${r.knownDays30} из ${r.openDays30}`],
            ]}
          />
        </section>

        <section className="card mt-3 p-4">
          <div className="label mb-2">Загрузки и снятия (30 дней)</div>
          <Lines
            rows={[
              ["Загружено", fmt(r.loaded30, 0)],
              ["Снято (списания и перемещения)", fmt(r.removed30, 0)],
              ["Из них подтверждённое списание", fmt(r.writtenOff30, 0)],
              ["Доля снятий от загруженного", pct(r.removedShare)],
              ["Доля списаний от загруженного", pct(r.writeOffShare)],
            ]}
          />
        </section>

        <section className="card mt-3 p-4">
          <div className="label mb-2">Как получилась норма</div>
          <Lines
            rows={[
              ["7 дней (вес 0,35)", r.rate7 === null ? "мало данных" : `${fmt(r.rate7)}/день`],
              ["14 дней (вес 0,25)", r.rate14 === null ? "мало данных" : `${fmt(r.rate14)}/день`],
              ["30 дней (вес 0,25)", r.rate30 === null ? "мало данных" : `${fmt(r.rate30)}/день`],
              ["180 дней (вес 0,15)", r.rate180 === null ? "мало данных" : `${fmt(r.rate180)}/день`],
              ["Скорость продаж", `${fmt(r.rate, 2)}/день`],
              ...r.adjustments.map((a) => ["Поправка", a] as [string, string]),
              ["Итог", `${fmt(r.rateAdj, 2)}/день → норма ${r.norm.rec}`],
            ]}
          />
        </section>
      </div>
    </div>
  );
}

function Big({ label, value, tone }: { label: string; value: string; tone?: "crit" | "good" }) {
  return (
    <div className="rounded-lg bg-surface-2 px-1 py-2">
      <div className={clsx("num text-[22px] font-bold leading-none", tone === "crit" && "text-crit-ink", tone === "good" && "text-good-ink")}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
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
