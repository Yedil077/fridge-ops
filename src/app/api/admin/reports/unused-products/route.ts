import { handle, requireUser } from "@/lib/server/http";
import { getRuntime, HttpError } from "@/lib/server/runtime";
import { reportFile, reportStatus, startUnusedReport } from "@/lib/server/unusedReport";

export const dynamic = "force-dynamic";

/** "Неиспользуемые блюда" (real KiT Shop, read-only). GET = status, GET ?download=1 = the Excel file, POST = build. */
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("download") === "1") {
    try {
      await requireUser("ADMIN");
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
    }
    const f = reportFile();
    if (!f) return Response.json({ error: "Отчёт ещё не сформирован" }, { status: 404 });
    return new Response(f.data as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${f.name}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return statusHandler();
}

const statusHandler = handle(async () => {
  await requireUser("ADMIN");
  return reportStatus();
});

export const POST = handle(async () => {
  const admin = await requireUser("ADMIN");
  const rt = await getRuntime();
  const s = startUnusedReport(admin.name);
  if (!s) throw new HttpError(500, "Не удалось запустить отчёт");
  rt.ops.audit(admin.name, "report.unused_products", "report", "unused-products", { status: s.status });
  rt.save();
  return s;
});
