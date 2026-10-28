import type { DataCheck, Fridge } from "../domain/types";
import { dayNumber, minuteOfDay } from "../time";
import type { KsDataset } from "./dataset";

/**
 * Data checks of ONE fridge, run before any norm is trusted. A FAIL makes every norm of the fridge "data: bad" and never
 * confident; a WARN lowers the data quality to "incomplete". Only real KiT Shop data is looked at.
 */

const DAY = 86_400_000;
const ddmm = (day: number) => {
  const d = new Date(day * DAY);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export function fridgeChecks(
  ds: KsDataset,
  fr: Fridge,
  now: number,
  info: { historyFromDay: number; fillupsFromDay: number | null; balanced: boolean },
): DataCheck[] {
  const shopId = fr.externalId;
  const today = dayNumber(now);
  const out: DataCheck[] = [];
  const add = (id: string, label: string, level: DataCheck["level"], detail: string) => out.push({ id, label, level, detail });

  // receipts of this fridge
  let sales30 = 0;
  let future = 0;
  let nonInteger = 0;
  let unknownProducts = 0;
  let newest = 0;
  let night = 0;
  let units30 = 0;
  const byHour = new Array<number>(24).fill(0);
  const signatures = new Map<string, number>();
  let duplicates = 0;
  for (const s of ds.sales.values()) {
    if (s.shopId !== shopId) continue;
    if (s.soldAt > now + 10 * 60_000) future++;
    if (s.soldAt <= now) newest = Math.max(newest, s.soldAt);
    if (s.soldAt < now - 30 * DAY || s.soldAt > now) continue;
    sales30++;
    const lines = ds.positions.get(s.saleId) ?? [];
    // the same moment, the same sum, the same lines under another SaleId = a duplicated receipt
    if (s.detailed && lines.length) {
      const sig = `${s.soldAt}|${s.total}|${lines.map((l) => `${l.productId}x${l.qty}`).sort().join(",")}`;
      const n = signatures.get(sig) ?? 0;
      if (n > 0) duplicates++;
      signatures.set(sig, n + 1);
    }
    for (const l of lines) {
      if (!Number.isInteger(l.qty)) nonInteger++;
      if (!ds.products.has(l.productId)) unknownProducts++;
      units30 += l.qty;
      const h = Math.floor(minuteOfDay(s.soldAt) / 60);
      byHour[h] += l.qty;
      if (h < 5) night += l.qty;
    }
  }

  add("sales", "Продажи есть", sales30 > 0 ? "OK" : "WARN", sales30 > 0 ? `${sales30} чеков за 30 дней` : "за 30 дней нет ни одного чека");
  add("ids-shop", "ShopId верный", ds.shops.has(shopId) ? "OK" : "FAIL", ds.shops.has(shopId) ? `${shopId} = «${ds.shops.get(shopId)!.name}» в KiT Shop` : `точки ${shopId} нет в KiT Shop`);
  add("ids-product", "ProductId верные", unknownProducts ? "WARN" : "OK", unknownProducts ? `${unknownProducts} позиций с товаром, которого нет в каталоге KiT Shop` : "все товары чеков есть в каталоге");
  add("integer", "Количества целые", nonInteger ? "WARN" : "OK", nonInteger ? `${nonInteger} позиций с дробным количеством` : "все количества в чеках целые");
  add("duplicates", "Нет дублей чеков", duplicates ? "WARN" : "OK", duplicates ? `${duplicates} чеков совпадают с другим чеком по времени, сумме и составу` : "SaleId не повторяются, одинаковых чеков нет");

  // stock: the latest GetShopStocks of this fridge
  const stockAt = ds.stockAt.get(shopId) ?? null;
  const age = stockAt === null ? null : Math.round((now - stockAt) / 60_000);
  add(
    "stock",
    "Остаток совпадает с KiT Shop",
    age === null ? "FAIL" : age <= 15 ? "OK" : age <= 60 ? "WARN" : "FAIL",
    age === null ? "остаток ещё не читался" : `остаток прочитан из KiT Shop (GetShopStocks) ${age} мин назад`,
  );

  // time zone: receipts "from the future" or sales concentrated at night mean the times are shifted
  let peak = 0;
  for (let h = 1; h < 24; h++) if (byHour[h] > byHour[peak]) peak = h;
  const nightShare = units30 ? night / units30 : 0;
  const tzLevel: DataCheck["level"] = future > 0 ? "FAIL" : units30 >= 30 && (nightShare > 0.15 || peak < 7 || peak > 17) ? "WARN" : "OK";
  add(
    "timezone",
    "Часовой пояс",
    tzLevel,
    `${future ? `${future} чеков с временем в будущем; ` : ""}пик продаж в ${String(peak).padStart(2, "0")}:00, ночью (0–5 ч) ${Math.round(nightShare * 100)}% продаж${newest ? `; последний чек в ${String(Math.floor(minuteOfDay(newest) / 60)).padStart(2, "0")}:${String(minuteOfDay(newest) % 60).padStart(2, "0")}${dayNumber(newest) !== today ? ` ${ddmm(dayNumber(newest))}` : ""}` : ""}`,
  );

  // the clock check of the sync: while fridges are busy the newest receipt in KiT Shop is minutes old
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
  } else
    add("clock", "Время KiT Shop совпадает с нашим", "WARN", probe ? "проверка ждёт часа с продажами (нужно ≥ 15 чеков за час)" : "проверка ещё не выполнялась (раз в час)");

  // new receipts really arrive: the last 24 h against the same 24 h one, two and three weeks ago (weekends stay weekends)
  let last24 = 0;
  let sameBefore = 0;
  for (const s of ds.sales.values()) {
    if (s.shopId !== shopId || s.soldAt > now) continue;
    if (s.soldAt > now - DAY) last24++;
    for (const w of [7, 14, 21]) if (s.soldAt > now - (w + 1) * DAY && s.soldAt <= now - w * DAY) sameBefore++;
  }
  const usual = sameBefore / 3;
  add(
    "fresh",
    "Новые чеки приходят",
    usual >= 10 && last24 < 0.2 * usual ? "FAIL" : "OK",
    `за последние 24 ч ${last24} чеков; в те же часы неделей раньше обычно ~${Math.round(usual)}`,
  );

  // completeness
  const salesDays = today - info.historyFromDay;
  add("sales-history", "История продаж полная", salesDays >= 30 ? "OK" : "WARN", `чеки с позициями полные с ${ddmm(info.historyFromDay)} (${Math.max(0, salesDays)} дн.)`);
  const fillDays = info.fillupsFromDay === null ? null : today - info.fillupsFromDay;
  add(
    "fillups",
    "Загрузки и снятия полные",
    fillDays !== null && fillDays >= 30 ? "OK" : "WARN",
    fillDays === null ? "загрузки/снятия ещё не прочитаны" : `загрузки/снятия полные с ${ddmm(info.fillupsFromDay!)} (${Math.max(0, fillDays)} дн.)`,
  );
  add(
    "unload-writeoff",
    "Снятия не считаются списаниями",
    "OK",
    "списание = только операция KiT Shop «Списание» (тип 3); «Разгрузка» (тип 2) показывается как «снято»",
  );
  add(
    "balance",
    "Загрузки сходятся с продажами",
    info.balanced ? "OK" : "WARN",
    info.balanced ? "движение товара сходится — оценку прошлого наличия можно строить" : "загружено заметно меньше, чем продано и снято — оценка прошлого наличия не строится",
  );
  const cov = ds.stockCoverage.get(shopId) ?? [];
  const factFrom = cov.length ? dayNumber(cov[0][0]) : null;
  const factDays = factFrom === null ? 0 : today - factFrom;
  add(
    "stock-history",
    "Точная история остатков",
    factDays >= 14 ? "OK" : "WARN",
    factFrom === null ? "снимки остатков ещё не сохранялись" : `снимки остатков каждые 5 минут есть с ${ddmm(factFrom)} (${factDays} дн.)`,
  );
  return out;
}
