import "server-only";
import type { NetworkSnapshot } from "../domain/types";
import type { AnalysisResult } from "../engine/analysis";
import { NORM, STATUS_TEXT } from "../engine/productNorm";
import { DAY_MS } from "../time";

/**
 * Аналитика = PRODUCT × FRIDGE: every dish of the chosen fridge with its sales, loads / unloads, availability and the
 * norm per day, plus today's target (the same product cells the transfer recommendations use — engine/demand.ts).
 */

const ddmm = (day: number | null | undefined) => {
  if (day === null || day === undefined || !Number.isFinite(day)) return null;
  const d = new Date(day * DAY_MS);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
};

export function productAnalyticsView(snap: NetworkSnapshot, a: AnalysisResult, fridgeId: string | null, untilTime: string) {
  const fridges = snap.fridges.map((f) => ({ id: f.id, name: f.name, group: f.transferGroup ?? null }));
  const fi = Math.max(0, fridgeId ? snap.fridges.findIndex((f) => f.id === fridgeId) : 0);
  const fr = snap.fridges[fi];
  const P = snap.products.length;
  const stats = a.products.byFridge[fi] ?? [];
  const now = a.demand.NOW.products;
  const eve = a.demand.UNTIL_EVENING.products;
  const catById = new Map(snap.categories.map((c) => [c.id, c]));

  const rows = stats.map((st) => {
    const pr = snap.products[st.p];
    const cat = catById.get(pr.categoryId)!;
    const cn = now[fi * P + st.p];
    const ce = eve[fi * P + st.p];
    return {
      productId: pr.id,
      name: pr.name,
      category: { id: cat.id, name: cat.name, emoji: cat.emoji },
      ...st,
      statusText: STATUS_TEXT[st.status],
      today: cn
        ? { target: cn.target, stock: cn.stock, need: cn.need, surplus: cn.surplus, keep: cn.keep, inbound: cn.inbound, outbound: cn.outbound, reason: cn.reason, eveningTarget: ce?.target ?? null }
        : null,
    };
  });
  rows.sort((x, y) => y.sold.d30 - x.sold.d30 || y.stock - x.stock || x.name.localeCompare(y.name, "ru"));

  const sum = (k: (r: (typeof rows)[number]) => number) => rows.reduce((acc, r) => acc + k(r), 0);
  const eodKnown = rows.filter((r) => r.avgEod30 !== null);
  const pd = snap.productDays;
  const di = a.demandIndex[fi];
  const categories = snap.categories.map((c, ci) => {
    const idx = di?.index[ci] ?? 1;
    const sold30 = sum((r) => (r.category.id === c.id ? r.sold.d30 : 0));
    return {
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      sold30,
      index: Math.round(idx * 100) / 100,
      level: sold30 === 0 ? "нет продаж" : idx >= 1.15 ? "высокий спрос" : idx <= 0.85 ? "низкий спрос" : "нормальный спрос",
    };
  });

  const analysedAll = a.products.byFridge.reduce((acc, list) => acc + list.length, 0);
  const notes: string[] = [];
  if (!pd) notes.push("Нет данных о загрузках, снятиях и остатках по дням (режим без KiT Shop): наличие товара не учитывается.");
  else {
    if (pd.stockKnownFromDay === null && !pd.unbalanced.includes(fr.name)) notes.push("Наличие товара по дням пока неизвестно: история остатков только начала сохраняться, загрузки/снятия ещё догружаются. Пока дни без данных считаются днями «с товаром».");
    if (pd.fillupsFromDay === null) notes.push("Загрузки и снятия ещё не прочитаны из KiT Shop.");
    else if (pd.fillupsFromDay > a.ctx.today - 30) notes.push(`Загрузки и снятия известны только с ${ddmm(pd.fillupsFromDay)} — цифры «Снято» за 30 дней неполные.`);
    if (pd.unbalanced.includes(fr.name))
      notes.push(
        `Загрузки ${fr.name} в KiT Shop не сходятся с продажами (загружено заметно меньше, чем продано и снято) — прошлое наличие не восстанавливается, считается только по истории остатков${pd.stockHistoryFromDay !== null ? ` (с ${ddmm(pd.stockHistoryFromDay)})` : ""}.`,
      );
    if (pd.reconstructionFixes > 0) notes.push(`При восстановлении остатков ${pd.reconstructionFixes} раз не сошлось движение (в KiT Shop есть изменения остатка без загрузки/снятия, например корректировки).`);
  }
  const hf = snap.historyFromDay ?? null;
  if (hf !== null && hf > a.ctx.today - 180) notes.push(`Продажи по блюдам полные только с ${ddmm(hf)} (история догружается) — окна 60/90/180 дней короче.`);

  return {
    now: snap.now,
    source: snap.source,
    untilTime,
    fridges,
    fridge: {
      id: fr.id,
      name: fr.name,
      group: fr.transferGroup ?? null,
      summary: {
        sold30: Math.round(sum((r) => r.sold.d30)),
        removed30: Math.round(sum((r) => r.removed30)),
        writtenOff30: Math.round(sum((r) => r.writtenOff30)),
        avgStock: eodKnown.length ? Math.round(eodKnown.reduce((acc, r) => acc + (r.avgEod30 ?? 0), 0)) : null,
        stockNow: sum((r) => r.stock),
        deficit: rows.filter((r) => r.status === "MORE").length,
        surplus: rows.filter((r) => r.status === "TOO_MUCH" || r.status === "LESS").length,
        needNow: rows.filter((r) => (r.today?.need ?? 0) > 0).length,
        canGiveNow: rows.filter((r) => (r.today?.surplus ?? 0) > 0).length,
      },
      categories,
    },
    products: rows,
    data: {
      productsHere: rows.length,
      productsAll: analysedAll,
      salesFrom: ddmm(hf),
      fillupsFrom: ddmm(pd?.fillupsFromDay),
      stockKnownFrom: ddmm(pd?.stockKnownFromDay),
      stockHistoryFrom: ddmm(pd?.stockHistoryFromDay),
      writeOffRule: pd?.writeOffRule ?? null,
      notes,
      formula: [
        "Продажи за день с товаром = продано ÷ сумма наличия по открытым дням (день, когда товар был лишь половину времени продаж, считается за 0,5)",
        "Скорость = 0,35 × 7 дн. + 0,25 × 14 дн. + 0,25 × 30 дн. + 0,15 × 180 дн. (окна без данных не участвуют)",
        `+10%, если часто заканчивался (≥ ${Math.round(NORM.frequentOutShare * 100)}% времени без товара или ≥ ${NORM.frequentOutTimes} раз за 30 дн.); −10%, если списано ≥ ${Math.round(NORM.heavyWriteOffShare * 100)}% или снято ≥ ${Math.round(NORM.heavyRemovalShare * 100)}% загруженного`,
        "Норма = ⌈скорость − 0,2⌉ (не меньше 1), диапазон: округл(0,75 × скорость) … ⌈1,25 × скорость⌉; меньше 0,15 в день — нормы нет",
        "Сегодня иметь = скорость × доля обычных продаж точки, которая ещё впереди сегодня (меньше 0,3 → 0, иначе не меньше 1)",
      ],
    },
  };
}

export type ProductAnalyticsView = ReturnType<typeof productAnalyticsView>;
