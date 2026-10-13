import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLive } from "@/lib/server/kitshopLive";
import { READ_ENDPOINTS } from "@/services/kitshop/kitshopClient";

export const dynamic = "force-dynamic";

const USED = ["shops", "products", "productGroups", "stocks", "sales", "saleById"] as const;

/** KiT Shop sync status (ADMIN): last syncs, counts, 180-day backfill progress, errors. Read only. */
export const GET = handle(async () => {
  await requireUser("ADMIN");
  const rt = await getRuntime();
  const endpoints = USED.map((k) => ({ name: k, method: READ_ENDPOINTS[k].path }));
  if (rt.mode !== "kitshop" && !rt.shadow)
    return {
      mode: rt.mode,
      shadow: false,
      readOnly: rt.readOnly,
      status: null,
      compare: null,
      endpoints,
      hint: "Безопасный первый шаг: в Render → Environment задайте DATA_SOURCE=kitshop_shadow и KITSHOP_ENABLED=true (данные синхронизируются, пользователи пока видят прежние экраны).",
    };
  return { mode: rt.mode, shadow: rt.shadow, readOnly: rt.readOnly, status: await kitshopLive().status(), compare: await rt.shadowCompare(), endpoints };
});

/** "Синхронизировать сейчас": one read-only pass (GetShops/GetProducts/GetShopStocks/GetSales/GetSaleById). */
export const POST = handle(async (req: Request) => {
  await requireUser("ADMIN");
  const rt = await getRuntime();
  if (rt.mode !== "kitshop" && !rt.shadow) throw new HttpError(400, "DATA_SOURCE не kitshop / kitshop_shadow — синхронизация с KiT Shop выключена");
  const body = (await req.json().catch(() => ({}))) as { catalog?: boolean };
  const tick = await kitshopLive().syncNow({ catalog: !!body.catalog });
  return { tick, status: await kitshopLive().status() };
});
