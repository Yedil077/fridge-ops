"use client";

/**
 * Barcode / QR verification — architecture for the future "scan to confirm" step.
 *
 * Flow (planned): mission item "Паста с курицей ×2" → employee scans the pack →
 *   verifyScan(item, code) → "ok" ✓ / "wrong" ⚠ (show which dish it actually is) / "unknown".
 *
 * Scanners are pluggable:
 *  • BrowserScanner — Web BarcodeDetector API (Chrome on Android) when available;
 *  • a Capacitor ML Kit scanner plugin can implement the same interface later
 *    (add plugin + CAMERA permission → new native release, see docs/ANDROID.md).
 * Verification itself is pure and runs on the phone; the server already sends `barcode` per item.
 */

export interface ScanTarget {
  productId: string;
  name: string;
  barcode: string | null;
}

export type ScanResult = { status: "ok" } | { status: "wrong"; actual: string | null } | { status: "unknown" };

export function verifyScan(target: ScanTarget, code: string, catalog: ScanTarget[] = []): ScanResult {
  const clean = code.trim();
  if (!target.barcode) return { status: "unknown" };
  if (clean === target.barcode) return { status: "ok" };
  const other = catalog.find((p) => p.barcode === clean);
  return { status: "wrong", actual: other?.name ?? null };
}

export interface Scanner {
  isAvailable(): Promise<boolean>;
  /** Scans one code from a video element that already shows the camera stream. */
  scanFrom(video: HTMLVideoElement): Promise<string | null>;
}

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };

export class BrowserScanner implements Scanner {
  async isAvailable() {
    return typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
  }
  async scanFrom(video: HTMLVideoElement) {
    const Ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = new Ctor({ formats: ["ean_13", "ean_8", "code_128", "qr_code"] });
    const found = await detector.detect(video);
    return found[0]?.rawValue ?? null;
  }
}
