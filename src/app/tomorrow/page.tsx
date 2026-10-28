"use client";

import { Shell } from "@/components/Shell";
import { TomorrowScreen } from "@/components/TomorrowScreen";

/** ЗАВТРА — сколько каждого блюда завтрашнего меню поставить в каждый холодильник. Не аналитика: рабочий план на завтра. */
export default function TomorrowPage() {
  return (
    <Shell>
      <TomorrowScreen />
    </Shell>
  );
}
