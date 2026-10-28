import type { DataCheck, DayStatus, Fridge } from "../domain/types";
import { dayNumber, minuteOfDay } from "../time";
import type { KsDataset } from "./dataset";
import { fillDirection } from "./fillDirection";
import type { ShopHistory } from "./history";

/**
 * Data checks of ONE fridge, run before any norm is trusted. A FAIL makes every norm of the fridge "ДАННЫЕ НЕПОЛНЫЕ"
 * (no norm, no transfers); a WARN lowers the data quality to "incomplete". Only real KiT Shop data is looked at.
 *  • nightly (from the 180-day history in PostgreSQL, with the analytics job): sales, ids, whole quantities, duplicates,
 *    time of day, completeness, continuity, load / unload / write-off types;
 *  • live (from what the 5-minute sync keeps in memory): stock freshness, receipts from the future, the KiT Shop clock,
 *    new receipts arriving.
 */

const DAY = 86_400_000;
const ddmm = (day: number) => {
  const d = new Date(day * DAY);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * Continuity of the last 30 days: every day has receipts (DATA), or the fridge usually does not sell on that weekday
 * (CLOSED: at most a third of the same weekdays in the 8 weeks before had receipts), otherwise a GAP — receipts missing
 * while the fridge works, far fewer than on the same weekdays (< 20 %), receipts without lines, or a day before the
 * complete history.
 */
export function continuityFrom(h: ShopHistory, now: number, historyFromDay: number): DayStatus[] {
  const today = dayNumber(now);
  const count = new Map<number, number>();
  const undetailed = new Map<number, number>();
  const settle = now - 30 * 60_000;
  for (const r of h.receipts) {
    const d = dayNumber(r.at);
    if (d < today - 90 || d >= today) continue;
    count.set(d, (count.get(d) ?? 0) + 1);
    if (!r.detailed && r.at < settle) undetailed.set(d, (undetailed.get(d) ?? 0) + 1);
  }
  const out: DayStatus[] = [];
  for (let d = today - 30; d < today; d++) {
    const c = count.get(d) ?? 0;
    const same = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => d - 7 * w).filter((x) => x >= historyFromDay).map((x) => count.get(x) ?? 0);
    const worked = same.filter((x) => x > 0);
    const usual = worked.length ? [...worked].sort((a, b) => a - b)[Math.floor(worked.length / 2)] : 0;
    let status: DayStatus["status"] = "DATA";
    let note = `${c} чеков`;
    if (d < historyFromDay) {
      status = "GAP";
      note = "история ещё не загружена";
    } else if ((undetailed.get(d) ?? 0) > 0) {
      status = "GAP";
      note = `${undetailed.get(d)} чеков без состава`;
    } else if (c === 0) {
      if (same.length && worked.length > same.length / 3) {
        status = "GAP";
        note = `нет чеков, а в этот день недели обычно ~${usual}`;
      } else {
        status = "CLOSED";
        note = "в этот день недели обычно не работает";
      }
    } else if (usual >= 10 && c < 0.2 * usual) {
      status = "GAP";
      note = `${c} чеков, а обычно ~${usual}`;
    }
    out.push({ day: d, receipts: c, status, note });
  }
  return out;
}

