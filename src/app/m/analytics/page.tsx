"use client";

import { MobileShell } from "@/components/mobile/MobileShell";
import { ProductAnalytics } from "@/components/ProductAnalytics";

/** Аналитика на телефоне: холодильник → все блюда, норма на день и что добавить сегодня. */
export default function MobileAnalyticsPage() {
  return (
    <MobileShell title="Аналитика">
      <ProductAnalytics mobile />
    </MobileShell>
  );
}
