"use client";

import { MobileShell } from "@/components/mobile/MobileShell";
import { NightScreen } from "@/components/NightScreen";

/** НОЧЬ на телефоне: маршрут точка за точкой. */
export default function MobileNightPage() {
  return (
    <MobileShell title="Ночь">
      <NightScreen mobile />
    </MobileShell>
  );
}