export function nightlyChecks(
  h: ShopHistory,
  shopId: string,
  ctx: { now: number; ds: Pick<KsDataset, "shops" | "products">; historyFromDay: number; fillupsFromDay: number | null },
  continuity: DayStatus[],
): DataCheck[] {
  const { now, ds } = ctx;
  const today = dayNumber(now);
  const out: DataCheck[] = [];
  const add = (id: string, label: string, level: DataCheck["level"], detail: string) => out.push({ id, label, level, detail });

  let sales30 = 0;
  let nonInteger = 0;
  let unknownProducts = 0;
  let night = 0;
  let units30 = 0;
  const byHour = new Array<number>(24).fill(0);
  const signatures = new Map<string, number>();
  let duplicates = 0;
  for (const r of h.receipts) {
    if (r.at < now - 30 * DAY || r.at > now) continue;
    sales30++;
    // the same moment, the same sum, the same lines under another SaleId = a duplicated receipt
    if (r.detailed && r.lines) {
      const sig = `${r.at}|${r.total}|${r.lines}`;
      const n = signatures.get(sig) ?? 0;
      if (n > 0) duplicates++;
      signatures.set(sig, n + 1);
    }
  }
  for (const l of h.sales) {
    if (l.at < now - 30 * DAY || l.at > now) continue;
    if (!Number.isInteger(l.qty)) nonInteger++;
    if (!ds.products.has(l.productId)) unknownProducts++;
    units30 += l.qty;
    const hr = Math.floor(minuteOfDay(l.at) / 60);
    byHour[hr] += l.qty;
    if (hr < 5) night += l.qty;
  }

  add("sales", "Продажи есть", sales30 > 0 ? "OK" : "WARN", sales30 > 0 ? `${sales30} чеков за 30 дней` : "за 30 дней нет ни одного чека");
  add("ids-shop", "ShopId верный", ds.shops.has(shopId) ? "OK" : "FAIL", ds.shops.has(shopId) ? `${shopId} = «${ds.shops.get(shopId)!.name}» в KiT Shop` : `точки ${shopId} нет в KiT Shop`);
  add("ids-product", "ProductId верные", unknownProducts ? "WARN" : "OK", unknownProducts ? `${unknownProducts} позиций с товаром, которого нет в каталоге KiT Shop` : "все товары чеков есть в каталоге");
  add("integer", "Количества целые", nonInteger ? "WARN" : "OK", nonInteger ? `${nonInteger} позиций с дробным количеством` : "все количества в чеках целые");
  add("duplicates", "Нет дублей чеков", duplicates ? "WARN" : "OK", duplicates ? `${duplicates} чеков совпадают с другим чеком по времени, сумме и составу` : "SaleId не повторяются, одинаковых чеков нет");

  let peak = 0;
  for (let hr = 1; hr < 24; hr++) if (byHour[hr] > byHour[peak]) peak = hr;
  const nightShare = units30 ? night / units30 : 0;
  add(
    "timezone",
    "Часовой пояс",
    units30 >= 30 && (nightShare > 0.15 || peak < 7 || peak > 17) ? "WARN" : "OK",
    `пик продаж в ${String(peak).padStart(2, "0")}:00, ночью (0–5 ч) ${Math.round(nightShare * 100)}% продаж`,
  );

  const gaps = continuity.filter((d) => d.status === "GAP");
  add(
    "continuity",
    "История продаж без дыр (30 дней)",
    gaps.length ? "FAIL" : "OK",
    gaps.length ? `DATA GAP: ${gaps.slice(-6).map((g) => `${ddmm(g.day)} — ${g.note}`).join("; ")}${gaps.length > 6 ? ` и ещё ${gaps.length - 6}` : ""}` : "каждый рабочий день за 30 дней есть чеки с составом",
  );

  let unknownType = 0;
  const byKind = { load: 0, unload: 0, writeoff: 0 };
  for (const f of h.fills) {
    if (f.at < now - 30 * DAY) continue;
    if (f.type !== 1 && f.type !== 2 && f.type !== 3) unknownType++;
    byKind[fillDirection(f.type, f.qty).kind] += Math.abs(f.qty);
  }
  add(
    "fill-types",
    "Типы 1/2/3 разобраны",
    unknownType ? "WARN" : "OK",
    `за 30 дней: загрузка (1) ${Math.round(byKind.load)} шт., разгрузка (2) ${Math.round(byKind.unload)} шт., списание (3) ${Math.round(byKind.writeoff)} шт.${unknownType ? `; ${unknownType} строк с неизвестным типом` : ""}`,
  );

  const salesDays = today - ctx.historyFromDay;
  add("sales-history", "История продаж полная", salesDays >= 30 ? "OK" : "WARN", `чеки с позициями полные с ${ddmm(ctx.historyFromDay)} (${Math.max(0, salesDays)} дн.)`);
  const fillDays = ctx.fillupsFromDay === null ? null : today - ctx.fillupsFromDay;
  add(
    "fillups",
    "Загрузки и снятия полные",
    fillDays !== null && fillDays >= 30 ? "OK" : "WARN",
    fillDays === null ? "загрузки/снятия ещё не прочитаны" : `загрузки/снятия полные с ${ddmm(ctx.fillupsFromDay!)} (${Math.max(0, fillDays)} дн.)`,
  );
  add("unload-writeoff", "Снятия не считаются списаниями", "OK", "списание = только операция KiT Shop «Списание» (тип 3); «Разгрузка» (тип 2) показывается как «снято»");
  return out;
}

