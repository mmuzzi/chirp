import { createQRTransferProfile } from "@raptorqr/core/protocol/profiles";
import { OPTICAL_FRAME_OVERHEAD } from "@/lib/optical-transfer";

function makePreset<
  const T extends {
    label: string;
    description: string;
    version: number;
    ecc: "L" | "M" | "Q" | "H";
    fps: number;
    lanes: 1 | 2;
    repairPercent: number;
    repairPoolPercent?: number;
    renderScale: number;
    fallbackRenderScale?: number;
  },
>(value: T) {
  const qr = createQRTransferProfile(value.version, value.ecc);
  return {
    ...value,
    codec: "qr" as const,
    qrCapacity: qr.maxPacketSize,
    symbolSize: qr.maxPacketSize - OPTICAL_FRAME_OVERHEAD,
    usefulBytesPerFrame:
      qr.maxPacketSize - OPTICAL_FRAME_OVERHEAD - 4,
  };
}

export const TRANSFER_PRESETS = {
  robust: makePreset({
    label: "Robust",
    description: "V15-M · larger camera modules",
    version: 15,
    fps: 7,
    lanes: 1,
    ecc: "M" as const,
    repairPercent: 35,
    repairPoolPercent: 70,
    renderScale: 1,
    fallbackRenderScale: 7,
  }),
  balanced: makePreset({
    label: "Balanced",
    description: "V25-M · speed with 15% QR repair",
    version: 25,
    fps: 10,
    lanes: 1,
    ecc: "M" as const,
    repairPercent: 30,
    repairPoolPercent: 60,
    renderScale: 1,
    fallbackRenderScale: 6,
  }),
  turbo: makePreset({
    label: "Turbo 15",
    description: "V30-L · four refreshes per symbol on 60 Hz",
    version: 30,
    fps: 15,
    lanes: 1,
    ecc: "L" as const,
    repairPercent: 25,
    repairPoolPercent: 50,
    renderScale: 1,
    fallbackRenderScale: 6,
  }),
  turbo30: makePreset({
    label: "Fallback · single lane",
    description: "V30-L · more forgiving camera view",
    version: 30,
    fps: 30,
    lanes: 1,
    ecc: "L" as const,
    repairPercent: 30,
    repairPoolPercent: 60,
    // Keep the compatibility path at the proven physical render scale. The
    // fast dual profile uses the logical-resolution compositor path below.
    renderScale: 5,
    fallbackRenderScale: 5,
  }),
  turbo60: makePreset({
    label: "Turbo 60 · dual",
    description: "2× V30-L · each lane remains stable at 30 fps",
    version: 30,
    fps: 60,
    lanes: 2,
    ecc: "L" as const,
    repairPercent: 35,
    repairPoolPercent: 70,
    renderScale: 1,
    fallbackRenderScale: 5,
  }),
  megabit: makePreset({
    label: "1 Mbps · dual lab",
    description: "2× V40-L · 30 fps per lane · close range",
    version: 40,
    fps: 60,
    lanes: 2,
    ecc: "L" as const,
    repairPercent: 35,
    repairPoolPercent: 70,
    renderScale: 1,
    fallbackRenderScale: 5,
  }),
  megabit120: makePreset({
    label: "Fast · dual lane",
    description: "V40-L · best speed when both codes fit",
    version: 40,
    fps: 120,
    lanes: 2,
    ecc: "L" as const,
    repairPercent: 40,
    repairPoolPercent: 80,
    renderScale: 1,
    fallbackRenderScale: 5,
  }),
};

export type TransferPresetKey = keyof typeof TRANSFER_PRESETS;
