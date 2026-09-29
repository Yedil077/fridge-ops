import type { CategoryId, DemandIndexRow, FridgePersonality } from "../domain/types";
import { fmtHM, weekdayOf } from "../time";
import { histDay, hourlyAt, type EngineContext } from "./history";

/**
 * Fridge personality & demand index — computed from data only.
 * Demand index: category share at the fridge ÷ network category share (1.00 = network average).
 */

export function demandIndex(ctx: EngineContext): DemandIndexRow[] {
  const { F, C, D } = ctx;
  const shares: number[][] = [];
  const net = new Array<number>(C).fill(0);
  for (let f = 0; f < F; f++) {
    const s = new Array<number>(C).fill(0);
    for (let c = 0; c < C; c++)
      for (let d = 0; d < D; d++) s[c] += ctx.catDay[(f * C + c) * D + d] * ctx.dayWeight[d];
    const tot = s.reduce((a, b) => a + b, 0) || 1;
    shares.push(s.map((v) => v / tot));
    s.forEach((v, c) => (net[c] += v));
  }
  const netTot = net.reduce((a, b) => a + b, 0) || 1;
  const netShare = net.map((v) => v / netTot);
  return shares.map((share, f) => ({
    fridgeIndex: f,
    share,
    index: share.map((v, c) => (netShare[c] > 0 ? v / netShare[c] : 1)),
  }));
}

const TITLES: Record<CategoryId, [string, string]> = {
  breakfast: ["🥐", "Breakfast Club"],
  hot: ["🔥", "Hot Meals Lover"],
  salad: ["🥗", "Salad Lover"],
  snack: ["🥪", "Snack Station"],
  dessert: ["🍰", "Dessert Hunter"],
  drink: ["🥤", "Drinks Hub"],
};

const WD_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function avgPerOpenDay(ctx: EngineContext, f: number, c: number, fromAge: number, toAge: number): number {
  let s = 0;
  let n = 0;
  for (let d = 0; d < ctx.D; d++) {
    const age = ctx.today - histDay(ctx, d);
    if (age < fromAge || age > toAge || !ctx.sample[f * ctx.D + d]) continue;
    s += ctx.catDay[(f * ctx.C + c) * ctx.D + d];
    n++;
  }
  return n ? s / n : 0;
}