/** Live part, from the memory of the 5-minute sync. `receiptsByDay` / `startDay` come from the nightly job. */
export function liveChecks(
  ds: Pick<KsDataset, "sales" | "stockAt" | "stockCoverage" | "state">,
  fr: Fridge,
  now: number,
  nightly?: { receiptsByDay: Int32Array; startDay: number } | null,
): DataCheck[] {
  const shopId = fr.externalId;
  const today = dayNumber(now);
  const out: DataCheck[] = [];
  const add = (id: string, label: string, level: DataCheck["level"], detail: string) => out.push({ id, label, level, detail });

  const stockAt = ds.stockAt.get(shopId) ?? null;
  const age = stockAt === null ? null : Math.round((now - stockAt) / 60_000);
  add(
    "stock",
    "Остаток совпадает с KiT Shop",
    age === null ? "FAIL" : age <= 15 ? "OK" : age <= 60 ? "WARN" : "FAIL",
    age === null ? "остаток ещё не читался" : `остаток прочитан из KiT Shop (GetShopStocks) ${age} мин назад`,
  );

  let future = 0;
  let newest = 0;
  let last24 = 0;
  for (const s of ds.sales.values()) {
    if (s.shopId !== shopId) continue;
    if (s.soldAt > now + 10 * 60_000) future++;
    else if (s.soldAt <= now) {
      newest = Math.max(newest, s.soldAt);
      if (s.soldAt > now - DAY) last24++;
    }
  }
  add(
    "future",
    "Нет чеков из будущего",
    future ? "FAIL" : "OK",
    future ? `${future} чеков с временем позже, чем сейчас — время KiT Shop сдвинуто` : newest ? `последний чек ${ddmm(dayNumber(newest))} в ${String(Math.floor(minuteOfDay(newest) / 60)).padStart(2, "0")}:${String(minuteOfDay(newest) % 60).padStart(2, "0")}` : "чеков в последние дни нет",
  );

  const probe = ds.state.clockProbe ?? null;
  if (probe && probe.receiptsLastHour >= 15) {
    const hours = Math.round(probe.gapMinutes / 60);
    const ok = Math.abs(probe.gapMinutes) < 45;
    add(
      "clock",
      "Время KiT Shop совпадает с нашим",
      ok ? "OK" : "FAIL",
      ok
        ? `самый свежий чек в KiT Shop — ${Math.max(0, probe.gapMinutes)} мин назад (проверено при ${probe.receiptsLastHour} чеках за час)`
        : `самый свежий чек в KiT Shop «${probe.gapMinutes > 0 ? `${hours} ч назад` : `через ${-hours} ч`}» при ${probe.receiptsLastHour} чеках за час — KiT Shop отдаёт время в другом часовом поясе; нужно KITSHOP_TIME_OFFSET_MINUTES=${probe.offsetMinutes + hours * 60} (сейчас ${probe.offsetMinutes})`,
    );
  } else add("clock", "Время KiT Shop совпадает с нашим", "WARN", probe ? "проверка ждёт часа с продажами (нужно ≥ 15 чеков за час)" : "проверка ещё не выполнялась (раз в час)");

  // new receipts really arrive: the last 24 h against the same 24 h one, two and three weeks ago (from the nightly job)
  let usual = 0;
  if (nightly) {
    const vals = [7, 14, 21].map((w) => {
      const d = today - w - nightly.startDay;
      return d >= 0 && d < nightly.receiptsByDay.length ? nightly.receiptsByDay[d] : 0;
    });
    usual = vals.reduce((a, b) => a + b, 0) / 3;
  }
  add(
    "fresh",
    "Новые чеки приходят",
    usual >= 10 && last24 < 0.2 * usual ? "FAIL" : "OK",
    `за последние 24 ч ${last24} чеков; в этот день недели обычно ~${Math.round(usual)}`,
  );

  const cov = ds.stockCoverage.get(shopId) ?? [];
  const factFrom = cov.length ? dayNumber(cov[0][0]) : null;
  add("stock-history", "История остатков (снимки каждые 5 мин)", "OK", factFrom === null ? "снимки остатков начнут сохраняться со следующей синхронизации" : `сохраняется с ${ddmm(factFrom)}`);
  return out;
}
