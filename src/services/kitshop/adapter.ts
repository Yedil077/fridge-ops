import type { CategoryId, HistoryCube, Product } from "@/lib/domain/types";
import { CATEGORIES } from "@/lib/domain/categories";
import type { KitShopProduct } from "./types";

/**
 * Maps KitShop DTOs to our domain. Pure functions — no network, no writes.
 */

/**
 * Category of a real KiT Shop dish by its name (Green City menu). Order matters: the first matching rule wins,
 * so "Сэндвич с курицей" is a snack and "Гуляш с отварным рисом" is hot (not a drink because of "отвар"). Editable; unknown names fall back to "snack".
 * (?<![а-яё]) / (?![а-яё]) are word start / end for Cyrillic (JS \b only knows Latin letters): "сок" is not "кусок".
 */
export const CATEGORY_RULES: { category: CategoryId; pattern: RegExp }[] = [
  { category: "drink", pattern: /\d+\s*мл(?![а-яё])|морс(?![а-яё])|компот|лимонад|(?<![а-яё])чай(?![а-яё])|каркаде|(?<![а-яё])отвар(?![а-яё])|напиток|(?<![а-яё])сок(?![а-яё])|(?<![а-яё])вода(?![а-яё])|смузи|кефир|айран|кофе|кисель|узвар|exponenta/i },
  { category: "breakfast", pattern: /завтрак|сырник|(?<![а-яё])каш[аи](?![а-яё])|панкейк|вафл|омлет|кр[эе]мбл|фрит+ат|драник|оладь|гранол[аы]? с йогурт|маффины яичные|^\s*яйцо|творожн[а-яё]* запеканк|творожно-[а-яё]+ запеканк|творожный боул|блин[а-яё]* (со?|из) (творож|сгущ|шоколад|банан|ягод)|шоколадные блинчики/i },
  { category: "dessert", pattern: /десерт|тирамису|трайфл|чизкейк|мильфей|мусс(?![а-яё])|пудинг|кукис|печень|щербет|медовик|(?<![а-яё])торт(?![а-яё])|пп пирог|(?<![а-яё-])сладк|эклер|макарун|чак-чак|парфе|капкейк|баноффи|кекс|панна|бисквит|суфле|творожная масса|сочник|взбитыми сливками|(лимонный|яблочный|морковно-овсяный) пирог|фрукт|активиа|данон|живой йогурт/i },
  { category: "snack", pattern: /сэндвич|панини|панани|(?<![а-яё])ролл(?![а-яё])|круассан|(?<![а-яё])киш(?![а-яё])|кесадиль|самса|лепешк|пирож|курник|пирог|бургер|хот-дог|сосиска|слойк|бейгл|чиабатт|борек|(?<![а-яё])пита(?![а-яё])|буритто|тартиль|боксмастер|наггетс|крылышк|брускет|бутерброд|орама|блинчики/i },
  { category: "salad", pattern: /салат|оливье|под шубой|винегрет|мимоза|нисуаз|боул|ачучук|нарезк|по-корейски|карпаччо|ассорти|спаржа/i },
  { category: "hot", pattern: /(?<![а-яё])рис(?![а-яё])|рисом|гречк|гречнев|пюре|картоф|картошк|макарон|паст[аойу]|спагетти|тальятелле|фузилли|лапш|плов|лагман|цомян|манты|гуляш|жаркое|котлет|шницель|стейк|филе|медальон|фрикасе|бефстро|(?<![а-яё])вок(?![а-яё])|лазань|фунчоза|ганфан|чахохбили|тефтел|фрикадел|митбол|бифштекс|окрошк|(?<![а-яё])суп|борщ|булгур|птитим|кус-?кус|форел|лосос|судак|(?<![а-яё])кет[аы](?![а-яё])|рыбн|конин|телятин|говядин|голубц|гриль|гриле|цыпл|утин|шашлык|фарширован|запеканк|крокет|кебаб|мясо по/i },
];

export function categorize(name: string, group?: string | null): CategoryId {
  const text = `${group ?? ""} ${name}`;
  for (const rule of CATEGORY_RULES) if (rule.pattern.test(text)) return rule.category;
  return "snack";
}

export function toProduct(p: KitShopProduct, groupName?: string | null): Product {
  return {
    id: `K${p.ProductId}`,
    externalId: p.ProductId,
    name: p.ProductName,
    categoryId: categorize(p.ProductName, groupName),
    price: p.Price ?? 0,
    sku: p.VendorCode || p.ShortCodes || p.ProductId.slice(-5),
    imageUrl: null,
    barcode: p.Barcode || null,
  };
}

/** One sold product line (from sale details), already in our wall-clock time. */
export interface SaleLine {
  shopId: string;
  productId: string;
  quantity: number;
  /** wall-clock ms */
  soldAt: number;
}

/**
 * Aggregates sale lines into the history cube used by the engine.
 * Returns (quantity may be negative) are included as negative sales.
 */
export function aggregateSales(
  sales: SaleLine[],
  shopIndex: Map<string, number>,
  productIndex: Map<string, number>,
  products: Product[],
  startDay: number,
  days: number,
): HistoryCube {
  const F = shopIndex.size;
  const C = CATEGORIES.length;
  const P = products.length;
  const hourly = new Float32Array(F * C * days * 24);
  const productDaily = new Float32Array(F * P * days);
  const catIdx = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  for (const s of sales) {
    const f = shopIndex.get(s.shopId);
    const p = productIndex.get(s.productId);
    if (f === undefined || p === undefined) continue;
    const d = Math.floor(s.soldAt / 86_400_000) - startDay;
    if (d < 0 || d >= days) continue;
    const h = new Date(s.soldAt).getUTCHours();
    const c = catIdx.get(products[p].categoryId)!;
    hourly[((f * C + c) * days + d) * 24 + h] += s.quantity;
    productDaily[(f * P + p) * days + d] += s.quantity;
  }
  return { startDay, days, hourly, productDaily, holidays: [] };
}
