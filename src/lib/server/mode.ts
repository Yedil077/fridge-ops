import "server-only";
import type { ForecastMode } from "../domain/types";

/** Forecast horizon requested by the client: ?mode=realtime | until20 (default realtime). */
export function modeFrom(req: Request): ForecastMode {
  const m = new URL(req.url).searchParams.get("mode");
  return m === "until20" ? "until20" : "realtime";
}
