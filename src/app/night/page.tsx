"use client";

import { Shell } from "@/components/Shell";
import { NightScreen } from "@/components/NightScreen";

/** НОЧЬ — задание ночному водителю: что забрать, списать, перевезти и поставить в каждый холодильник. */
export default function NightPage() {
  return (
    <Shell>
      <NightScreen />
    </Shell>
  );
}
