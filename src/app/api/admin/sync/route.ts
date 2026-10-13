import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { kitshopLive } from "@/lib/server/kitshopLive";
import { READ_ENDPOINTS } from "@/services/kitshop/kitshopClient";

export const dynamic = "force-dynamic";

const USED = ["shops", "products", "stocks", "sales", "saleById"] as const;

/** KiT Shop sync status (ADMIN): last syncs, counts, 180-day backfill progress, errors. Read only. */
export const GET = handle(async () => {
  await requireUser("ADMIN");
  const rt = await getRuntime();
  const endpoints = USED.map((k) => ({ name: k, method: READ_ENDPOINTS[k].path }));
  if (rt.mode !== "kitshop")
    return { mode: rt.mode, readOnly: rt.readOnly, status: null, endpoints, hint: "Для реальных данных в Render → Environment задайте DATA_SOURCE=kitshop и KITSHOP_ENABLED=true." };
  return { mode: rt.mode, readOnly: rt.readOnly, status: await kitshopLive().status(), endpoints };
});

/** "Синхронизировать сейчас": one read-only pass (GetShops/GetProducts/GetShopStocks/GetSales/GetSaleById). */
export const POST = handle(async (req: Request) => {
  await requireUser("ADMIN");
  const rt = await getRuntime();
  if (rt.mode !== "kitshop") throw new HttpError(400, "DATA_SOURCE не kitshop — синхронизация с KiT Shop выключена");
  const body = (await req.json().catch(() => ({}))) as { catalog?: boolean };
  const tick = await kitshopLive().syncNow({ catalog: !!body.catalog });
  return { tick, status: await kitshopLive().status() };
});
