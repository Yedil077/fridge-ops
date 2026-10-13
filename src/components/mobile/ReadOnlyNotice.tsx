"use client";

import Link from "next/link";
import { MobileShell } from "@/components/mobile/MobileShell";

/** Shown instead of load / unload / write-off screens while KiT Shop is read-only. */
export function ReadOnlyNotice({ title }: { title: string }) {
  return (
    <MobileShell title={title} back="/m">
      <div className="card mt-6 p-6 text-center">
        <div className="text-[34px]">🔒</div>
        <div className="mt-2 text-[18px] font-semibold">KiT Shop подключён только для чтения</div>
        <p className="mt-2 text-[14px] text-ink-3">
          Загрузка, снятие и списание через Apps Холодосов отключены. Эти операции делаются как обычно в KiT Shop. Здесь — остатки, продажи, прогноз и рекомендации.
        </p>
        <Link href="/m" className="mt-5 flex h-12 items-center justify-center rounded-2xl bg-ink text-[16px] font-bold text-bg">
          На главную
        </Link>
      </div>
    </MobileShell>
  );
}
