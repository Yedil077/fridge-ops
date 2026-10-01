import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { productsAdmin } from "@/lib/server/opsViews";

export const dynamic = "force-dynamic";

/** Product mapping & catalog health. Managers can look; only ADMIN changes anything. */
export const GET = handle(async () => {
  await requireUser("MANAGER");
  return productsAdmin(await getRuntime());
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm-mapping"), productId: z.string().max(60), kitshopProductId: z.string().regex(/^\d{1,18}$/) }),
  z.object({ action: z.literal("deactivate"), productId: z.string().max(60), inactive: z.boolean() }),
  /** preview=true returns exactly what would be sent to AddProduct; false creates it (ADMIN, explicit confirm) */
  z.object({ action: z.literal("create-in-kitshop"), productId: z.string().max(60), preview: z.boolean() }),
]);

export const POST = handle(async (req: Request) => {
  const admin = await requireUser("ADMIN");
  const body = Body.parse(await req.json());
  const rt = await getRuntime();
  switch (body.action) {
    case "confirm-mapping":
      return rt.confirmMapping(body.productId, body.kitshopProductId, admin.name);
    case "deactivate":
      return rt.setProductInactive(body.productId, body.inactive, admin.name);
    case "create-in-kitshop":
      return rt.createInKitShop(body.productId, body.preview, admin.name);
  }
});
