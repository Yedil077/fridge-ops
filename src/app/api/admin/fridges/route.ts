import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { fmtHM } from "@/lib/time";

export const dynamic = "force-dynamic";

/** Fridges as staff see them (display names etc.) + the raw source ids. */
export const GET = handle(async () => {
  (await requireUser("ADMIN")).name;
  const rt = await getRuntime();
  const snap = await rt.snapshot();
  return {
    mode: rt.mode,
    fridges: snap.fridges.map((f) => ({
      id: f.id,
      externalId: f.externalId,
      code: f.code,
      displayName: f.name,
      shortName: f.shortName,
      location: f.location,
      priority: f.priority,
      proximityGroup: f.proximityGroup ?? "",
      transferGroup: f.transferGroup ?? "",
      workingDays: f.workingDays,
      opening: fmtHM(f.openingMinute),
      closing: fmtHM(f.closingMinute),
    })),
    travelOverrides: rt.state.travelOverrides,
  };
});

const hm = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .transform((v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3)));

const Body = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  displayName: z.string().trim().min(1).max(40).optional(),
  shortName: z.string().trim().min(1).max(20).optional(),
  location: z.string().trim().max(80).optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  proximityGroup: z.string().trim().max(30).nullable().optional(),
  transferGroup: z.string().trim().max(30).nullable().optional(),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  opening: hm.optional(),
  closing: hm.optional(),
});

export const PUT = handle(async (req: Request) => {
  (await requireUser("ADMIN")).name;
  const b = Body.parse(await req.json());
  const rt = await getRuntime();
  const snap = await rt.snapshot();
  if (!snap.fridges.some((f) => f.id === b.id)) throw new HttpError(404, "Холодильник не найден");
  return rt.updateFridgeSettings(b.id, {
    displayName: b.displayName,
    shortName: b.shortName,
    location: b.location,
    priority: b.priority,
    proximityGroup: b.proximityGroup === "" ? null : b.proximityGroup,
    transferGroup: b.transferGroup === "" ? null : b.transferGroup?.toUpperCase(),
    workingDays: b.workingDays as (1 | 2 | 3 | 4 | 5 | 6 | 7)[] | undefined,
    openingMinute: b.opening,
    closingMinute: b.closing,
  });
});
