import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { kitShopDiagnostics } from "@/services/kitshop";
import { ENGINE_CONFIG } from "@/lib/config/engine";

export const dynamic = "force-dynamic";

/** System status: data source, KitShop read-only diagnostics (booleans only), engine config. */
export const GET = handle(async () => {
  await currentUser("ADMIN");
  const rt = await getRuntime();
  return { mode: rt.mode, kitshop: kitShopDiagnostics(), engine: ENGINE_CONFIG, lastAnalysisAt: rt.state.lastAnalysisAt };
});