export function personality(ctx: EngineContext, f: number, di: DemandIndexRow): FridgePersonality {
  const { C, D, P, snap } = ctx;
  let dataDays = 0;
  const hourlyAvg = new Array<number>(24).fill(0);
  const wdSum = new Array<number>(7).fill(0);
  const wdN = new Array<number>(7).fill(0);
  let n90 = 0;
  for (let d = 0; d < D; d++) {
    if (!ctx.sample[f * D + d]) continue;
    dataDays++;
    const day = histDay(ctx, d);
    const age = ctx.today - day;
    if (age > 90) continue;
    n90++;
    const wd = weekdayOf(day) - 1;
    wdSum[wd] += ctx.fridgeDay[f * D + d];
    wdN[wd]++;
    for (let c = 0; c < C; c++) for (let h = 0; h < 24; h++) hourlyAvg[h] += hourlyAt(ctx, f, c, d, h);
  }
  for (let h = 0; h < 24; h++) hourlyAvg[h] = n90 ? hourlyAvg[h] / n90 : 0;
  const weekdayAvg = wdSum.map((s, i) => (wdN[i] ? s / wdN[i] : 0));

  // best 2-hour window
  let peak: FridgePersonality["peakWindow"] = null;
  let best = 0;
  for (let h = 0; h < 23; h++) {
    const v = hourlyAvg[h] + hourlyAvg[h + 1];
    if (v > best) {
      best = v;
      peak = { from: h, to: h + 2 };
    }
  }
  const dayTotal = hourlyAvg.reduce((a, b) => a + b, 0) || 1;
  const morningShare = hourlyAvg.slice(0, 11).reduce((a, b) => a + b, 0) / dayTotal;
  const eveningShare = hourlyAvg.slice(17).reduce((a, b) => a + b, 0) / dayTotal;

  const trend = snap.categories.map((_, c) => {
    const sixMonthsAgo = avgPerOpenDay(ctx, f, c, 150, 180);
    const threeMonthsAgo = avgPerOpenDay(ctx, f, c, 76, 105);
    const last30 = avgPerOpenDay(ctx, f, c, 1, 30);
    const changePct = sixMonthsAgo > 0 ? Math.round((last30 / sixMonthsAgo - 1) * 100) : 0;
    return { categoryIndex: c, sixMonthsAgo, threeMonthsAgo, last30, changePct };
  });

  // products (last 30 days)
  let openDays30 = 0;
  for (let d = Math.max(0, D - 30); d < D; d++) if (ctx.sample[f * D + d]) openDays30++;
  const perDay = snap.products.map((_, p) => {
    let s = 0;
    for (let d = Math.max(0, D - 30); d < D; d++) s += snap.history.productDaily[(f * P + p) * D + d];
    return { productIndex: p, perDay: openDays30 ? s / openDays30 : 0 };
  });
  const sorted = [...perDay].sort((a, b) => b.perDay - a.perDay);

  // title
  const idx = di.index;
  let topC = 0;
  for (let c = 1; c < C; c++) if (idx[c] > idx[topC]) topC = c;
  const coldStart = dataDays < 60;
  let emoji = "⚖️";
  let title = "Balanced";
  if (coldStart) {
    emoji = "🆕";
    title = "New Location";
  } else if (idx[topC] >= 1.25) {
    [emoji, title] = TITLES[snap.categories[topC].id];
  } else if (morningShare > 0.32) {
    emoji = "🌅";
    title = "Early Bird";
  } else if (eveningShare > 0.3) {
    emoji = "🌙";
    title = "Night Owl";
  }

  const traits: FridgePersonality["traits"] = [];
  snap.categories.forEach((cat, c) => {
    const v = idx[c];
    if (v >= 1.25) traits.push({ label: `${cat.emoji} ${cat.name}`, value: `${v.toFixed(2)}× к сети`, tone: "up" });
    else if (v <= 0.8) traits.push({ label: `${cat.emoji} ${cat.name}`, value: `${v.toFixed(2)}× — низкий спрос`, tone: "down" });
  });
  if (peak) traits.push({ label: "Пик", value: `${fmtHM(peak.from * 60)}–${fmtHM(peak.to * 60)}`, tone: "neutral" });
  const openWd = weekdayAvg.map((v, i) => ({ v, i })).filter((x) => x.v > 0);
  const avgOpen = openWd.reduce((a, x) => a + x.v, 0) / (openWd.length || 1);
  const strongest = openWd.sort((a, b) => b.v - a.v)[0];
  if (strongest && strongest.v > avgOpen * 1.12)
    traits.push({ label: WD_NAMES[strongest.i], value: `очень высокий спрос (+${Math.round((strongest.v / avgOpen - 1) * 100)}%)`, tone: "up" });
  if (weekdayAvg[5] === 0 && weekdayAvg[6] === 0) traits.push({ label: "Выходные", value: "закрыт", tone: "neutral" });
  const bigTrend = [...trend].filter((t) => t.sixMonthsAgo >= 3).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))[0];
  if (bigTrend && Math.abs(bigTrend.changePct) >= 25) {
    const cat = snap.categories[bigTrend.categoryIndex];
    traits.push({
      label: `Тренд ${cat.emoji}`,
      value: `${bigTrend.changePct > 0 ? "+" : ""}${bigTrend.changePct}% за 6 мес`,
      tone: bigTrend.changePct > 0 ? "up" : "down",
    });
  }
  if (coldStart) traits.push({ label: "Данные", value: `${dataDays} дн. — прогноз опирается на похожие точки`, tone: "neutral" });

  return {
    fridgeIndex: f,
    title,
    emoji,
    traits,
    peakWindow: peak,
    weekdayAvg,
    hourlyAvg,
    categoryShare: di.share,
    demandIndex: di.index,
    trend,
    topProducts: sorted.slice(0, 3).filter((x) => x.perDay > 0),
    weakProducts: sorted.filter((x) => x.perDay > 0).slice(-2).reverse(),
    dataDays,
    coldStart,
  };
}
