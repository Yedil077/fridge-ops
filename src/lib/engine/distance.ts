import { ENGINE_CONFIG } from "../config/engine";
import type { Fridge } from "../domain/types";

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Travel minutes between fridges.
 * Manual overrides (by fridge id pair) win; otherwise estimated from coordinates;
 * if coordinates are missing — a neutral default so distance does not dominate.
 */
export function buildTravelMatrix(
  fridges: Fridge[],
  overrides: Record<string, number> = {},
  defaultMinutes = 15,
): number[][] {
  const { speedKmh, overheadMinutes, nearMinutes } = ENGINE_CONFIG.distance;
  return fridges.map((a) =>
    fridges.map((b) => {
      if (a.id === b.id) return 0;
      const manual = overrides[`${a.id}>${b.id}`] ?? overrides[`${b.id}>${a.id}`];
      if (manual !== undefined) return manual;
      const near = a.proximityGroup && a.proximityGroup === b.proximityGroup;
      if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return near ? nearMinutes : defaultMinutes;
      const km = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
      const minutes = Math.round(overheadMinutes + (km / speedKmh) * 60);
      return near ? Math.min(minutes, nearMinutes) : minutes;
    }),
  );
}

/** Priority multiplier for a route: nearby → small bonus, far → penalty, too far → 0. */
export function distanceFactor(minutes: number): number {
  const { bonus, perMinute, minFactor, maxTravelMinutes } = ENGINE_CONFIG.distance;
  if (minutes > maxTravelMinutes) return 0;
  return Math.min(bonus, Math.max(minFactor, bonus - perMinute * minutes));
}
