"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useNetworkAnalytics, type NetworkAnalyticsView } from "@/lib/client/networkAnalytics";
import { ALL_FRIDGES, FridgePicker, FridgeView, Kpi, Lines, Small, STATUS_CLS, pcs } from "./ProductAnalytics";

/**
 * Аналитика: сначала «Все холодильники» (вся сеть: холодильники рядом и все блюда с разбивкой по точкам),
 * потом каждый холодильник отдельно (FridgeView). The network numbers are the fridges' numbers added up.
 */

const STORE_KEY = "analytics-fridge";

export function AnalyticsScreen({ mobile = false }: { mobile?: boolean }) {
  const [fridgeId, setFridgeId] = useState<string>(ALL_FRIDGES);
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
    window.scrollTo({ top: 0 });
  };
  return fridgeId === ALL_FRIDGES ? <NetworkView mobile={mobile} pick={pick} /> : <FridgeView mobile={mobile} fridgeId={fridgeId} pick={pick} />;
}

type NetRow = NetworkAnalyticsView["products"][number];
type Status = NetRow["perFridge"][number]["status"];
type SortKey = "name" | "sold7" | "sold30" | "fridges" | "loaded" | "stock" | "norm" | "need";
const SORTS: Record<SortKey, (r: NetRow) => number | string> = {
  name: (r) => r.name,
  sold7: (r) => r.sold.d7,
  sold30: (r) => r.sold.d30,
  fridges: (r) => r.fridgesSelling30,
  loaded: (r) => r.removed30 + r.writtenOff30,
  stock: (r) => r.stock,
  norm: (r) => r.norm?.rec ?? -1,
  need: (r) => r.needNow * 100 - r.canGiveNow,
};
const FILTERS = [
  { id: "all", label: "Все", test: () => true },
  { id: "selling", label: "Продаются", test: (r: NetRow) => r.sold.d30 > 0 },
  { id: "more", label: "Где-то не хватает", test: (r: NetRow) => r.statusCounts.MORE > 0 },
  { id: "much", label: "Где-то лишнее", test: (r: NetRow) => r.statusCounts.TOO_MUCH + r.statusCounts.LESS > 0 },
  { id: "need", label: "Добавить сегодня", test: (r: NetRow) => r.needNow > 0 },
  { id: "unused", label: "Нигде не продаются", test: (r: NetRow) => r.sold.d30 === 0 },
] as const;
const SHORT: Record<Status, string> = { NORMAL: "норма", MORE: "больше", TOO_MUCH: "много", LESS: "меньше", RARE: "редко", NO_DATA: "нет данных", UNUSED: "не исп." };

