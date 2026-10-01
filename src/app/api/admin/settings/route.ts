import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** App-wide settings: the clock time of the "ДО HH:MM" forecast mode. */
export const GET = handle(async () => {
  await requireUser("ADMIN");
  return { untilTime: (await getRuntime()).untilTime() };
});

const Body = z.object({ untilTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) });

export const PUT = handle(async (req: Request) => {
  const admin = await requireUser("ADMIN");
  const { untilTime } = Body.parse(await req.json());
  const rt = await getRuntime();
  rt.setUntilMinute(Number(untilTime.slice(0, 2)) * 60 + Number(untilTime.slice(3)));
  rt.ops.audit(admin.name, "settings.until_time", "settings", "untilTime", { untilTime });
  return { untilTime: rt.untilTime() };
});
