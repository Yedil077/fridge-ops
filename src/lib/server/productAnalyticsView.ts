import "server-only";
import type { NetworkSnapshot } from "../domain/types";
import type { AnalysisResult } from "../engine/analysis";
import { CONFIDENCE_TEXT, NORM, QUALITY_TEXT, STATUS_TEXT } from "../engine/productNorm";
import { DAY_MS } from "../time";

/**
 * Аналитика = PRODUCT × FRIDGE: every dish of the chosen fridge — sales, loads / unloads / write-offs, availability
 * (fact and estimate apart), the norm in whole units with "почему", data quality, and today's target (the same product
 * cells the transfer recommendations use — engine/demand.ts). No fractions of a dish leave the server.
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
    const { f: _f, p: _p, ...facts } = st;
    void _f;
    void _p;
    return {
      productId: pr.id,
      externalId: pr.externalId,
      name: pr.name,
      category: { id: cat.id, name: cat.name, emoji: cat.emoji },
      ...facts,
      statusText: STATUS_TEXT[st.status],
      qualityText: QUALITY_TEXT[st.quality],
      confidenceText: CONFIDENCE_TEXT[st.confidence],
      // whole units only
      today: cn ? { target: cn.target, stock: cn.stock, need: cn.need, surplus: cn.surplus, keep: cn.keep, inbound: cn.inbound, outbound: cn.outbound, reason: cn.reason, eveningTarget: ce?.target ?? null } : null,
    };
  });
  rows.sort((x, y) => y.sold.d30 - x.sold.d30 || y.stock - x.stock || x.name.localeCompare(y.name, "ru"));

  const sum = (k: (r: (typeof rows)[number]) => number) => rows.reduce((acc, r) => acc + k(r), 0);
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
      level: sold30 === 0 ? "нет продаж" : idx >= 1.15 ? "высокий спрос" : idx <= 0.85 ? "низкий спрос" : "нормальный спрос",
    };
  });

  const checks = pd?.checks[fi] ?? [];
  const notes: string[] = [];
  if (!pd) notes.push("Нет данных о загрузках, снятиях и остатках по дням (режим без KiT Shop): наличие товара не учитывается.");

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
        sold30: sum((r) => r.sold.d30),
        loaded30: sum((r) => r.loaded30),
        removed30: sum((r) => r.removed30),
        writtenOff30: sum((r) => r.writtenOff30),
        stockNow: sum((r) => r.stock),
        more: rows.filter((r) => r.status === "MORE").length,
        tooMuch: rows.filter((r) => r.status === "TOO_MUCH" || r.status === "LESS").length,
        noData: rows.filter((r) => r.status === "NO_DATA").length,
        needNow: rows.filter((r) => (r.today?.need ?? 0) > 0).length,
        canGiveNow: rows.filter((r) => (r.today?.surplus ?? 0) > 0).length,
      },
      categories,
      checks,
      checksFailed: checks.filter((c) => c.level === "FAIL").length,
      continuity: pd?.continuity[fi] ?? [],
    },
    products: rows,
    data: {
      productsHere: rows.length,
      productsAll: a.products.byFridge.reduce((acc, list) => acc + list.length, 0),
      salesFrom: ddmm(snap.historyFromDay),
      fillupsFrom: ddmm(pd?.fillupsFromDay),
      stockHistoryFrom: ddmm(pd?.stockHistoryFromDay),
      writeOffRule: pd?.writeOffRule ?? null,
      notes,
      formula: [
        "Каждая поставка (загрузка в KiT Shop; загрузки в пределах часа — одна поставка): сколько было до неё, сколько поставили, сколько продано за 24 ч и за срок годности, сколько снято, списано и осталось к концу срока",
        "Продажи, снятия и списания всегда берут самые старые штуки (сначала продаётся старый остаток)",
        "Реализация = продано за срок годности ÷ поставлено",
        "Ставить = сколько обычно продаётся за срок годности (середина последних 8 завершённых поставок); диапазон — от слабой поставки до обычной загрузки",
        "Последние 3 поставки ушли полностью → +1 шт.; поставки такого размера постоянно оставляют 2+ и списываются → −1 шт.",
        "Поставка сегодня = целевая выкладка − годный остаток (просроченные не считаются)",
        "Дни, когда блюда не было в меню, не считаются: у них просто нет поставки",
        "Нет 3 завершённых поставок, дыра в данных или не пройдена проверка — «Недостаточно данных», нормы нет",
      ],
    },
  };
}

export type ProductAnalyticsView = ReturnType<typeof productAnalyticsView>;