function NetworkView({ mobile, pick }: { mobile: boolean; pick: (id: string) => void }) {
  const { data, error, isFetching } = useNetworkAnalytics(true);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("selling");
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
  if (!data) return <p className="p-6 text-ink-3">Собираю все холодильники…</p>;
  const s = data.summary;
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, data.products.filter((r) => f.test(r)).length]));
  const detail = data.products.find((r) => r.productId === open) ?? null;
  const th = (k: SortKey, label: ReactNode, right = false) => {
    const on = sort.key === k;
    return (
      <th className={clsx("cursor-pointer select-none whitespace-nowrap py-2", right && "text-right", on && "text-ink")} onClick={() => setSort({ key: k, desc: on ? !sort.desc : k !== "name" })}>
        {label}
        {on ? (sort.desc ? " ↓" : " ↑") : ""}
      </th>
    );
  };

  return (
    <div>
      <FridgePicker fridges={data.fridges} value={ALL_FRIDGES} pick={pick} mobile={mobile} note={`${s.fridges} холодильников · блюд продаётся: ${s.dishesSelling}${isFetching ? " · обновляю…" : ""}`} />

      <section className={clsx("card grid gap-px overflow-hidden bg-line p-0", mobile ? "grid-cols-2" : "grid-cols-3 lg:grid-cols-6")}>
        <Kpi label="Продано за 30 дн." value={pcs(s.sold30)} />
        <Kpi label="Загружено за 30 дн." value={pcs(s.loaded30)} />
        <Kpi label="Снято за 30 дн." value={pcs(s.removed30)} sub="разгрузки: перенос, возврат…" />
        <Kpi label="Списано (подтверждено)" value={pcs(s.writtenOff30)} sub="операции «Списание» KiT Shop" />
        <Kpi label="Сейчас во всех холодильниках" value={pcs(s.stock)} />
        <Kpi label="Проверка данных" value={s.fridgesFailed ? `❌ ${s.fridgesFailed} из ${s.fridges}` : "✅ все"} sub={s.fridgesFailed ? "у этих точек нормы не выдаются" : "проверки пройдены"} />
      </section>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {data.categories
          .filter((c) => c.sold30 > 0)
          .map((c) => (
            <span key={c.id}>
              {c.emoji} {c.name}: <b className="text-ink">{pcs(c.sold30)}</b> за 30 дн.
            </span>
          ))}
      </div>

      {/* the fridges side by side — click opens one */}
      <h2 className="label mb-2 mt-5">Холодильники — нажмите, чтобы открыть отдельно</h2>
      {mobile ? (
        <div className="space-y-2">
          {data.fridges.map((f) => (
            <button key={f.id} onClick={() => pick(f.id)} className="card block w-full p-3 text-left">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[15px] font-semibold">{f.name}</div>
                <span className="text-[12px]">{f.checksFailed.length ? "❌" : f.checksWarn ? "⚠️" : "✅"}</span>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[12px] text-ink-2">
                <span>30 дн.: <b className="text-ink">{pcs(f.sold30)}</b></span>
                <span>есть: <b className="text-ink">{pcs(f.stock)}</b></span>
                <span>списано: <b className="text-ink">{pcs(f.writtenOff30)}</b></span>
              </div>
              {(f.needNow > 0 || f.canGiveNow > 0) && (
                <div className="mt-0.5 text-[12px]">
                  сегодня: {f.needNow > 0 && <span className="text-crit-ink">добавить {pcs(f.needNow)} </span>}
                  {f.canGiveNow > 0 && <span className="text-good-ink">забрать {pcs(f.canGiveNow)}</span>}
                </div>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[980px] text-[13px] [&_td]:px-2 [&_th]:px-2">
            <thead className="text-left text-[11px] uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                <th className="py-2">Холодильник</th>
                <th className="text-right">Продано 7д</th>
                <th className="text-right">Продано 30д</th>
                <th className="text-right">Блюд продаётся</th>
                <th className="text-right">Загр. / снято / спис.</th>
                <th className="text-right">Остаток</th>
                <th className="text-right">Не хватает / лишнее</th>
                <th className="text-right">Сегодня</th>
                <th>Проверка данных</th>
              </tr>
            </thead>
            <tbody>
              {data.fridges.map((f) => (
                <tr key={f.id} onClick={() => pick(f.id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="py-2">
                    <div className="font-semibold">{f.name}</div>
                    <div className="text-[11px] text-ink-3">{f.group ?? "без группы"}</div>
                  </td>
                  <td className="num text-right">{f.sold7}</td>
                  <td className="num text-right">{f.sold30}</td>
                  <td className="num text-right">{f.dishesSelling}</td>
                  <td className="num whitespace-nowrap text-right">
                    {f.loaded30} / {f.removed30} / <span className={f.writtenOff30 ? "text-crit-ink" : ""}>{f.writtenOff30}</span>
                  </td>
                  <td className="num text-right">{f.stock}</td>
                  <td className="num text-right">
                    {f.more} / {f.tooMuch}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {f.needNow > 0 && <span className="font-semibold text-crit-ink">+{f.needNow} </span>}
                    {f.canGiveNow > 0 && <span className="text-good-ink">−{f.canGiveNow}</span>}
                    {!f.needNow && !f.canGiveNow && <span className="text-ink-3">—</span>}
                  </td>
                  <td className="text-[12px]">{f.checksFailed.length ? `❌ ${f.checksFailed.join(", ")}` : f.checksWarn ? `⚠️ ${f.checksWarn} замечаний` : "✅"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* every dish of the network */}
      <h2 className="label mb-2 mt-6">Все блюда сети — нажмите, чтобы увидеть по холодильникам</h2>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск блюда" className={clsx("h-10 rounded-xl border border-line bg-surface px-3 text-[15px]", mobile ? "w-full" : "w-64")} />
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
              <div className="text-[15px] font-semibold leading-snug">{r.name}</div>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[12px] text-ink-2">
                <span>30 дн.: <b className="text-ink">{pcs(r.sold.d30)}</b></span>
                <span>есть: <b className="text-ink">{pcs(r.stock)}</b></span>
                <span>в день: <b className="text-ink">{r.norm ? pcs(r.norm.rec) : "—"}</b></span>
              </div>
              <div className="mt-0.5 text-[12px] text-ink-3">продаётся в {r.fridgesSelling30} из {r.fridgesTotal} холодильников</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="card mt-3 overflow-x-auto p-0">
          <table className="w-full min-w-[980px] text-[13px] [&_td]:px-2 [&_th]:px-2">
            <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                {th("name", "Блюдо")}
                {th("sold7", "Продано 7д", true)}
                {th("sold30", "Продано 30д", true)}
                {th("fridges", "Холодильников с продажами", true)}
                {th("loaded", "Загр. / снято / спис.", true)}
                {th("stock", "Остаток всего", true)}
                {th("norm", "Нужно сети в день", true)}
                {th("need", "Сегодня", true)}
                <th className="py-2">Статусы по точкам</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.productId} onClick={() => setOpen(r.productId)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="py-2">
                    <div className="font-semibold">{r.name}</div>
                    <div className="text-[11px] text-ink-3">
                      {r.category.emoji} {r.category.name}
                    </div>
                  </td>
                  <td className="num text-right">{r.sold.d7}</td>
                  <td className="num text-right">{r.sold.d30}</td>
                  <td className="num text-right">
                    {r.fridgesSelling30} <span className="text-ink-3">из {r.fridgesTotal}</span>
                  </td>
                  <td className="num whitespace-nowrap text-right">
                    {r.loaded30} / {r.removed30} / <span className={r.writtenOff30 ? "text-crit-ink" : ""}>{r.writtenOff30}</span>
                  </td>
                  <td className="num text-right">{r.stock}</td>
                  <td className="num whitespace-nowrap text-right font-bold">
                    {r.norm ? r.norm.rec : "—"}
                    {r.norm && r.fridgesWithNorm < r.fridgesTotal ? <span className="font-normal text-ink-3"> ({r.fridgesWithNorm} из {r.fridgesTotal} точ.)</span> : ""}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {r.needNow > 0 && <span className="font-semibold text-crit-ink">+{r.needNow} </span>}
                    {r.canGiveNow > 0 && <span className="text-good-ink">−{r.canGiveNow}</span>}
                    {!r.needNow && !r.canGiveNow && <span className="text-ink-3">—</span>}
                  </td>
                  <td className="text-[11px]">
                    {(["MORE", "TOO_MUCH", "LESS", "RARE", "NORMAL", "NO_DATA"] as const)
                      .filter((k) => r.statusCounts[k] > 0)
                      .map((k) => (
                        <span key={k} className={clsx("mr-1 whitespace-nowrap rounded px-1 py-0.5 font-bold", STATUS_CLS[k])}>
                          {SHORT[k]} {r.statusCounts[k]}
                        </span>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="p-6 text-center text-ink-3">Ничего не найдено</p>}
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-3">
        «Нужно сети в день» — сумма норм холодильников, где норма есть. «Сегодня»: + добавить, − можно забрать. Все количества — целые штуки.
      </p>

      {detail && <NetProductDetail r={detail} pick={pick} onClose={() => setOpen(null)} mobile={mobile} />}
    </div>
  );
}

function NetProductDetail({ r, pick, onClose, mobile }: { r: NetRow; pick: (id: string) => void; onClose: () => void; mobile: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className={clsx("h-full overflow-y-auto bg-bg p-4 shadow-xl", mobile ? "w-full" : "w-[620px]")} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={r.name}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[20px] font-bold uppercase leading-tight">{r.name}</h2>
            <div className="text-[13px] text-ink-3">
              вся сеть · {r.category.emoji} {r.category.name}
            </div>
          </div>
          <button onClick={onClose} className="h-9 w-9 shrink-0 rounded-lg bg-surface-2 text-[18px]" aria-label="Закрыть">
            ×
          </button>
        </div>
        <section className="card mt-3 p-4">
          <div className="label mb-2">Вся сеть</div>
          <div className="grid grid-cols-5 gap-1 text-center text-[12px]">
            <Small label="7 дн." value={r.sold.d7} />
            <Small label="30 дн." value={r.sold.d30} />
            <Small label="60 дн." value={r.sold.d60} />
            <Small label="90 дн." value={r.sold.d90} />
            <Small label="180 дн." value={r.sold.d180} />
          </div>
          <Lines
            rows={[
              ["Продаётся в холодильниках (30 дн.)", `${r.fridgesSelling30} из ${r.fridgesTotal}`],
              ["Сейчас во всех холодильниках", pcs(r.stock)],
              ["Загружено / снято / списано (30 дн.)", `${r.loaded30} / ${r.removed30} / ${r.writtenOff30} шт.`],
              ["Нужно сети в день (сумма норм)", r.norm ? `${pcs(r.norm.rec)} (от ${r.norm.min} до ${r.norm.max})` : "нормы нет"],
              ["Сегодня добавить / можно забрать", `${pcs(r.needNow)} / ${pcs(r.canGiveNow)}`],
            ]}
          />
        </section>
        <section className="card mt-3 p-0">
          <div className="label px-4 pt-3">По холодильникам — нажмите, чтобы открыть холодильник</div>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full min-w-[520px] text-[12px] [&_td]:px-2 [&_th]:px-2">
              <thead className="text-left text-ink-3">
                <tr className="border-b border-line">
                  <th className="py-1">Холодильник</th>
                  <th className="text-right">Продано 30д</th>
                  <th className="text-right">Дней с продажами</th>
                  <th className="text-right">Есть</th>
                  <th className="text-right">Норма</th>
                  <th className="text-right">Сегодня</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {r.perFridge.map((x) => (
                  <tr key={x.fridgeId} onClick={() => pick(x.fridgeId)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="py-1.5 font-semibold">{x.fridge}</td>
                    <td className="num text-right">{x.sold30}</td>
                    <td className="num text-right">
                      {x.salesDays30} из {x.openDays30}
                    </td>
                    <td className="num text-right">{x.stock}</td>
                    <td className="num whitespace-nowrap text-right font-bold">{x.norm ? (x.norm.rec === 0 ? "не ежедн." : x.norm.rec) : "—"}</td>
                    <td className="whitespace-nowrap text-right">
                      {x.need > 0 ? <span className="text-crit-ink">+{x.need}</span> : x.surplus > 0 ? <span className="text-good-ink">−{x.surplus}</span> : <span className="text-ink-3">—</span>}
                    </td>
                    <td>
                      <span className={clsx("whitespace-nowrap rounded px-1 py-0.5 text-[11px] font-bold", STATUS_CLS[x.status])} title={x.qualityText}>
                        {x.statusText}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
