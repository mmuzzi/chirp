"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decompressTransfer } from "@/lib/compression";
import {
  laneSignatureChanged,
  sampleLaneSignature,
  type LaneSignature,
} from "@/lib/lane-signature";
import type { DecodedQr, QrPosition } from "@/lib/qr-scanner";
import {
  createQrRectifier,
  mapQrPosition,
  warpPerspectiveQr,
} from "@/lib/qr-rectifier";
import {
  evaluateLaneDecoderHealth,
  type LaneDecoderHealth,
} from "@/lib/lane-decoder-health";
import {
  LaneDecoderPool,
  QrDecoder,
} from "@/lib/qr-scanner-worker-client";
import {
  crc32,
  formatBytes,
  formatRate,
  OpticalFileMeta,
  parseOpticalContainer,
  parseOpticalFrame,
  raptorPacketId,
} from "@/lib/optical-transfer";

type ScanState =
  | "idle"
  | "starting"
  | "scanning"
  | "receiving"
  | "complete"
  | "error";
type ScanMode = "single" | "dual";
type RateSample = { at: number; bytes: number };
type DecodeStrategy = "combined" | "lane-parallel" | "lane-fallback";
type RaptorDecoder = { push(payload: Uint8Array): Uint8Array | null };
type ReceiverSession = {
  session: number;
  containerLength: number;
  originalSize: number;
  compressed: boolean;
  symbolSize: number;
  sourcePacketCount: number;
  decoder: RaptorDecoder;
  seen: Set<number>;
};
type IncomingMeta = Omit<ReceiverSession, "decoder" | "seen">;
type VideoFrameMetadataLike = {
  presentedFrames?: number;
};
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadataLike) => void,
  ) => number;
};
type DeliverySample = { at: number; frames: number };
type ScanPerformanceSample = {
  at: number;
  totalMs: number;
  captureMs: number;
  decodeMs: number;
  acceptMs: number;
  decodedCount: number;
  strategy: DecodeStrategy;
};
type ScanCanvasContext = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};
type CameraSettings = {
  width: number;
  height: number;
  frameRate: number;
};
type ScanMetrics = {
  deliveredFps: number;
  scannerFps: number;
  decodedSymbolsPerScan: number;
  decodeP50: number;
  decodeP95: number;
  uniquePerSec: number;
  missesPerSec: number;
  callbackGapP95: number;
  geometryCoverage: number;
};

const ETA_RATE_WINDOW_MS = 90_000;
const ETA_RATE_MINIMUM_ELAPSED_MS = 12_000;
// Try the tracked lane path by default, but quarantine it automatically when
// measured handheld health is poor. The combined decoder is always the
// correctness fallback.
const ENABLE_TRACKED_LANE_DECODER = true;
// Keep the signature gate out of this experiment for now. It adds a crop read
// before decoding and can create false negatives; both lanes are probed until
// we have evidence that the decoder itself is reliable.
const ENABLE_LANE_SIGNATURE_GATE = false;
const LANE_GATE_WARMUP_FRAMES = 2;
const LANE_FULL_VERIFY_INTERVAL = 12;
const LANE_REPROBE_COOLDOWN_MS = 8_000;
const ROBUST_SCAN_INTERVAL_MS = 1_500;
type FramingStatus =
  | "searching"
  | "good"
  | "move-closer"
  | "move-back"
  | "square"
  | "center"
  | "low-light"
  | "glare";
type LightingQuality = "good" | "low-light" | "glare";
type LightingSnapshot = {
  quality: LightingQuality;
  average: number;
  contrast: number;
  darkFraction: number;
  clippedFraction: number;
};
type GeometrySnapshot = {
  quality: FramingStatus;
  symbolCount: number;
  coverage: number;
  edgeMargin: number;
  skew: number;
};
type LaneTrack = {
  position: QrPosition;
  lastSeenAt: number;
  misses: number;
};
type TrackedCrop = {
  image: ImageData;
  mapPosition: (position: QrPosition) => QrPosition;
  rectified: boolean;
};

let qrScannerPromise:
  | Promise<typeof import("@/lib/qr-scanner")>
  | undefined;

function loadQrScanner() {
  if (!qrScannerPromise) qrScannerPromise = import("@/lib/qr-scanner");
  return qrScannerPromise;
}

function prepareScanCanvasContext(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  existing?: ScanCanvasContext,
) {
  let context = existing?.canvas === canvas ? existing.context : undefined;
  if (!context || canvas.width < width || canvas.height < height) {
    canvas.width = Math.max(canvas.width, width);
    canvas.height = Math.max(canvas.height, height);
    context = canvas.getContext("2d", { willReadFrequently: true }) ?? undefined;
    if (context) {
      context.imageSmoothingEnabled = false;
      return { canvas, context } satisfies ScanCanvasContext;
    }
  }
  return context ? ({ canvas, context } satisfies ScanCanvasContext) : undefined;
}

function calculateRollingRate(
  samples: RateSample[],
  now: number,
  windowMs: number,
  minimumElapsedMs: number,
) {
  while (samples.length > 1 && now - samples[0].at > windowMs) samples.shift();
  if (
    samples.length === 0 ||
    now - samples[samples.length - 1].at > windowMs
  ) {
    samples.length = 0;
    return 0;
  }
  const elapsed = Math.max(minimumElapsedMs, now - samples[0].at);
  const total = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  return (total * 1000) / elapsed;
}

function updateRollingRate(
  samples: RateSample[],
  bytes: number,
  windowMs = 4000,
  minimumElapsedMs = 750,
) {
  const now = performance.now();
  samples.push({ at: now, bytes });
  return calculateRollingRate(samples, now, windowMs, minimumElapsedMs);
}

