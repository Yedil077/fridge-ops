"use client";

import { Shell } from "@/components/Shell";
import { ProductAnalytics } from "@/components/ProductAnalytics";

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
          По каждому блюду в каждом холодильнике: сколько реально продаётся (с учётом дней, когда его не было), сколько снято и списано, как часто
          заканчивается — и сколько ставить в день.
        </p>
      </div>
      <ProductAnalytics />
    </Shell>
  );
}
