/**
 * Apps Холодосов product ↔ KiT Shop product mapping.
 * Order of trust: confirmed mapping / kitshop_product_id → barcode → vendor_code.
 * A NAME is only ever a suggestion — never an automatic match (similar names are different dishes).
 * Ambiguous matches (two KiT Shop products with the same barcode) → MAPPING_REQUIRED.
 */

export interface CatalogItem {
  productId: string;
  name: string;
  barcode: string | null;
  vendorCode: string | null;
}

export interface LocalProduct {
  id: string;
  name: string;
  barcode: string | null;
  /** our SKU / label code, compared with KiT Shop VendorCode */
  sku: string | null;
}

export interface ConfirmedMapping {
  kitshopProductId: string;
  matchedBy: MatchedBy;
  confirmedBy: string;
  at: number;
  /** "Деактивировать локально": product hidden in Apps Холодосов (never deleted in KiT Shop) */
  inactive?: boolean;
}

export type MatchedBy = "kitshop_id" | "barcode" | "vendor_code" | "manual";

export type MappingResult =
  | { status: "MAPPED"; kitshopProductId: string; matchedBy: MatchedBy }
  | { status: "MAPPING_REQUIRED"; reason: "not_found" | "ambiguous" | "stale"; suggestions: CatalogItem[] };

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
const clean = (s: string | null | undefined) => (s ?? "").trim();

export function resolveMapping(p: LocalProduct, catalog: CatalogItem[], confirmed?: ConfirmedMapping): MappingResult {
  const byId = new Map(catalog.map((c) => [c.productId, c]));
  if (confirmed) {
    if (byId.has(confirmed.kitshopProductId)) return { status: "MAPPED", kitshopProductId: confirmed.kitshopProductId, matchedBy: confirmed.matchedBy };
    return { status: "MAPPING_REQUIRED", reason: "stale", suggestions: suggest(p, catalog) };
  }
  for (const [key, field] of [
    ["barcode", "barcode"],
    ["vendor_code", "vendorCode"],
  ] as const) {
    const value = clean(key === "barcode" ? p.barcode : p.sku);
    if (!value) continue;
    const hits = catalog.filter((c) => clean(c[field]) === value);
    if (hits.length === 1) return { status: "MAPPED", kitshopProductId: hits[0].productId, matchedBy: key };
    if (hits.length > 1) return { status: "MAPPING_REQUIRED", reason: "ambiguous", suggestions: hits.slice(0, 5) };
  }
  return { status: "MAPPING_REQUIRED", reason: "not_found", suggestions: suggest(p, catalog) };
}

/** Name-based suggestions for a human to confirm (top 5 by shared words). */
export function suggest(p: LocalProduct, catalog: CatalogItem[]): CatalogItem[] {
  const words = new Set(norm(p.name).split(" ").filter((w) => w.length > 2));
  if (!words.size) return [];
  return catalog
    .map((c) => ({ c, score: norm(c.name).split(" ").filter((w) => words.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.c);
}

export interface CatalogHealth {
  total: number;
  mapped: number;
  byBarcode: number;
  byVendorCode: number;
  manual: number;
  mappingRequired: number;
  ambiguous: number;
  missingBarcode: number;
  duplicateBarcodes: string[];
  inactive: number;
}

export function catalogHealth(products: LocalProduct[], catalog: CatalogItem[], confirmed: Record<string, ConfirmedMapping>): CatalogHealth {
  const h: CatalogHealth = { total: products.length, mapped: 0, byBarcode: 0, byVendorCode: 0, manual: 0, mappingRequired: 0, ambiguous: 0, missingBarcode: 0, duplicateBarcodes: [], inactive: 0 };
  const seen = new Map<string, number>();
  for (const c of catalog) if (clean(c.barcode)) seen.set(clean(c.barcode), (seen.get(clean(c.barcode)) ?? 0) + 1);
  h.duplicateBarcodes = [...seen.entries()].filter(([, n]) => n > 1).map(([b]) => b);
  for (const p of products) {
    if (confirmed[p.id]?.inactive) h.inactive++;
    if (!clean(p.barcode)) h.missingBarcode++;
    const r = resolveMapping(p, catalog, confirmed[p.id]);
    if (r.status === "MAPPED") {
      h.mapped++;
      if (r.matchedBy === "barcode") h.byBarcode++;
      else if (r.matchedBy === "vendor_code") h.byVendorCode++;
      else h.manual++;
    } else {
      h.mappingRequired++;
      if (r.reason === "ambiguous") h.ambiguous++;
    }
  }
  return h;
}