function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "calculating";
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;
  const minutes = seconds / 60;
  return `${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function pointDistance(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function qrBounds(position: QrPosition, width: number, height: number) {
  const points = [
    position.topLeft,
    position.topRight,
    position.bottomLeft,
    position.bottomRight,
  ];
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))));
  const right = Math.min(width, Math.ceil(Math.max(...points.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map((point) => point.y))));
  return { left, right, top, bottom };
}

function cropTrackedQr(
  context: CanvasRenderingContext2D,
  scanWidth: number,
  scanHeight: number,
  position: QrPosition,
) {
  const bounds = qrBounds(position, scanWidth, scanHeight);
  const qrWidth = Math.max(1, bounds.right - bounds.left);
  const qrHeight = Math.max(1, bounds.bottom - bounds.top);
  const margin = Math.ceil(Math.max(qrWidth, qrHeight) * 0.22);
  const left = Math.max(0, bounds.left - margin);
  const top = Math.max(0, bounds.top - margin);
  const right = Math.min(scanWidth, bounds.right + margin);
  const bottom = Math.min(scanHeight, bounds.bottom + margin);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  return {
    // Read only the tracked rectangle from the canvas. The previous path read
    // the entire panorama and then copied both lane rectangles row by row.
    image: context.getImageData(left, top, width, height),
    mapPosition: (position: QrPosition) =>
      translateQrPosition(position, left, top),
    rectified: false,
  } satisfies TrackedCrop;
}

function rectifyTrackedQr(
  context: CanvasRenderingContext2D,
  targetCanvas: HTMLCanvasElement,
  targetContext: CanvasRenderingContext2D,
  scanWidth: number,
  scanHeight: number,
  position: QrPosition,
): TrackedCrop | undefined {
  const rectifier = createQrRectifier(position, scanWidth, scanHeight);
  if (!rectifier) return undefined;
  if (
    targetCanvas.width !== rectifier.outputSize ||
    targetCanvas.height !== rectifier.outputSize
  ) {
    targetCanvas.width = rectifier.outputSize;
    targetCanvas.height = rectifier.outputSize;
  }
  if (rectifier.perspective) {
    const bounds = rectifier.sourceBounds;
    const source = context.getImageData(
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
    );
    const image = warpPerspectiveQr(
      source,
      rectifier,
      bounds.left,
      bounds.top,
    );
    targetContext.putImageData(image, 0, 0);
    return {
      image,
      mapPosition: (decodedPosition: QrPosition) =>
        mapQrPosition(decodedPosition, rectifier.rectifiedToSource),
      rectified: true,
    } satisfies TrackedCrop;
  }
  targetContext.setTransform(1, 0, 0, 1, 0, 0);
  // Keep the quiet-zone background opaque when a transformed draw does not
  // cover every destination pixel.
  targetContext.globalCompositeOperation = "source-over";
  targetContext.fillStyle = "#fff";
  targetContext.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  targetContext.imageSmoothingEnabled = false;
  const transform = rectifier.affineSourceToRectified;
  targetContext.setTransform(
    transform.a,
    transform.b,
    transform.c,
    transform.d,
    transform.e,
    transform.f,
  );
  targetContext.drawImage(context.canvas, 0, 0);
  return {
    image: targetContext.getImageData(0, 0, rectifier.outputSize, rectifier.outputSize),
    mapPosition: (decodedPosition: QrPosition) =>
      mapQrPosition(decodedPosition, rectifier.rectifiedToSource),
    rectified: true,
  } satisfies TrackedCrop;
}

function translateQrPosition(position: QrPosition, offsetX: number, offsetY: number): QrPosition {
  const translate = (point: { x: number; y: number }) => ({
    x: point.x + offsetX,
    y: point.y + offsetY,
  });
  return {
    topLeft: translate(position.topLeft),
    topRight: translate(position.topRight),
    bottomLeft: translate(position.bottomLeft),
    bottomRight: translate(position.bottomRight),
  };
}

function qrCenterX(position: QrPosition) {
  return (
    position.topLeft.x +
    position.topRight.x +
    position.bottomLeft.x +
    position.bottomRight.x
  ) / 4;
}

function inspectLighting(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  const sampleWidth = 32;
  const sampleHeight = 18;
  context.canvas.width = sampleWidth;
  context.canvas.height = sampleHeight;
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sampleWidth,
    sampleHeight,
  );
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const luminance: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    luminance.push(
      0.2126 * pixels[index] +
        0.7152 * pixels[index + 1] +
        0.0722 * pixels[index + 2],
    );
  }
  const sorted = [...luminance].sort((left, right) => left - right);
  const percentileValue = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  const average = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
  const p10 = percentileValue(0.1);
  const p90 = percentileValue(0.9);
  const darkFraction = luminance.filter((value) => value < 35).length / luminance.length;
  const clippedFraction = luminance.filter((value) => value > 250).length / luminance.length;
  const contrast = p90 - p10;
  const quality: LightingQuality =
    average < 55 || p90 < 100 || contrast < 35
      ? "low-light"
      : average > 220 && p10 > 165
        ? "glare"
        : "good";
  return {
    quality,
    average,
    contrast,
    darkFraction,
    clippedFraction,
  } satisfies LightingSnapshot;
}

function inspectQrGeometry(
  positions: QrPosition[],
  width: number,
  height: number,
  dual: boolean,
): GeometrySnapshot {
  const expectedSymbols = dual ? 2 : 1;
  if (positions.length === 0 || width <= 0 || height <= 0) {
    return {
      quality: "searching",
      symbolCount: 0,
      coverage: 0,
      edgeMargin: 0,
      skew: 0,
    };
  }

  const measurements = positions.map((position) => {
    const points = [
      position.topLeft,
      position.topRight,
      position.bottomLeft,
      position.bottomRight,
    ];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.max(0, Math.min(...xs));
    const right = Math.min(width, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys));
    const bottom = Math.min(height, Math.max(...ys));
    const topEdge = pointDistance(position.topLeft, position.topRight);
    const bottomEdge = pointDistance(position.bottomLeft, position.bottomRight);
    const leftEdge = pointDistance(position.topLeft, position.bottomLeft);
    const rightEdge = pointDistance(position.topRight, position.bottomRight);
    const horizontal = Math.max(1, (topEdge + bottomEdge) / 2);
    const vertical = Math.max(1, (leftEdge + rightEdge) / 2);
    return {
      centerX: (left + right) / 2 / width,
      coverage: Math.min((right - left) / width, (bottom - top) / height),
      edgeMargin: Math.min(left, width - right, top, height - bottom) /
        Math.min(width, height),
      skew: Math.max(
        Math.abs(topEdge - bottomEdge) / horizontal,
        Math.abs(leftEdge - rightEdge) / vertical,
      ),
    };
  });

  const minimumCoverage = Math.min(...measurements.map((measurement) => measurement.coverage));
  const minimumEdgeMargin = Math.min(...measurements.map((measurement) => measurement.edgeMargin));
  const maximumSkew = Math.max(...measurements.map((measurement) => measurement.skew));
  let quality: FramingStatus = "good";
  if (measurements.length < expectedSymbols) {
    quality = dual ? "center" : "move-closer";
  } else if (minimumCoverage < (dual ? 0.18 : 0.24)) {
    quality = "move-closer";
  } else if (minimumEdgeMargin < 0.018) {
    quality = "move-back";
  } else if (maximumSkew > 0.18) {
    quality = "square";
  } else if (
    dual &&
    measurements.length >= 2 &&
    (Math.min(...measurements.map((measurement) => measurement.centerX)) > 0.62 ||
      Math.max(...measurements.map((measurement) => measurement.centerX)) < 0.38)
  ) {
    quality = "center";
  }

  return {
    quality,
    symbolCount: measurements.length,
    coverage: minimumCoverage,
    edgeMargin: minimumEdgeMargin,
    skew: maximumSkew,
  };
}

function framingMessage(status: FramingStatus, mode: ScanMode) {
  if (status === "good") {
    return mode === "dual"
      ? "GOOD · both lanes visible · hold steady"
      : "GOOD · hold steady";
  }
  if (status === "move-closer") {
    return "MOVE CLOSER · fill the guide without cropping";
  }
  if (status === "move-back") return "MOVE BACK · keep every corner visible";
  if (status === "square") return "TILT LESS · square to the screen";
  if (status === "center") {
    return mode === "dual"
      ? "CENTER · keep both lanes visible"
      : "CENTER · keep the QR visible";
  }
  if (status === "low-light") return "LOW LIGHT · add light or tap torch";
  if (status === "glare") return "GLARE · tilt slightly or dim the light";
  return mode === "dual"
    ? "SEARCHING · fit both complete QRs"
    : "SEARCHING · fit the complete QR";
}

export function ScannerClient() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanCanvasContextRef = useRef<ScanCanvasContext | undefined>(undefined);
  const lightingCanvasRef = useRef<HTMLCanvasElement | undefined>(undefined);
  const lightingContextRef = useRef<CanvasRenderingContext2D | undefined>(undefined);
  const rectifierCanvasRefs = useRef<Array<HTMLCanvasElement | undefined>>([]);
  const rectifierContextRefs = useRef<Array<CanvasRenderingContext2D | undefined>>([]);
  const scanModeRef = useRef<ScanMode>("dual");
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const decoderRef = useRef<QrDecoder | undefined>(undefined);
  const laneDecoderPoolRef = useRef<LaneDecoderPool | undefined>(undefined);
  const laneDecoderDisabledRef = useRef(false);
  const laneDecoderRetryAtRef = useRef(0);
  const laneDecoderRetryCountRef = useRef(0);
  const laneDecoderHealthRef = useRef<LaneDecoderHealth | undefined>(undefined);
  const receiverRef = useRef<ReceiverSession | undefined>(undefined);
  const scanningRef = useRef(false);
  const cameraGenerationRef = useRef(0);
  const scanInFlightRef = useRef(false);
  const busyFrameDropsRef = useRef(0);
  const completingRef = useRef(false);
  const downloadUrlRef = useRef("");
  const cameraSettingsRef = useRef<CameraSettings | undefined>(undefined);
  const scanStartedAtRef = useRef(0);
  const scanAttemptRef = useRef(0);
  const lastRobustScanAtRef = useRef(0);
  const lastRobustAttemptRef = useRef(false);
  const laneTracksRef = useRef<Array<LaneTrack | undefined>>([]);
  const laneSignaturesRef = useRef<Array<LaneSignature | undefined>>([]);
  const laneDecodeAttemptsRef = useRef([0, 0]);
  const laneDecodeSuccessesRef = useRef([0, 0]);
  const laneHealthAttemptsRef = useRef([0, 0]);
  const laneHealthSuccessesRef = useRef([0, 0]);
  const laneHealthFallbacksRef = useRef(0);
  const laneUnchangedSkipsRef = useRef([0, 0]);
  const laneFallbacksRef = useRef(0);
  const laneStableFramesRef = useRef(0);
  const rectifiedCropsRef = useRef(0);
  const scanAspectRef = useRef(0);
  const lastQrAtRef = useRef(0);
  const lastLightingSampleRef = useRef(0);
  const lightingRef = useRef<LightingSnapshot>({
    quality: "good",
    average: 0,
    contrast: 0,
    darkFraction: 0,
    clippedFraction: 0,
  });
  const qrReadsRef = useRef(0);
  const acceptedFramesRef = useRef(0);
  const acceptedBytesRef = useRef(0);
  const firstAcceptedAtRef = useRef(0);
  const instantRateRef = useRef(0);
  const rollingRateRef = useRef(0);
  const cumulativeRateRef = useRef(0);
  const duplicateReadsRef = useRef(0);
  const missedExposuresRef = useRef(0);
  const decodeFailuresRef = useRef(0);
  const robustScansRef = useRef(0);
  const instantRateSamplesRef = useRef<RateSample[]>([]);
  const rateSamplesRef = useRef<RateSample[]>([]);
  const deliverySamplesRef = useRef<DeliverySample[]>([]);
  const scanPerformanceRef = useRef<ScanPerformanceSample[]>([]);
  const geometryRef = useRef<GeometrySnapshot>({
    quality: "searching",
    symbolCount: 0,
    coverage: 0,
    edgeMargin: 0,
    skew: 0,
  });
  const lastPresentedFramesRef = useRef(0);
  const lastMetricsUpdateRef = useRef(0);
  const lastReceiverUiUpdateRef = useRef(0);
  const lastQualityCountsRef = useRef({
    at: 0,
    uniqueFrames: 0,
    missedExposures: 0,
  });
  const framingStatusRef = useRef<FramingStatus>("searching");
  const receiverFullscreenRef = useRef(false);
  const [state, setState] = useState<ScanState>("idle");
  const [scanMode, setScanMode] = useState<ScanMode>("dual");
  const [receiverFullscreen, setReceiverFullscreen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [frames, setFrames] = useState(0);
  const [instantRate, setInstantRate] = useState(0);
  const [opticalRate, setOpticalRate] = useState(0);
  const [incoming, setIncoming] = useState<IncomingMeta>();
  const [fileMeta, setFileMeta] = useState<OpticalFileMeta>();
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const [guidance, setGuidance] = useState(
    "Center the complete QR inside the four corners.",
  );
  const [framingStatus, setFramingStatus] = useState<FramingStatus>("searching");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>();
  const [scanMetrics, setScanMetrics] = useState<ScanMetrics>({
    deliveredFps: 0,
    scannerFps: 0,
    decodedSymbolsPerScan: 0,
    decodeP50: 0,
    decodeP95: 0,
    uniquePerSec: 0,
    missesPerSec: 0,
    callbackGapP95: 0,
    geometryCoverage: 0,
  });

  const enterReceiverFullscreen = useCallback(async () => {
    if (scanModeRef.current === "single") {
      return;
    }
    const landscape = window.matchMedia("(orientation: landscape)");
    if (!landscape.matches) {
      const orientation = window.screen.orientation as (ScreenOrientation & {
        lock?: (orientation: "landscape") => Promise<void>;
      }) | undefined;
      if (orientation?.lock) {
        await orientation.lock("landscape").catch(() => undefined);
      }
    }
    if (!landscape.matches) {
      setGuidance(
        "Rotate the phone sideways for Fast dual; Safari cannot rotate it from the page.",
      );
      return;
    }
    receiverFullscreenRef.current = true;
    setReceiverFullscreen(true);
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) {
      return;
    }
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // iOS Safari may reject document fullscreen; the fixed layout remains
      // useful as a viewport-sized fallback.
    }
  }, []);

  const exitReceiverFullscreen = useCallback(async () => {
    const wasReceiverFullscreen = receiverFullscreenRef.current;
    receiverFullscreenRef.current = false;
    setReceiverFullscreen(false);
    if (wasReceiverFullscreen && document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => undefined);
    }
  }, []);

  const toggleReceiverFullscreen = useCallback(async () => {
    if (document.fullscreenElement || receiverFullscreenRef.current) {
      await exitReceiverFullscreen();
      return;
    }
    await enterReceiverFullscreen();
  }, [enterReceiverFullscreen, exitReceiverFullscreen]);

  const stopCamera = useCallback(() => {
    cameraGenerationRef.current += 1;
    scanningRef.current = false;
    scanInFlightRef.current = false;
    decoderRef.current?.terminate();
    decoderRef.current = undefined;
    laneDecoderPoolRef.current?.terminate();
    laneDecoderPoolRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    void exitReceiverFullscreen();
  }, [exitReceiverFullscreen]);

  const stopAndResetCamera = useCallback(() => {
    stopCamera();
    setState("idle");
    setGuidance("Camera stopped. Start again when ready.");
  }, [stopCamera]);

  const chooseScanMode = (nextMode: ScanMode) => {
    scanModeRef.current = nextMode;
    setScanMode(nextMode);
    framingStatusRef.current = "searching";
    setFramingStatus("searching");
    setGuidance(
      nextMode === "dual"
        ? "Fast dual: use landscape and fit both complete QRs inside the guide."
        : "Fallback single: center one complete QR inside the guide.",
    );
  };

  const finishTransfer = useCallback(
    async (container: Uint8Array, session: ReceiverSession) => {
      if (completingRef.current) return;
      completingRef.current = true;
      try {
        setGuidance(
          session.compressed
            ? "Optical transfer complete. Decompressing and verifying…"
            : "Optical transfer complete. Verifying the file…",
        );
        if (
          container.length !== session.containerLength ||
          crc32(container) !== session.session
        ) {
          throw new Error("The recovered RaptorQ object failed its checksum.");
        }
        const recovered = parseOpticalContainer(container);
        const bytes = await decompressTransfer(
          recovered.transmitted,
          recovered.meta.compression,
        );
        if (
          bytes.length !== recovered.meta.fileSize ||
          crc32(bytes) !== recovered.meta.fileCrc
        ) {
          throw new Error("The recovered file checksum did not match.");
        }

        const fileBytes = Uint8Array.from(bytes);
        const url = URL.createObjectURL(
          new Blob([fileBytes.buffer], { type: recovered.meta.mime }),
        );
        if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
        downloadUrlRef.current = url;
        setFileMeta(recovered.meta);
        setDownloadUrl(url);
        setProgress(1);
        setGuidance("File decompressed and checksum verified. It is safe to save.");
        setState("complete");
        stopCamera();
        navigator.vibrate?.([80, 40, 120]);
      } catch (cause) {
        setState("error");
        setError(
          cause instanceof Error ? cause.message : "File verification failed.",
        );
        stopCamera();
      } finally {
        completingRef.current = false;
      }
    },
    [stopCamera],
  );

  const acceptQrBytes = useCallback(
    async (decoded: DecodedQr) => {
      const readAt = performance.now();
      qrReadsRef.current += 1;
      lastQrAtRef.current = readAt;

      let frame;
      try {
        frame = parseOpticalFrame(decoded.bytes);
      } catch {
        const textPrefix = new TextDecoder().decode(decoded.bytes.subarray(0, 8));
        if (textPrefix.startsWith("QF2") || textPrefix.startsWith("QF3")) {
          setGuidance("An older sender is visible. Reload the sending screen.");
          return;
        }
        setGuidance("A frame was incomplete. Hold steady—the next one can replace it.");
        return;
      }

      let receiver = receiverRef.current;
      if (!receiver) {
        const { RaptorQWasmDecoder } = await import(
          "@raptorqr/core/fec/raptorq_wasm"
        );
        const decoder = await RaptorQWasmDecoder.create(
          frame.containerLength,
          frame.symbolSize,
        );
        receiver = {
          session: frame.session,
          containerLength: frame.containerLength,
          originalSize: frame.originalSize,
          compressed: frame.compressed,
          symbolSize: frame.symbolSize,
          sourcePacketCount: Math.max(
            1,
            Math.ceil(frame.containerLength / (frame.symbolSize - 4)),
          ),
          decoder,
          seen: new Set<number>(),
        };
        receiverRef.current = receiver;
        setIncoming({
          session: receiver.session,
          containerLength: receiver.containerLength,
          originalSize: receiver.originalSize,
          compressed: receiver.compressed,
          symbolSize: receiver.symbolSize,
          sourcePacketCount: receiver.sourcePacketCount,
        });
        setGuidance("RaptorQ locked. Keep the full white margin visible.");
        setState("receiving");
      }

      if (
        frame.session !== receiver.session ||
        frame.containerLength !== receiver.containerLength ||
        frame.symbolSize !== receiver.symbolSize
      ) {
        setGuidance("A different transfer crossed the camera view. Stay on one sender.");
        return;
      }

      const key = raptorPacketId(frame);
      if (receiver.seen.has(key)) {
        duplicateReadsRef.current += 1;
        return;
      }
      receiver.seen.add(key);
      acceptedFramesRef.current += 1;
      const accepted = acceptedFramesRef.current;
      const sourceBytes = Math.max(1, frame.symbolSize - 4);
      acceptedBytesRef.current += sourceBytes;
      if (firstAcceptedAtRef.current === 0) firstAcceptedAtRef.current = readAt;
      const instantRate = updateRollingRate(
        instantRateSamplesRef.current,
        sourceBytes,
        1500,
        500,
      );
      const rate = updateRollingRate(
        rateSamplesRef.current,
        sourceBytes,
        ETA_RATE_WINDOW_MS,
        ETA_RATE_MINIMUM_ELAPSED_MS,
      );
      const cumulativeElapsed = readAt - firstAcceptedAtRef.current;
      const cumulativeRate =
        cumulativeElapsed > 0
          ? (acceptedBytesRef.current * 1000) / cumulativeElapsed
          : rate;
      instantRateRef.current = instantRate;
      rollingRateRef.current = rate;
      cumulativeRateRef.current = cumulativeRate;
      const estimatedProgress = Math.min(
        0.99,
        accepted / (receiver.sourcePacketCount + 2),
      );
      const updateReceiverUi =
        accepted === 1 ||
        lastReceiverUiUpdateRef.current === 0 ||
        readAt - lastReceiverUiUpdateRef.current >= 200;
      if (updateReceiverUi) {
        lastReceiverUiUpdateRef.current = readAt;
        setFrames(accepted);
        setInstantRate(instantRate);
        setOpticalRate(rate);
        setProgress(estimatedProgress);
      }

      const recoveredContainer = receiver.decoder.push(frame.payload);
      if (recoveredContainer) await finishTransfer(recoveredContainer, receiver);
    },
    [finishTransfer],
  );

  const scanVideo = useCallback(
    function scanVideoFrame(
      metadata?: VideoFrameMetadataLike,
      scheduledGeneration = cameraGenerationRef.current,
    ) {
      if (
        !scanningRef.current ||
        scheduledGeneration !== cameraGenerationRef.current
      ) {
        return;
      }
      // Keep the camera callback continuous, like the Decimen receiver. The
      // decoder is deliberately bounded to one in-flight scan so the shared
      // canvas cannot be read while another scan is drawing. Frames offered
      // while it is busy are safe drops, not decode misses.
      const scheduleNextVideoFrame = () => {
        if (
          !scanningRef.current ||
          scheduledGeneration !== cameraGenerationRef.current
        ) {
          return;
        }
        const nextVideo = videoRef.current as VideoWithFrameCallback | null;
        if (nextVideo?.requestVideoFrameCallback) {
          nextVideo.requestVideoFrameCallback((_now, nextMetadata) =>
            scanVideoFrame(nextMetadata, scheduledGeneration),
          );
        } else {
          window.requestAnimationFrame(() =>
            scanVideoFrame(undefined, scheduledGeneration),
          );
        }
      };
      scheduleNextVideoFrame();
      if (scanInFlightRef.current) {
        busyFrameDropsRef.current += 1;
        return;
      }
      scanInFlightRef.current = true;
      const callbackAt = performance.now();
      const reportedFrames = metadata?.presentedFrames;
      const presentedFrames =
        typeof reportedFrames === "number" &&
        reportedFrames > lastPresentedFramesRef.current
          ? reportedFrames
          : lastPresentedFramesRef.current + 1;
      lastPresentedFramesRef.current = presentedFrames;
      const deliverySamples = deliverySamplesRef.current;
      deliverySamples.push({ at: callbackAt, frames: presentedFrames });
      while (
        deliverySamples.length > 2 &&
        callbackAt - deliverySamples[0].at > 3500
      ) {
        deliverySamples.shift();
      }

      let attempted = false;
      let captureMs = 0;
      let decodeMs = 0;
      let acceptMs = 0;
      let decodedCount = 0;
      let strategy: DecodeStrategy = "combined";
      const scanAttempt = scanAttemptRef.current++;
      const scanGeneration = scheduledGeneration;
      const runScan = async () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (
          !video ||
          !canvas ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.videoWidth === 0 ||
          video.videoHeight === 0
        ) {
          return;
        }

        const dualMode = scanModeRef.current === "dual";
        // The preview uses object-fit: cover. Match its live viewport crop in
        // the decoder instead of assuming the camera stream is always 2:1.
        // iOS can negotiate 1280x720 or 720x1280 depending on orientation,
        // and the fullscreen viewport can have a third aspect ratio.
        const previewRect = video.getBoundingClientRect();
        const previewAspect =
          dualMode && previewRect.width > 0 && previewRect.height > 0
            ? previewRect.width / previewRect.height
            : 1;
        const scanAspect = dualMode
          ? Number.isFinite(previewAspect) && previewAspect > 0
            ? previewAspect
            : 16 / 9
          : 1;
        if (
          dualMode &&
          (scanAspectRef.current === 0 ||
            Math.abs(scanAspectRef.current - scanAspect) > 0.04)
        ) {
          // Positions from a previous crop are no longer valid after an
          // orientation/fullscreen transition.
          laneTracksRef.current = [];
          laneSignaturesRef.current = [];
          laneStableFramesRef.current = 0;
          scanAspectRef.current = scanAspect;
        }
        const availableWidth = video.videoWidth * 0.96;
        const availableHeight = video.videoHeight * 0.96;
        const sourceWidth = Math.floor(
          dualMode
            ? Math.min(availableWidth, availableHeight * scanAspect)
            : Math.min(availableWidth, availableHeight),
        );
        const sourceHeight = dualMode
          ? Math.max(1, Math.floor(sourceWidth / scanAspect))
          : sourceWidth;
        const sourceX = Math.floor((video.videoWidth - sourceWidth) / 2);
        const sourceY = Math.floor((video.videoHeight - sourceHeight) / 2);
        const highDensity = (receiverRef.current?.symbolSize ?? 0) > 2200;
        // Keep recovery probes on a clock, not on the failure counter. A
        // failure-driven cadence can enter a self-reinforcing spiral: every
        // miss schedules more of the slower tryHarder/local-binarizer scans,
        // which lowers scanner FPS and creates more misses. One probe every
        // 1.5s is enough to reacquire after motion without starving normal
        // scans during a bad exposure window.
        const robustAttempt =
          callbackAt - lastRobustScanAtRef.current >= ROBUST_SCAN_INTERVAL_MS;
        if (robustAttempt) {
          lastRobustScanAtRef.current = callbackAt;
          robustScansRef.current += 1;
        }
        lastRobustAttemptRef.current = robustAttempt;

        // A bad probation window should not turn a useful optimization into a
        // permanent feature flag. Re-probe only after the combined decoder has
        // reacquired both lanes and held a clean lock for a short period. This
        // keeps a shaky camera on the correctness path while allowing a focus
        // or exposure change to make the crop path useful again later.
        const canReprobeLaneDecoder =
          dualMode &&
          laneDecoderDisabledRef.current &&
          callbackAt >= laneDecoderRetryAtRef.current &&
          !robustAttempt &&
          laneTracksRef.current.length === 2 &&
          laneTracksRef.current.every((track) => Boolean(track)) &&
          decodeFailuresRef.current === 0 &&
          lastQrAtRef.current > 0 &&
          callbackAt - lastQrAtRef.current < 1_800 &&
          lightingRef.current.quality === "good";
        if (canReprobeLaneDecoder) {
          laneDecoderDisabledRef.current = false;
          laneDecoderHealthRef.current = undefined;
          laneHealthAttemptsRef.current = [0, 0];
          laneHealthSuccessesRef.current = [0, 0];
          laneHealthFallbacksRef.current = 0;
          laneStableFramesRef.current = 0;
          laneDecoderRetryCountRef.current += 1;
        }
        const scanWidth = Math.min(
          dualMode
            ? highDensity
              ? robustAttempt
                ? sourceWidth
                : 1120
              : robustAttempt
                ? 1680
                : 1440
            : highDensity
              ? 1280
              : robustAttempt
                ? 1120
                : 960,
          sourceWidth,
        );
        const scanHeight = dualMode
          ? Math.max(1, Math.floor(scanWidth / scanAspect))
          : scanWidth;
        const captureStartedAt = performance.now();
        if (callbackAt - lastLightingSampleRef.current >= 1000) {
          if (!lightingCanvasRef.current) {
            lightingCanvasRef.current = document.createElement("canvas");
            lightingContextRef.current =
              lightingCanvasRef.current.getContext("2d", {
                willReadFrequently: true,
              }) ?? undefined;
          }
          const lightingContext = lightingContextRef.current;
          if (lightingContext) {
            lightingRef.current = inspectLighting(
              lightingContext,
              video,
              sourceX,
              sourceY,
              sourceWidth,
              sourceHeight,
            );
            lastLightingSampleRef.current = callbackAt;
          }
        }

        // Draw the panorama once. After a good full-frame lock, read back only
        // the two tracked rectangles; periodic full scans keep the tracks
        // honest when the phone moves.
        const canvasEntry = prepareScanCanvasContext(
          canvas,
          scanWidth,
          scanHeight,
          scanCanvasContextRef.current,
        );
        if (!canvasEntry) return;
        scanCanvasContextRef.current = canvasEntry;
        canvasEntry.context.drawImage(
          video,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          scanWidth,
          scanHeight,
        );
        const tracks = laneTracksRef.current;
        const trackedDual =
          ENABLE_TRACKED_LANE_DECODER &&
          !laneDecoderDisabledRef.current &&
          dualMode &&
          !robustAttempt &&
          scanAttempt % LANE_FULL_VERIFY_INTERVAL !== 0 &&
          tracks.length === 2 &&
          tracks.every((track) => Boolean(track));
        if (!trackedDual) laneStableFramesRef.current = 0;
        const rectifierTargets = trackedDual
          ? tracks.map((_, laneIndex) => {
              let targetCanvas = rectifierCanvasRefs.current[laneIndex];
              let targetContext = rectifierContextRefs.current[laneIndex];
              if (!targetCanvas || !targetContext) {
                targetCanvas = document.createElement("canvas");
                targetContext = targetCanvas.getContext("2d", {
                  willReadFrequently: true,
                }) ?? undefined;
                rectifierCanvasRefs.current[laneIndex] = targetCanvas;
                rectifierContextRefs.current[laneIndex] = targetContext;
              }
              return targetCanvas && targetContext
                ? { canvas: targetCanvas, context: targetContext }
                : undefined;
            })
          : undefined;
        const trackedCrops = trackedDual
          ? tracks.map((track, laneIndex) => {
              if (!track) return undefined;
              const rectifierTarget = rectifierTargets?.[laneIndex];
              const rectified =
                rectifierTarget
                  ? rectifyTrackedQr(
                      canvasEntry.context,
                      rectifierTarget.canvas,
                      rectifierTarget.context,
                      scanWidth,
                      scanHeight,
                      track.position,
                    )
                  : undefined;
              if (rectified) {
                rectifiedCropsRef.current += 1;
                return rectified;
              }
              return cropTrackedQr(
                canvasEntry.context,
                scanWidth,
                scanHeight,
                track.position,
              );
            })
          : undefined;
        const laneChanged = trackedDual
          ? ENABLE_LANE_SIGNATURE_GATE
            ? trackedCrops?.map((crop, laneIndex) => {
              if (!crop) return true;
              const signature = sampleLaneSignature(crop.image);
              const changed = laneSignatureChanged(
                laneSignaturesRef.current[laneIndex],
                signature,
              );
              laneSignaturesRef.current[laneIndex] = signature;
              return changed;
            })
            : undefined
          : undefined;
        if (!trackedDual) laneSignaturesRef.current = [];
        let image = trackedDual
          ? undefined
          : canvasEntry.context.getImageData(0, 0, scanWidth, scanHeight);
        const fullImage = () => {
          image ??= canvasEntry.context.getImageData(
            0,
            0,
            scanWidth,
            scanHeight,
          );
          return image;
        };
        captureMs = performance.now() - captureStartedAt;

        attempted = true;
        const decodeStartedAt = performance.now();
        let decodedFrames: DecodedQr[] = [];
        try {
          const decodeCombined = async () => {
            const imageToDecode = fullImage();
            const maxNumberOfSymbols = dualMode ? 2 : 1;
            const decoder = decoderRef.current;
            if (decoder) {
              try {
                return await decoder.decode(
                  imageToDecode,
                  robustAttempt,
                  maxNumberOfSymbols,
                );
              } catch {
                // A worker can become unavailable after a browser suspension.
                // Quarantine that instance and use the original main-thread
                // scanner for the remainder of this run instead of losing the
                // transfer.
                decoder.terminate();
                decoderRef.current = undefined;
              }
            }
            const { scanRawQr, scanRawQrs } = await loadQrScanner();
            // postMessage transfers the worker image buffer. Re-read the
            // canvas for the compatibility fallback instead of reusing a
            // potentially detached ImageData after a worker failure.
            const fallbackImage = canvasEntry.context.getImageData(
              0,
              0,
              scanWidth,
              scanHeight,
            );
            if (dualMode) {
              return scanRawQrs(fallbackImage, robustAttempt, 2);
            }
            const decoded = await scanRawQr(fallbackImage, robustAttempt);
            return decoded ? [decoded] : [];
          };

          if (trackedDual) {
            strategy = "lane-parallel";
            if (!laneDecoderPoolRef.current) {
              try {
                laneDecoderPoolRef.current = new LaneDecoderPool(2);
              } catch {
                laneDecoderPoolRef.current = undefined;
                laneDecoderDisabledRef.current = true;
                laneDecoderRetryAtRef.current =
                  callbackAt + LANE_REPROBE_COOLDOWN_MS;
              }
            }
            const pool = laneDecoderPoolRef.current;
            if (!pool) {
              strategy = "combined";
              decodedFrames = await decodeCombined();
            } else {
              const gateReady =
                ENABLE_LANE_SIGNATURE_GATE &&
                laneStableFramesRef.current >= LANE_GATE_WARMUP_FRAMES &&
                laneChanged?.length === 2;
              const decodeLaneIndexes = gateReady
                ? laneChanged
                    .map((changed, laneIndex) => (changed ? laneIndex : -1))
                    .filter((laneIndex) => laneIndex >= 0)
                : [0, 1];
              for (let laneIndex = 0; laneIndex < tracks.length; laneIndex += 1) {
                if (!decodeLaneIndexes.includes(laneIndex)) {
                  laneUnchangedSkipsRef.current[laneIndex] += 1;
                }
              }
              let trackedResults:
                | Array<{ laneIndex: number; decoded: DecodedQr | null }>
                | undefined;
              try {
                trackedResults = await Promise.all(
                  decodeLaneIndexes.map(async (laneIndex) => {
                    const track = tracks[laneIndex];
                    const crop = trackedCrops?.[laneIndex];
                    if (!track || !crop) return { laneIndex, decoded: null };
                    laneDecodeAttemptsRef.current[laneIndex] += 1;
                    laneHealthAttemptsRef.current[laneIndex] += 1;
                    const decoded = await pool.decode(
                      laneIndex,
                      crop.image,
                      false,
                    );
                    if (decoded) {
                      laneDecodeSuccessesRef.current[laneIndex] += 1;
                      laneHealthSuccessesRef.current[laneIndex] += 1;
                    }
                    return {
                      laneIndex,
                      decoded: decoded
                        ? {
                            ...decoded,
                            position: crop.mapPosition(decoded.position),
                          }
                        : null,
                    };
                  }),
                );
              } catch {
                // Treat a failed lane worker like an unhealthy probe, then
                // preserve correctness with the combined decoder.
                pool.terminate();
                laneDecoderPoolRef.current = undefined;
                laneDecoderDisabledRef.current = true;
                laneDecoderRetryAtRef.current =
                  callbackAt + LANE_REPROBE_COOLDOWN_MS;
                laneDecoderHealthRef.current = {
                  ready: true,
                  quarantine: true,
                  minAttempts: Math.min(
                    laneDecodeAttemptsRef.current[0],
                    laneDecodeAttemptsRef.current[1],
                  ),
                  weakestLaneSuccessRate: 0,
                  fallbackRate: 1,
                  reason: "low-success",
                };
                decodedFrames = await decodeCombined();
                trackedResults = [];
              }
              if (trackedResults) {
                const decodedByLane: Array<DecodedQr | null> = [null, null];
                for (const result of trackedResults) {
                  decodedByLane[result.laneIndex] = result.decoded;
                }
                decodedFrames = decodedByLane.filter(
                  (decoded): decoded is DecodedQr => Boolean(decoded),
                );
                laneTracksRef.current = tracks.map((track, laneIndex) => {
                  if (!decodeLaneIndexes.includes(laneIndex)) return track;
                  const decoded = decodedByLane[laneIndex];
                  return decoded
                    ? {
                        position: decoded.position,
                        lastSeenAt: callbackAt,
                        misses: 0,
                      }
                    : track
                      ? { ...track, misses: track.misses + 1 }
                      : undefined;
                });
                const needsFullFallback =
                  decodeLaneIndexes.some((laneIndex) => !decodedByLane[laneIndex]) ||
                  laneTracksRef.current.some(
                    (track) => (track?.misses ?? 0) >= 2,
                  );
                if (needsFullFallback) {
                  strategy = "lane-fallback";
                  laneFallbacksRef.current += 1;
                  laneHealthFallbacksRef.current += 1;
                  decodedFrames = await decodeCombined();
                }
                const health = evaluateLaneDecoderHealth(
                  laneHealthAttemptsRef.current as [number, number],
                  laneHealthSuccessesRef.current as [number, number],
                  laneHealthFallbacksRef.current,
                );
                laneDecoderHealthRef.current = health;
                if (health.quarantine) {
                  laneDecoderDisabledRef.current = true;
                  laneDecoderRetryAtRef.current =
                    callbackAt + LANE_REPROBE_COOLDOWN_MS;
                  laneDecoderPoolRef.current?.terminate();
                  laneDecoderPoolRef.current = undefined;
                } else if (health.ready) {
                  // Evaluate independent batches so a later shake or focus
                  // change can quarantine the path even after an initially
                  // healthy probe window.
                  laneHealthAttemptsRef.current = [0, 0];
                  laneHealthSuccessesRef.current = [0, 0];
                  laneHealthFallbacksRef.current = 0;
                }
              }
            }
          } else {
            decodedFrames = await decodeCombined();
          }
        } finally {
          decodeMs = performance.now() - decodeStartedAt;
        }
        if (
          !scanningRef.current ||
          scanGeneration !== cameraGenerationRef.current
        ) {
          return;
        }
        decodedCount = decodedFrames.length;

        if (decodedFrames.length === 0) {
          if (dualMode) {
            laneTracksRef.current = laneTracksRef.current.map((track) =>
              track ? { ...track, misses: track.misses + 1 } : track,
            );
          }
          geometryRef.current = {
            quality: "searching",
            symbolCount: 0,
            coverage: 0,
            edgeMargin: 0,
            skew: 0,
          };
          decodeFailuresRef.current += 1;
          missedExposuresRef.current += 1;
          return;
        }
        if (dualMode && strategy !== "lane-parallel") {
          const sorted = [...decodedFrames].sort(
            (left, right) => qrCenterX(left.position) - qrCenterX(right.position),
          );
          laneTracksRef.current = sorted.slice(0, 2).map((decoded) => ({
            position: decoded.position,
            lastSeenAt: callbackAt,
            misses: 0,
          }));
        }
        if (dualMode) {
          laneStableFramesRef.current =
            decodedFrames.length >= 2
              ? Math.min(LANE_GATE_WARMUP_FRAMES + 1, laneStableFramesRef.current + 1)
              : 0;
        }
        const geometryPositions =
          dualMode && strategy === "lane-parallel"
            ? laneTracksRef.current
                .filter((track): track is LaneTrack => Boolean(track))
                .map((track) => track.position)
            : decodedFrames.map((decoded) => decoded.position);
        geometryRef.current = inspectQrGeometry(
          geometryPositions,
          scanWidth,
          scanHeight,
          dualMode,
        );
        decodeFailuresRef.current = 0;
        const acceptStartedAt = performance.now();
        for (const decoded of decodedFrames) {
          await acceptQrBytes(decoded);
        }
        acceptMs = performance.now() - acceptStartedAt;
      };

      void runScan()
        .catch(() => {
          decodeFailuresRef.current += 1;
          missedExposuresRef.current += 1;
        })
        .finally(() => {
          scanInFlightRef.current = false;
          if (!scanningRef.current) return;
          const finishedAt = performance.now();
          if (attempted) {
            const performanceSamples = scanPerformanceRef.current;
            performanceSamples.push({
              at: finishedAt,
              totalMs: finishedAt - callbackAt,
              captureMs,
              decodeMs,
              acceptMs,
              decodedCount,
              strategy,
            });
            while (
              performanceSamples.length > 2 &&
              finishedAt - performanceSamples[0].at > 3500
            ) {
              performanceSamples.shift();
            }

            if (finishedAt - lastMetricsUpdateRef.current >= 500) {
              const firstDelivery = deliverySamples[0];
              const lastDelivery =
                deliverySamples[deliverySamples.length - 1];
              const deliveryElapsed =
                lastDelivery && firstDelivery
                  ? lastDelivery.at - firstDelivery.at
                  : 0;
              const deliveredFps =
                deliveryElapsed > 0
                  ? ((lastDelivery.frames - firstDelivery.frames) * 1000) /
                    deliveryElapsed
                  : 0;
              const firstScan = performanceSamples[0];
              const lastScan =
                performanceSamples[performanceSamples.length - 1];
              const scanElapsed =
                lastScan && firstScan ? lastScan.at - firstScan.at : 0;
              const scannerFps =
                scanElapsed > 0
                  ? ((performanceSamples.length - 1) * 1000) / scanElapsed
                  : 0;
              const decodeValues = performanceSamples.map(
                (sample) => sample.decodeMs,
              );
              const decodedValues = performanceSamples.map(
                (sample) => sample.decodedCount,
              );
              const decodedSymbolsPerScan =
                decodedValues.reduce((sum, value) => sum + value, 0) /
                Math.max(1, decodedValues.length);
              const callbackGaps = deliverySamples
                .slice(1)
                .map(
                  (sample, index) => sample.at - deliverySamples[index].at,
                );
              const refreshedInstantRate = calculateRollingRate(
                instantRateSamplesRef.current,
                finishedAt,
                1500,
                500,
              );
              const refreshedRollingRate = calculateRollingRate(
                rateSamplesRef.current,
                finishedAt,
                ETA_RATE_WINDOW_MS,
                ETA_RATE_MINIMUM_ELAPSED_MS,
              );
              instantRateRef.current = refreshedInstantRate;
              rollingRateRef.current = refreshedRollingRate;
              const qualityCounts = lastQualityCountsRef.current;
              const qualityElapsed = Math.max(
                1,
                finishedAt - (qualityCounts.at || finishedAt - 500),
              );
              const qualityPerSecond = (current: number, previous: number) =>
                ((current - previous) * 1000) / qualityElapsed;
              const uniquePerSec = Math.max(
                0,
                qualityPerSecond(
                  acceptedFramesRef.current,
                  qualityCounts.uniqueFrames,
                ),
              );
              const missesPerSec = Math.max(
                0,
                qualityPerSecond(
                  missedExposuresRef.current,
                  qualityCounts.missedExposures,
                ),
              );
              setScanMetrics({
                deliveredFps,
                scannerFps,
                decodedSymbolsPerScan,
                decodeP50: percentile(decodeValues, 0.5),
                decodeP95: percentile(decodeValues, 0.95),
                uniquePerSec,
                missesPerSec,
                callbackGapP95: percentile(callbackGaps, 0.95),
                geometryCoverage: geometryRef.current.coverage,
              });
              setInstantRate(refreshedInstantRate);
              setOpticalRate(refreshedRollingRate);

              const geometry = geometryRef.current;
              const lighting = lightingRef.current;
              let nextFramingStatus: FramingStatus = "good";
              if (lighting.quality !== "good") {
                nextFramingStatus = lighting.quality;
              } else if (geometry.quality !== "searching") {
                nextFramingStatus = geometry.quality;
              } else if (
                acceptedFramesRef.current === 0 ||
                finishedAt - lastQrAtRef.current > 2500
              ) {
                nextFramingStatus = "searching";
              } else if (
                percentile(decodeValues, 0.95) > 24 ||
                (deliveredFps > 0 && scannerFps < deliveredFps * 0.82)
              ) {
                nextFramingStatus = "square";
              }
              if (nextFramingStatus !== framingStatusRef.current) {
                framingStatusRef.current = nextFramingStatus;
                setFramingStatus(nextFramingStatus);
                setGuidance(
                  framingMessage(nextFramingStatus, scanModeRef.current),
                );
              }
              lastQualityCountsRef.current = {
                at: finishedAt,
                uniqueFrames: acceptedFramesRef.current,
                missedExposures: missedExposuresRef.current,
              };
              lastMetricsUpdateRef.current = finishedAt;
            }
          }

        });
    },
    [acceptQrBytes],
  );

  const startCamera = useCallback(async () => {
    // This runs directly from the Start button while the user gesture is
    // still available. If iOS declines native fullscreen, CSS below still
    // expands the receiver to the landscape viewport.
    void enterReceiverFullscreen();
    cameraGenerationRef.current += 1;
    setError("");
    setGuidance(
      scanModeRef.current === "dual"
        ? "Fast dual: use landscape and fit both complete QRs inside the guide."
        : "Fallback single: center one complete QR inside the guide.",
    );
    setState("starting");
    receiverRef.current = undefined;
    laneTracksRef.current = [];
    laneSignaturesRef.current = [];
    laneDecodeAttemptsRef.current = [0, 0];
    laneDecodeSuccessesRef.current = [0, 0];
    laneHealthAttemptsRef.current = [0, 0];
    laneHealthSuccessesRef.current = [0, 0];
    laneHealthFallbacksRef.current = 0;
    laneUnchangedSkipsRef.current = [0, 0];
    laneFallbacksRef.current = 0;
    laneStableFramesRef.current = 0;
    laneDecoderDisabledRef.current = false;
    laneDecoderRetryAtRef.current = 0;
    laneDecoderRetryCountRef.current = 0;
    laneDecoderHealthRef.current = undefined;
    rectifiedCropsRef.current = 0;
    scanAttemptRef.current = 0;
    lastRobustScanAtRef.current = performance.now();
    lastRobustAttemptRef.current = false;
    scanInFlightRef.current = false;
    busyFrameDropsRef.current = 0;
    completingRef.current = false;
    cameraSettingsRef.current = undefined;
    qrReadsRef.current = 0;
    acceptedFramesRef.current = 0;
    acceptedBytesRef.current = 0;
    firstAcceptedAtRef.current = 0;
    instantRateRef.current = 0;
    rollingRateRef.current = 0;
    cumulativeRateRef.current = 0;
    duplicateReadsRef.current = 0;
    missedExposuresRef.current = 0;
    decodeFailuresRef.current = 0;
    robustScansRef.current = 0;
    instantRateSamplesRef.current = [];
    rateSamplesRef.current = [];
    deliverySamplesRef.current = [];
    scanPerformanceRef.current = [];
    geometryRef.current = {
      quality: "searching",
      symbolCount: 0,
      coverage: 0,
      edgeMargin: 0,
      skew: 0,
    };
    lastPresentedFramesRef.current = 0;
    lastMetricsUpdateRef.current = 0;
    lastReceiverUiUpdateRef.current = 0;
    lastQualityCountsRef.current = {
      at: 0,
      uniqueFrames: 0,
      missedExposures: 0,
    };
    framingStatusRef.current = "searching";
    lastQrAtRef.current = 0;
    lastLightingSampleRef.current = 0;
    lightingRef.current = {
      quality: "good",
      average: 0,
      contrast: 0,
      darkFraction: 0,
      clippedFraction: 0,
    };
    scanStartedAtRef.current = performance.now();
    scanAspectRef.current = 0;
    decoderRef.current?.terminate();
    decoderRef.current = undefined;
    laneDecoderPoolRef.current?.terminate();
    laneDecoderPoolRef.current = undefined;
    setIncoming(undefined);
    setFileMeta(undefined);
    setProgress(0);
    setFrames(0);
    setInstantRate(0);
    setOpticalRate(0);
    setFramingStatus("searching");
    setTorchOn(false);
    setCameraSettings(undefined);
    setScanMetrics({
      deliveredFps: 0,
      scannerFps: 0,
      decodedSymbolsPerScan: 0,
      decodeP50: 0,
      decodeP95: 0,
      uniquePerSec: 0,
      missesPerSec: 0,
      callbackGapP95: 0,
      geometryCoverage: 0,
    });
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
      setDownloadUrl("");
    }

    try {
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        throw new Error("CAMERA_CONTEXT_UNAVAILABLE");
      }
      try {
        decoderRef.current = new QrDecoder();
      } catch {
        // Older browsers can lack module-worker support. The first QR scan
        // falls back to the existing main-thread ZXing implementation.
        decoderRef.current = undefined;
      }
      const videoBase = {
        facingMode: { ideal: "environment" },
        // 720p leaves enough pixels for V40 QR modules while giving iPhone
        // Safari a better chance of sustaining its highest camera cadence.
        width: { ideal: 1280, min: 640, max: 1920 },
        height: { ideal: 720, min: 360, max: 1080 },
      } satisfies MediaTrackConstraints;
      let stream: MediaStream;
      try {
        // Ask for the real high-speed camera mode first. Safari commonly
        // rejects this on iPhone, so the fallback below still keeps the
        // receiver usable when the hardware/browser only exposes 60 fps.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...videoBase,
            frameRate: { exact: 120 },
          },
        });
      } catch (cause) {
        const name = cause instanceof DOMException ? cause.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          throw cause;
        }
        // WebKit has returned several different errors for an unsupported
        // exact frame-rate request. Any non-permission failure here should
        // get one normal camera request before we give up.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...videoBase,
            frameRate: { ideal: 120, min: 24, max: 120 },
          },
        });
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      await track
        .applyConstraints({ frameRate: { ideal: 120, max: 120 } })
        .catch(() => undefined);
      const settings = track.getSettings();
      console.info("[QRFerry camera settings]", {
        width: settings.width ?? 0,
        height: settings.height ?? 0,
        frameRate: settings.frameRate ?? 0,
      });
      const negotiatedCameraSettings = {
        width: settings.width ?? 0,
        height: settings.height ?? 0,
        frameRate: settings.frameRate ?? 0,
      };
      cameraSettingsRef.current = negotiatedCameraSettings;
      setCameraSettings(negotiatedCameraSettings);
      const negotiatedFrameRate = settings.frameRate ?? 0;
      setGuidance(
        negotiatedFrameRate >= 119
            ? "120 fps camera mode is active. Keep both codes inside the guide."
            : negotiatedFrameRate > 0
            ? `Requested 120 fps; this browser negotiated ${negotiatedFrameRate.toFixed(0)} fps. Keep steady and use Fast dual.`
            : "Requested the camera's highest frame rate. Keep both codes inside the guide.",
      );
      const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & {
        focusMode?: string[];
        torch?: boolean;
      };
      setTorchAvailable(Boolean(capabilities?.torch));
      if (capabilities?.focusMode?.includes("continuous")) {
        await track
          .applyConstraints({
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          })
          .catch(() => undefined);
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      scanningRef.current = true;
      setState("scanning");
      const video = videoRef.current as VideoWithFrameCallback | null;
      if (video?.requestVideoFrameCallback) {
        video.requestVideoFrameCallback((_now, metadata) =>
          scanVideo(metadata),
        );
      } else {
        window.requestAnimationFrame(() => scanVideo());
      }
    } catch (cause) {
      stopCamera();
      setState("error");
      const name = cause instanceof DOMException ? cause.name : "";
      const message = cause instanceof Error ? cause.message : "";
      setError(
        message === "CAMERA_CONTEXT_UNAVAILABLE"
          ? "This browser did not expose camera access. Open this link directly in Safari, allow Camera, and try again."
          : name === "NotAllowedError"
            ? "Camera access was denied. In iPhone Settings → Safari → Camera, allow this site, then reload this page."
            : name === "NotReadableError"
              ? "The camera is busy or unavailable. Close Camera and other scanning apps, then try again."
              : name === "NotFoundError"
                ? "No usable camera was found. Use the rear camera and try again."
                : name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError"
                  ? "This browser could not satisfy the camera request. The receiver will work at a lower rate in Safari; try again there."
                  : "The receiver camera could not be started. Open this HTTPS link directly in Safari or another browser with camera access.",
      );
    }
  }, [enterReceiverFullscreen, scanVideo, stopCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  };

  useEffect(() => {
    const orientation = window.matchMedia("(orientation: landscape)");
    const syncLandscapeReceiver = () => {
      if (
        !scanningRef.current ||
        scanModeRef.current !== "dual"
      ) {
        return;
      }
      if (orientation.matches) {
        receiverFullscreenRef.current = true;
        setReceiverFullscreen(true);
        return;
      }
      receiverFullscreenRef.current = false;
      setReceiverFullscreen(false);
      if (document.fullscreenElement) {
        void document.exitFullscreen?.();
      }
    };
    orientation.addEventListener?.("change", syncLandscapeReceiver);
    window.addEventListener("orientationchange", syncLandscapeReceiver);
    return () => {
      orientation.removeEventListener?.("change", syncLandscapeReceiver);
      window.removeEventListener("orientationchange", syncLandscapeReceiver);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!scanningRef.current || acceptedFramesRef.current > 0) return;
      const now = performance.now();
      if (lastQrAtRef.current > 0 && now - lastQrAtRef.current < 3000) return;
      const elapsed = now - scanStartedAtRef.current;
      if (elapsed > 8000) {
        if (framingStatusRef.current !== "move-closer") {
          framingStatusRef.current = "move-closer";
          setFramingStatus("move-closer");
        }
        setGuidance(
          scanModeRef.current === "dual"
            ? "No lane decoded. Confirm Fast dual on both devices, use landscape, and move closer."
            : "No frame decoded. Use Fallback single, move closer, and keep the white margin visible.",
        );
      } else if (elapsed > 4000) {
        if (framingStatusRef.current !== "center") {
          framingStatusRef.current = "center";
          setFramingStatus("center");
        }
        setGuidance(
          scanModeRef.current === "dual"
            ? "Still looking. Keep both white margins visible and hold the receiver steady."
            : "Still looking. Move closer until the single QR nearly fills the guide.",
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    };
  }, [stopCamera]);

  const complete = state === "complete";
  const active =
    state === "scanning" || state === "receiving" || state === "starting";
  const compressionRatio =
    incoming && incoming.containerLength > 0
      ? incoming.originalSize / incoming.containerLength
      : 1;
  const etaRate =
    opticalRate > 0
      ? opticalRate
      : acceptedFramesRef.current >= 3
        ? 0
        : cumulativeRateRef.current;
  const effectiveRate = etaRate * compressionRatio;
  const instantFileRate = instantRate * compressionRatio;
  const recoveredBytes = incoming
    ? Math.min(
        incoming.containerLength,
        frames * Math.max(1, incoming.symbolSize - 4),
      )
    : 0;
  const etaSeconds =
    incoming && etaRate > 0
      ? (incoming.containerLength - recoveredBytes) / etaRate
      : Number.POSITIVE_INFINITY;
  const compressionPercent =
    incoming && incoming.originalSize > 0
      ? Math.max(
          0,
          Math.round(
            (1 - incoming.containerLength / incoming.originalSize) * 100,
          ),
        )
      : 0;
  const overlayFramingMessage = complete
    ? "Transfer verified"
    : framingMessage(framingStatus, scanMode);

  return (
    <main
      className={`scanner-page ${receiverFullscreen ? "receiver-fullscreen" : ""} ${active ? "receiver-active" : ""}`}
    >
      <section className="scanner-intro compact-scanner-intro">
        <h1>{complete ? "Recovered" : "Receive"}</h1>
      </section>

      <section className="scanner-shell">
        <div className={`camera-view ${scanMode} ${active ? "active" : ""} ${complete ? "complete" : ""}`}>
          <video ref={videoRef} playsInline muted aria-label="Receiver camera preview" />
          <canvas ref={canvasRef} hidden />
          <div className="scan-reticle" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
          {active || complete ? (
            <div className={`camera-overlay ${framingStatus}`} aria-live="polite">
              <div className="camera-overlay-head">
                <span>now <b>{instantFileRate > 0 ? formatRate(instantFileRate) : "—"}</b></span>
                <span>avg <b>{effectiveRate > 0 ? formatRate(effectiveRate) : "—"}</b></span>
                <span>eta <b>{complete ? "done" : formatEta(etaSeconds)}</b></span>
                <span><b>{Math.round(progress * 100)}%</b></span>
                <span>fps <b>{scanMetrics.scannerFps ? scanMetrics.scannerFps.toFixed(0) : "—"}</b></span>
              </div>
              <div className="camera-framing">
                <span aria-hidden="true" />
                {overlayFramingMessage}
              </div>
              {active && scanMode !== "single" ? (
                <button
                  className="receiver-fullscreen-button"
                  type="button"
                  onClick={() => void toggleReceiverFullscreen()}
                  aria-label={receiverFullscreen ? "Exit receiver fullscreen" : "Enter receiver fullscreen"}
                >
                  {receiverFullscreen ? "×" : "⛶"}
                </button>
              ) : null}
              {active ? (
                <button
                  className="receiver-stop-button"
                  type="button"
                  onClick={stopAndResetCamera}
                >
                  Stop
                </button>
              ) : null}
              <div className="camera-overlay-progress" aria-hidden="true">
                <span style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
          ) : null}
          {!active && !complete ? (
            <div className="camera-empty">
              <span className="camera-icon" aria-hidden="true">◎</span>
              <strong>Camera off</strong>
            </div>
          ) : null}
          {state === "starting" ? <div className="camera-loading">Loading optical decoder…</div> : null}
          {complete ? <div className="complete-mark" aria-hidden="true">✓</div> : null}
          {torchAvailable && active ? (
            <button className="torch-button" type="button" onClick={toggleTorch}>
              {torchOn ? "Light off" : "Light on"}
            </button>
          ) : null}
        </div>

        <div className="receive-card">
          <div className="receive-status">
            <span className={`pulse-dot ${active ? "live" : ""}`} aria-hidden="true" />
            <strong>
              {state === "receiving"
                ? "Receiving RaptorQ symbols"
                : state === "scanning"
                  ? "Looking for the QR stream"
                  : complete
                    ? "Transfer verified"
                    : "Ready to scan"}
            </strong>
            <b>{Math.round(progress * 100)}%</b>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="File recovery progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${progress * 100}%` }} />
          </div>

          <div
            className="scan-mode-picker"
            role="radiogroup"
            aria-label="Scanner layout"
          >
            <button
              type="button"
              role="radio"
              aria-checked={scanMode === "dual"}
              className={scanMode === "dual" ? "selected" : ""}
              disabled={active}
              onClick={() => chooseScanMode("dual")}
            >
              Fast dual
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scanMode === "single"}
              className={scanMode === "single" ? "selected" : ""}
              disabled={active}
              onClick={() => chooseScanMode("single")}
            >
              Fallback single
            </button>
          </div>

          {incoming ? (
            <div className="incoming-file">
              <span className="file-glyph" aria-hidden="true">↓</span>
              <div>
                <strong>{fileMeta?.filename || "Incoming file"}</strong>
                <span>
                  {formatBytes(incoming.originalSize)}
                  {incoming.compressed ? ` · ${compressionPercent}% compression` : ""}
                  {" · "}
                  {frames.toLocaleString()} / ~{incoming.sourcePacketCount.toLocaleString()} symbols
                </span>
              </div>
              <b>RQ</b>
            </div>
          ) : null}

          <div className="scan-summary" aria-label="Live transfer statistics">
            <span>{cameraSettings?.frameRate ? cameraSettings.frameRate.toFixed(0) : "—"} Hz</span>
            <span>{scanMetrics.deliveredFps ? scanMetrics.deliveredFps.toFixed(0) : "—"}/{scanMetrics.scannerFps ? scanMetrics.scannerFps.toFixed(0) : "—"} fps</span>
            <span>{scanMetrics.decodeP95 ? scanMetrics.decodeP95.toFixed(0) : "—"} ms p95</span>
            <span>{scanMetrics.uniquePerSec ? scanMetrics.uniquePerSec.toFixed(0) : "—"}/s unique</span>
          </div>
          {!active && !complete ? <p className="scan-hint">{guidance}</p> : null}

          {error ? <p className="error-message" role="alert">{error}</p> : null}

          {complete && downloadUrl && fileMeta ? (
            <a className="primary-action" href={downloadUrl} download={fileMeta.filename}>
              <span aria-hidden="true">↓</span>
              Save {fileMeta.filename}
            </a>
          ) : (
            <button
              className="primary-action"
              type="button"
              disabled={state === "starting"}
              onClick={
                active
                  ? stopAndResetCamera
                  : startCamera
              }
            >
              <span aria-hidden="true">{active ? "■" : "◎"}</span>
              {state === "starting" ? "Loading…" : active ? "Stop camera" : "Start camera"}
            </button>
          )}

          {complete ? (
            <button className="link-action" type="button" onClick={startCamera}>
              Scan another transfer
            </button>
          ) : null}
        </div>
      </section>

    </main>
  );
}
