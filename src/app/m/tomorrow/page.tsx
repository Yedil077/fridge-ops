"use client";

import { MobileShell } from "@/components/mobile/MobileShell";
import { TomorrowScreen } from "@/components/TomorrowScreen";

/** ЗАВТРА на телефоне: блюдо → по холодильникам. */
export default function MobileTomorrowPage() {
  return (
    <MobileShell title="Завтра">
      <TomorrowScreen mobile />
    </MobileShell>
  );
}
