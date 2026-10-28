/**
 * Direction of a fill-up line by its KiT Shop operation type (FillupType: 1 загрузка, 2 разгрузка, 3 списание — the
 * company's own reference, «Справочник» in the KiT Shop integration sheet). KiT Shop gives the quantity of an unload /
 * write-off as a POSITIVE number, so the sign alone must not decide. Unknown type → the sign.
 *   load → +qty; unload → −|qty| ("снято": moves, returns, anything); write-off → −|qty| and counted as a CONFIRMED write-off.
 */
export function fillDirection(type: number | null, qty: number): { delta: number; kind: "load" | "unload" | "writeoff" } {
  if (type === 3) return { delta: -Math.abs(qty), kind: "writeoff" };
  if (type === 2) return { delta: -Math.abs(qty), kind: "unload" };
  if (type === 1) return { delta: qty, kind: qty >= 0 ? "load" : "unload" };
  return { delta: qty, kind: qty >= 0 ? "load" : "unload" };
}

export const WRITE_OFF_RULE = "операция KiT Shop с типом «Списание» (FillupType 3); «Разгрузка» (FillupType 2) — это только «снято»: перенос, возврат или другое";
