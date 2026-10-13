import { z } from "zod";
import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { opView } from "@/lib/server/opsViews";
import { ROLE_RANK } from "@/lib/server/users";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser();
  const { id } = await ctx.params;
  const op = (await getRuntime()).ops.get(id);
  if (!op) throw new HttpError(404, "Операция не найдена");
  return { operation: opView(op) };
});

const Body = z.discriminatedUnion("action", [
  /** read-only check in KiT Shop (never re-sends) */
  z.object({ action: z.literal("verify") }),
  /** manual re-send — only for FAILED / WAITING_FOR_CONNECTION */
  z.object({ action: z.literal("retry") }),
  /** manager decision after checking the KiT Shop cabinet */
  z.object({ action: z.literal("resolve"), decision: z.enum(["confirmed", "failed"]), note: z.string().max(200).optional() }),
]);

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  const rt = await getRuntime();
  const op = rt.ops.get(id);
  if (!op) throw new HttpError(404, "Операция не найдена");
  const manager = ROLE_RANK[user.role] >= ROLE_RANK.MANAGER;
  if (body.action === "verify") {
    if (!manager && op.createdBy !== user.name) throw new HttpError(403, "Недостаточно прав");
    return { operation: opView(await rt.ops.verify(id, user.name)) };
  }
  if (!manager) throw new HttpError(403, "Повтор и ручное решение — только менеджер");
  if (body.action === "retry") {
    if (rt.readOnly) throw new HttpError(403, "KiT Shop подключён только для чтения — повторная отправка отключена");
    return { operation: opView(await rt.ops.retry(id, user.name)) };
  }
  return { operation: opView(rt.ops.resolve(id, body.decision, user.name, body.note)) };
});
