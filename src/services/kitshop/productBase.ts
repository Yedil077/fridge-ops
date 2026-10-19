/** Depth-first search for the first array of objects that carry a ProductId (unknown response shape of §3.32). */
export function findProductList(v: unknown, depth = 0): { productId: string; disabled: boolean | null }[] | null {
  if (depth > 4 || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    const items = v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && "ProductId" in x);
    if (items.length && items.length === v.length)
      return items.map((x) => ({
        productId: String(x.ProductId),
        disabled: x.Disabled === undefined || x.Disabled === null ? null : Boolean(Number(x.Disabled)),
      }));
    for (const x of v) {
      const r = findProductList(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === "Auth") continue;
    const r = findProductList(x, depth + 1);
    if (r) return r;
  }
  return null;
}
