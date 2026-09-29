import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** Unlocked reward milestones. Nothing is handed out automatically — an admin confirms each one. */
export const GET = handle(async () => {
  (await requireUser("ADMIN")).name;
  const rt = await getRuntime();
  return {
    claims: [...rt.state.rewardClaims].sort((x, y) => y.unlockedAt - x.unlockedAt),
    players: Object.values(rt.state.players).map((p) => ({ name: p.name, xp: p.xp, points: p.points })),
  };
});

const Body = z.object({ claimId: z.string().max(60) });

export const POST = handle(async (req: Request) => {
  const admin = (await requireUser("ADMIN")).name;
  const { claimId } = Body.parse(await req.json());
  return (await getRuntime()).rewardIssue(claimId, admin);
});
