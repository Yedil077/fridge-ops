import "server-only";
import { FORECAST_MODE_IDS, type ForecastMode } from "../domain/types";

/** Forecast horizon requested by the client: ?mode=realtime | h1 | h2 | until20 | activity (default realtime). */
export function modeFrom(req: Request): ForecastMode {
  const m = new URL(req.url).searchParams.get("mode") as ForecastMode | null;
  return m && FORECAST_MODE_IDS.includes(m) ? m : "realtime";
}
