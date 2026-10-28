"use client";

import { MobileShell } from "@/components/mobile/MobileShell";
import { AnalyticsScreen } from "@/components/AnalyticsScreen";

/** Аналитика на телефоне: холодильник → все блюда, норма на день и что добавить сегодня. */
export default function MobileAnalyticsPage() {
  return (
    <MobileShell title="Аналитика">
      <AnalyticsScreen mobile />
    </MobileShell>
  );
}
