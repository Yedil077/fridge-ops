"use client";

import { Shell } from "@/components/Shell";
import { AnalyticsScreen } from "@/components/AnalyticsScreen";

/**
 * Аналитика = ПРОДУКТ × ХОЛОДИЛЬНИК: выбираю холодильник → все его блюда: сколько продаётся, сколько снято/списано,
 * как часто заканчивается и сколько ставить в день.
 */
export default function AnalyticsPage() {
  return (
    <Shell>
      <div className="mb-4">
        <h1 className="text-[22px] font-bold">Аналитика блюд</h1>
        <p className="text-[13px] text-ink-3">
          Сначала вся сеть — все холодильники и все блюда вместе, потом каждый холодильник отдельно: сколько продаётся, сколько снято и списано, как часто
          заканчивается — и сколько ставить в день.
        </p>
      </div>
      <AnalyticsScreen />
    </Shell>
  );
}
