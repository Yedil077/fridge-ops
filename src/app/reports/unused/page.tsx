"use client";

import { Shell } from "@/components/Shell";
import { UnusedProductsReport } from "@/components/admin/UnusedProductsReport";
import { atLeast, useMe } from "@/lib/client/api";

/** Отдельный отчёт, не часть ежедневной работы: Excel «неиспользуемые блюда». Менеджеры скачивают, админ может пересобрать. */
export default function UnusedReportPage() {
  const { data: me } = useMe();
  return (
    <Shell>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-4 text-[22px] font-bold">Неиспользуемые блюда</h1>
        <UnusedProductsReport enabled={atLeast(me, "ADMIN")} />
      </div>
    </Shell>
  );
}
