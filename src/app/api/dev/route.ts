import { z } from "zod";
import { currentUser, handle } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

const Body = z.object({
  action: z.enum(["advance15", "advance60", "advance180", "to-close", "now", "sales", "shortage", "overstock", "anomaly", "reset-day", "analyze", "reseed", "ks-timeout", "ks-lost", "ks-reject", "ks-offline", "ks-slow"]),
});

/** DEV PANEL — simulator and the fake (mock) KiT Shop only. Never touches the real KitShop. */
export const POST = handle(async (req: Request) => {
  await currentUser("ADMIN");
  const { action } = Body.parse(await req.json());
  const rt = await getRuntime();
  const message = rt.devAction(action);
  return { message, log: rt.sim?.state.log.slice(0, 8) ?? [] };
});

export const GET = handle(async () => {
  await currentUser("ADMIN");
  const rt = await getRuntime();
  return { mode: rt.mode, log: rt.sim?.state.log.slice(0, 8) ?? [] };
});
