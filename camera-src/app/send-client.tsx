"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  compressForTransfer,
  compressReadableStreamForTransfer,
} from "@/lib/compression";
import {
  buildOpticalContainer,
  buildOpticalContainerFromMetadata,
  createOpticalTransfer,
  crc32Finalize,
  crc32Update,
  formatBytes,
  formatRate,
  MAX_FILE_BYTES,
  OpticalTransfer,
  PreparedOpticalFile,
  createOpticalPlaybackOrder,
} from "@/lib/optical-transfer";
import {
  TRANSFER_PRESETS,
  TransferPresetKey,
} from "@/lib/transfer-presets";

type PreparedFile = {
  file: File;
  optical: PreparedOpticalFile;
};
type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const STREAM_PREPARATION_THRESHOLD = 2 * 1024 * 1024;
const PRE_RENDER_AHEAD = 8;
const QR_RENDER_CACHE_LIMIT = 24;
// The standard dual preset attempts two fresh lane symbols per 60 Hz refresh.
// Three consecutive over-budget draws disable it for the rest of that run and
// leave the one-symbol staggered path available as the safe fallback.
const USE_SIMULTANEOUS_DUAL_REFRESH = true;
const VISIBLE_PRESET_KEYS: TransferPresetKey[] = [
  "megabit120",
  "turbo30",
];
const ALREADY_COMPRESSED_FILE =
  /\.(?:zip|7z|rar|gz|bz2|xz|zst|cab|jar|apk|dmg|iso|png|jpe?g|webp|gif|avif|heic|heif|mp4|m4v|mov|mkv|webm|mp3|m4a|aac|flac|ogg|pdf|docx|xlsx|pptx)$/i;

let qrRendererPromise:
  | Promise<typeof import("@/lib/qr-renderer")>
  | undefined;

function loadQrRenderer() {
  if (!qrRendererPromise) qrRendererPromise = import("@/lib/qr-renderer");
  return qrRendererPromise;
}

function shouldSkipCompression(file: File) {
  return (
    ALREADY_COMPRESSED_FILE.test(file.name) ||
    /^(?:application\/(?:zip|x-7z-compressed|x-rar-compressed|gzip|pdf)|image\/(?:png|jpe?g|webp|gif|avif|heic)|audio\/|video\/)/i.test(
      file.type,
    )
  );
}

// A phone camera delivers 30-60 fps and each camera frame can catch at most one code per lane, so the
// receiver-side symbol rate is min(sender rate, lanes x camera fps), minus ~22% for blurred/duplicate frames.
function receivableSymbolsPerSec(
  preset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
  cameraFps: number,
) {
  return Math.min(preset.fps, preset.lanes * cameraFps) * 0.78;
}

function formatSeconds(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec`;
  const minutes = seconds / 60;
  return `${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

function estimateDuration(
  transfer: OpticalTransfer,
  preset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
) {
  const fast = transfer.sourcePacketCount / receivableSymbolsPerSec(preset, 60);
  const slow = transfer.sourcePacketCount / receivableSymbolsPerSec(preset, 30);
  const low = formatSeconds(fast), high = formatSeconds(slow);
  if (low === high) return `about ${low}`;
  if (slow < 60) return `about ${Math.max(1, Math.ceil(fast))}–${high}`;
  return `about ${low}–${high}`;
}

export function SendClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const canvasContextRefs = useRef<
    Array<{
      canvas: HTMLCanvasElement;
      context: CanvasRenderingContext2D;
    } | null>
  >([]);
  const qrStageRef = useRef<HTMLDivElement>(null);
  const transferRef = useRef<OpticalTransfer | undefined>(undefined);
  const orderRef = useRef<number[]>([]);
  const playbackCycleRef = useRef(0);
  const playbackOffsetRef = useRef(0);
  const playedFramesRef = useRef(0);
  const displayFpsRef = useRef(0);
  const aggressiveDualRef = useRef(false);
  const aggressiveDualBlockedRef = useRef(false);
  const aggressiveDualFallbackRef = useRef(false);
  const aggressiveDualSlowDrawsRef = useRef(0);
  const broadcastFrameTimesRef = useRef<number[]>([]);
  const renderedQrCacheRef = useRef<Map<string, ImageData>>(new Map());
  const renderPromisesRef = useRef<Map<string, Promise<ImageData>>>(new Map());
  const renderPerformanceRef = useRef<Array<{ at: number; ms: number }>>([]);
  const encodeJobRef = useRef(0);
  const preparationJobRef = useRef(0);
  const senderFullscreenRef = useRef(false);
  const presetKeyRef = useRef<TransferPresetKey>("megabit120");
  const [fileData, setFileData] = useState<PreparedFile>();
  const [transfer, setTransfer] = useState<OpticalTransfer>();
  const [presetKey, setPresetKey] = useState<TransferPresetKey>("megabit120");
  const [playing, setPlaying] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [preparationProgress, setPreparationProgress] = useState(0);
  const [playbackView, setPlaybackView] = useState({
    cycleFrame: 0,
    cycleNumber: 1,
    orderLength: 0,
    progress: 0,
  });
  const [actualFps, setActualFps] = useState(0);
  const [displayFps, setDisplayFps] = useState(0);
  const [aggressiveDual, setAggressiveDual] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [senderFullscreen, setSenderFullscreen] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const preset = TRANSFER_PRESETS[presetKey];
  const readyTransfer =
    transfer?.profileKey === presetKey ? transfer : undefined;

  const installTransfer = useCallback((next: OpticalTransfer) => {
    transferRef.current = next;
    orderRef.current = createOpticalPlaybackOrder(next, 0);
    playbackCycleRef.current = 0;
    playbackOffsetRef.current = 0;
    renderedQrCacheRef.current.clear();
    renderPromisesRef.current.clear();
    playedFramesRef.current = 0;
    setPlaybackView({
      cycleFrame: 0,
      cycleNumber: 1,
      orderLength: orderRef.current.length,
      progress: 0,
    });
    setTransfer(next);
  }, []);

  const encodePrepared = useCallback(
    async (
      prepared: PreparedFile,
      nextPresetKey: TransferPresetKey,
    ) => {
      const job = encodeJobRef.current + 1;
      encodeJobRef.current = job;
      transferRef.current = undefined;
      orderRef.current = [];
      playbackCycleRef.current = 0;
      playbackOffsetRef.current = 0;
      playedFramesRef.current = 0;
      setPlaybackView({ cycleFrame: 0, cycleNumber: 1, orderLength: 0, progress: 0 });
      setTransfer(undefined);
      setProcessing(true);
      setError("");
      try {
        const nextPreset = TRANSFER_PRESETS[nextPresetKey];
        const next = await createOpticalTransfer(prepared.optical, {
          symbolSize: nextPreset.symbolSize,
          repairPercent: nextPreset.repairPercent,
          repairPoolPercent: nextPreset.repairPoolPercent,
          profileKey: nextPresetKey,
        });
        if (encodeJobRef.current === job) installTransfer(next);
      } catch (cause) {
        if (encodeJobRef.current === job) {
          setTransfer(undefined);
          transferRef.current = undefined;
          setError(
            cause instanceof Error
              ? cause.message
              : "The RaptorQ stream could not be prepared.",
          );
        }
      } finally {
        if (encodeJobRef.current === job) setProcessing(false);
      }
    },
    [installTransfer],
  );

  const prepareFile = useCallback(
    async (file: File) => {
      setError("");
      setPlaying(false);
      setActualFps(0);
      setDisplayFps(0);
      setAggressiveDual(false);
      aggressiveDualRef.current = false;
      aggressiveDualBlockedRef.current = false;
      aggressiveDualFallbackRef.current = false;
      aggressiveDualSlowDrawsRef.current = 0;
      displayFpsRef.current = 0;
      setPreparationProgress(0);
      // Invalidate an older file's encoder before reading this one.
      encodeJobRef.current += 1;
      const preparationJob = preparationJobRef.current + 1;
      preparationJobRef.current = preparationJob;
      setFileData(undefined);
      transferRef.current = undefined;
      orderRef.current = [];
      playbackCycleRef.current = 0;
      playbackOffsetRef.current = 0;
      setPlaybackView({ cycleFrame: 0, cycleNumber: 1, orderLength: 0, progress: 0 });
      setTransfer(undefined);
      if (file.size > MAX_FILE_BYTES) {
        setError("Choose a file smaller than 512 MB for this browser build.");
        return;
      }
      setProcessing(true);
      try {
        let prepared: PreparedFile;
        if (file.size >= STREAM_PREPARATION_THRESHOLD && file.stream) {
          let originalCrc = 0xffffffff;
          const compressed = await compressReadableStreamForTransfer(
            file.stream(),
            file.size,
            {
              skipCompression: shouldSkipCompression(file),
              onChunk: (chunk) => {
                originalCrc = crc32Update(originalCrc, chunk);
              },
              onProgress: (processedBytes) => {
                if (preparationJobRef.current === preparationJob) {
                  setPreparationProgress(
                    file.size > 0 ? processedBytes / file.size : 1,
                  );
                }
              },
            },
          );
          prepared = {
            file,
            optical: buildOpticalContainerFromMetadata(compressed.bytes, {
              filename: file.name,
              mime: file.type || "application/octet-stream",
              compression: compressed.mode,
              fileSize: file.size,
              fileCrc: crc32Finalize(originalCrc),
            }),
          };
        } else {
          const original = new Uint8Array(await file.arrayBuffer());
          const compressed = await compressForTransfer(original, {
            skipCompression: shouldSkipCompression(file),
          });
          setPreparationProgress(1);
          prepared = {
            file,
            optical: buildOpticalContainer(original, compressed.bytes, {
              filename: file.name,
              mime: file.type || "application/octet-stream",
              compression: compressed.mode,
            }),
          };
        }
        if (preparationJobRef.current !== preparationJob) return;
        setFileData(prepared);
        await encodePrepared(prepared, presetKeyRef.current);
      } catch (cause) {
        if (preparationJobRef.current !== preparationJob) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "The file could not be prepared.",
        );
        setPreparationProgress(0);
        setProcessing(false);
      }
    },
    [encodePrepared],
  );

  const changePreset = (nextKey: TransferPresetKey) => {
    presetKeyRef.current = nextKey;
    setPresetKey(nextKey);
    setPlaying(false);
    setActualFps(0);
    setDisplayFps(0);
    setAggressiveDual(false);
    aggressiveDualRef.current = false;
    aggressiveDualBlockedRef.current = false;
    aggressiveDualFallbackRef.current = false;
    aggressiveDualSlowDrawsRef.current = 0;
    displayFpsRef.current = 0;
    transferRef.current = undefined;
    orderRef.current = [];
    playbackCycleRef.current = 0;
    playbackOffsetRef.current = 0;
    setPlaybackView({ cycleFrame: 0, cycleNumber: 1, orderLength: 0, progress: 0 });
    setTransfer(undefined);
    if (fileData) void encodePrepared(fileData, nextKey);
  };

  const getRenderedPacket = useCallback(
    async (
      target: OpticalTransfer,
      packetIndex: number,
      activePreset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
    ) => {
      const key = `${target.session}:${activePreset.codec}:${activePreset.version}:${activePreset.ecc}:${activePreset.renderScale}:${packetIndex}`;
      const cached = renderedQrCacheRef.current.get(key);
      if (cached) return cached;
      const pending = renderPromisesRef.current.get(key);
      if (pending) return pending;
      const renderPromise = loadQrRenderer()
        .then(async ({ renderRawQr }) => {
              try {
                return await renderRawQr(
                  target.packets[packetIndex],
                  activePreset.version,
                  activePreset.ecc,
                  activePreset.renderScale,
                );
              } catch (cause) {
                if (!activePreset.fallbackRenderScale) throw cause;
                return renderRawQr(
                  target.packets[packetIndex],
                  activePreset.version,
                  activePreset.ecc,
                  activePreset.fallbackRenderScale,
                );
              }
            })
        .then((image) => {
          renderedQrCacheRef.current.set(key, image);
          while (renderedQrCacheRef.current.size > QR_RENDER_CACHE_LIMIT) {
            const oldest = renderedQrCacheRef.current.keys().next().value;
            if (oldest === undefined) break;
            renderedQrCacheRef.current.delete(oldest);
          }
          renderPromisesRef.current.delete(key);
          return image;
        })
        .catch((cause) => {
          renderPromisesRef.current.delete(key);
          throw cause;
        });
      renderPromisesRef.current.set(key, renderPromise);
      return renderPromise;
    },
    [],
  );

  const drawRenderedPacket = useCallback((image: ImageData, laneIndex: number) => {
    const canvas = canvasRefs.current[laneIndex];
    if (!canvas) return;
    // Resizing a canvas reallocates and clears its backing store. The backing
    // resolution is fixed once, and every animation tick only copies pixels.
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    let context =
      canvasContextRefs.current[laneIndex]?.canvas === canvas
        ? canvasContextRefs.current[laneIndex]?.context
        : undefined;
    if (!context) {
      context = canvas.getContext("2d", { alpha: false }) ?? undefined;
      if (context) {
        context.imageSmoothingEnabled = false;
        canvasContextRefs.current[laneIndex] = { canvas, context };
      }
    }
    if (!context) throw new Error("The QR drawing surface is unavailable.");
    context.putImageData(image, 0, 0);
  }, []);

  const renderPacket = useCallback(
    async (
      target: OpticalTransfer,
      packetIndex: number,
      activePreset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
      laneIndex = 0,
    ) => {
      const image = await getRenderedPacket(target, packetIndex, activePreset);
      drawRenderedPacket(image, laneIndex);
    },
    [drawRenderedPacket, getRenderedPacket],
  );

  useEffect(() => {
    if (!readyTransfer || orderRef.current.length === 0) return;
    let cancelled = false;
    const order = orderRef.current;
    void (async () => {
      await Promise.all(
        Array.from({ length: preset.lanes }, (_, laneIndex) =>
          renderPacket(
            readyTransfer,
            order[laneIndex % order.length],
            preset,
            laneIndex,
          ),
        ),
      );
      // Warm a small ring ahead of the visible frame. Rendering happens before
      // playback starts, so rAF is reduced to two cheap putImageData calls.
      for (let offset = preset.lanes; offset < PRE_RENDER_AHEAD && !cancelled; offset += 1) {
        await getRenderedPacket(
          readyTransfer,
          order[offset % order.length],
          preset,
        );
      }
    })().catch(() => {
      if (!cancelled) setError("The QR preview could not be rendered.");
    });
    return () => {
      cancelled = true;
    };
  }, [getRenderedPacket, preset, readyTransfer, renderPacket]);

  useEffect(() => {
    if (!playing || !readyTransfer) return;
    let cancelled = false;
    let animationFrame = 0;
    let displayMeasurementFrame = 0;
    const interval = 1000 / preset.fps;
    let nextFrameAt = performance.now();
    let lastDisplayMeasurement = 0;
    const displayFrameTimes: number[] = [];
    broadcastFrameTimesRef.current = [];
    renderPerformanceRef.current = [];
    aggressiveDualFallbackRef.current = false;
    aggressiveDualSlowDrawsRef.current = 0;

    // Measure the browser/compositor cadence independently of QR rendering.
    // This distinguishes a 60 Hz page/display cap from a renderer that cannot
    // keep up with a 120 Hz rAF stream.
    const measureDisplayCadence = (time: number) => {
      displayFrameTimes.push(time);
      while (
        displayFrameTimes.length > 2 &&
        time - displayFrameTimes[0] > 1500
      ) {
        displayFrameTimes.shift();
      }
      if (
        displayFrameTimes.length > 1 &&
        time - lastDisplayMeasurement >= 500
      ) {
        lastDisplayMeasurement = time;
        const measuredDisplayFps =
          ((displayFrameTimes.length - 1) * 1000) /
          (displayFrameTimes[displayFrameTimes.length - 1] -
            displayFrameTimes[0]);
        displayFpsRef.current = measuredDisplayFps;
        const canUseAggressiveDual =
          USE_SIMULTANEOUS_DUAL_REFRESH &&
          presetKey === "megabit120" &&
          measuredDisplayFps < 90 &&
          !aggressiveDualBlockedRef.current;
        aggressiveDualRef.current = canUseAggressiveDual;
        setDisplayFps(measuredDisplayFps);
        setAggressiveDual(canUseAggressiveDual);
      }
      displayMeasurementFrame = window.requestAnimationFrame(
        measureDisplayCadence,
      );
    };
    displayMeasurementFrame = window.requestAnimationFrame(
      measureDisplayCadence,
    );

    const tick = async (now: number) => {
      if (now + 0.5 < nextFrameAt) {
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }
      const activeTransfer = transferRef.current;
      const currentOrder = orderRef.current;
      if (
        !activeTransfer ||
        activeTransfer.profileKey !== presetKey ||
        currentOrder.length === 0 ||
        cancelled
      ) {
        return;
      }
      const frameNumber = playedFramesRef.current;
      const symbolsThisRefresh = aggressiveDualRef.current ? 2 : 1;
      let order = currentOrder;
      let orderCycle = playbackCycleRef.current;
      let orderOffset = playbackOffsetRef.current;
      let drawMs = 0;
      try {
        const packets = Array.from(
          { length: symbolsThisRefresh },
          (_, offset) => {
            if (orderOffset >= order.length) {
              orderCycle += 1;
              order = createOpticalPlaybackOrder(activeTransfer, orderCycle);
              orderRef.current = order;
              orderOffset = 0;
            }
            const packetIndex = order[orderOffset];
            orderOffset += 1;
            return {
              packetIndex,
              laneIndex:
                symbolsThisRefresh === 2
                  ? offset
                  : frameNumber % preset.lanes,
            };
          },
        );
        // Rendering is intentionally outside the rAF-critical path. The
        // background ring has already produced these ImageData objects; the
        // refresh itself only copies cached pixels into the two canvases.
        const images = await Promise.all(
          packets.map(({ packetIndex }) =>
            getRenderedPacket(activeTransfer, packetIndex, preset),
          ),
        );
        const renderStartedAt = performance.now();
        images.forEach((image, index) =>
          drawRenderedPacket(image, packets[index].laneIndex),
        );
        const renderCompletedAt = performance.now();
        drawMs = renderCompletedAt - renderStartedAt;
        const renderSamples = renderPerformanceRef.current;
        renderSamples.push({ at: renderCompletedAt, ms: drawMs });
        while (
          renderSamples.length > 2 &&
          renderCompletedAt - renderSamples[0].at > 3500
        ) {
          renderSamples.shift();
        }
        // Keep the ring moving ahead of playback without making rAF wait for
        // WASM QR generation. The promise map de-duplicates concurrent work.
        let aheadCycle = orderCycle;
        let aheadOffset = orderOffset;
        let aheadOrder = order;
        for (let offset = symbolsThisRefresh; offset < PRE_RENDER_AHEAD; offset += 1) {
          if (aheadOffset >= aheadOrder.length) {
            aheadCycle += 1;
            aheadOrder = createOpticalPlaybackOrder(activeTransfer, aheadCycle);
            aheadOffset = 0;
          }
          void getRenderedPacket(
            activeTransfer,
            aheadOrder[aheadOffset],
            preset,
          );
          aheadOffset += 1;
        }
      } catch {
        setError("QR rendering paused after an unexpected error.");
        setPlaying(false);
        return;
      }
      if (cancelled) return;
      playbackCycleRef.current = orderCycle;
      playbackOffsetRef.current = orderOffset;
      const completedAt = performance.now();
      if (symbolsThisRefresh === 2) {
        // Two symbols are intentionally presented together on one physical
        // display refresh. Judge them against that refresh budget, not the
        // nominal per-symbol interval, and do not latch off on one GC/jank
        // outlier.
        const measuredDisplayFps = displayFpsRef.current || 60;
        const displayBudgetMs = 1000 / measuredDisplayFps;
        aggressiveDualSlowDrawsRef.current =
          drawMs > displayBudgetMs * 0.85
            ? aggressiveDualSlowDrawsRef.current + 1
            : Math.max(0, aggressiveDualSlowDrawsRef.current - 1);
        if (aggressiveDualSlowDrawsRef.current >= 3) {
          aggressiveDualRef.current = false;
          aggressiveDualBlockedRef.current = true;
          aggressiveDualFallbackRef.current = true;
          setAggressiveDual(false);
        }
      }
      playedFramesRef.current += symbolsThisRefresh;
      const frameTimes = broadcastFrameTimesRef.current;
      for (let index = 0; index < symbolsThisRefresh; index += 1) {
        frameTimes.push(completedAt);
      }
      while (
        frameTimes.length > 2 &&
        completedAt - frameTimes[0] > 2500
      ) {
        frameTimes.shift();
      }

      const uiInterval = Math.max(1, Math.round(preset.fps / 10));
      if (playedFramesRef.current % uiInterval === 0) {
        setPlaybackView({
          cycleFrame: orderOffset,
          cycleNumber: orderCycle + 1,
          orderLength: order.length,
          progress: orderOffset / Math.max(1, order.length),
        });
        if (frameTimes.length > 1) {
          setActualFps(
            ((frameTimes.length - 1) * 1000) /
              (frameTimes[frameTimes.length - 1] - frameTimes[0]),
          );
        }
      }

      nextFrameAt += interval;
      if (nextFrameAt < completedAt - interval) {
        nextFrameAt = completedAt + interval;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(displayMeasurementFrame);
    };
  }, [drawRenderedPacket, getRenderedPacket, playing, preset, presetKey, readyTransfer]);

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void prepareFile(file);
  };

  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void prepareFile(file);
  };

  const scanUrl = useMemo(() => {
    if (typeof window === "undefined") return "/scan";
    if (
      document.documentElement.dataset.qrferryStandalone === "true" ||
      window.location.protocol === "file:"
    ) {
      return `${window.location.href.split("#")[0]}#scan`;
    }
    return `${window.location.origin}/scan`;
  }, []);

  const copyScanLink = async () => {
    try {
      await navigator.clipboard.writeText(scanUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Copy failed. Open this site on the receiving laptop and choose Scan.");
    }
  };

  const toggleFullscreen = async () => {
    if (!qrStageRef.current) return;
    const stage = qrStageRef.current as FullscreenCapableElement;
    if (document.fullscreenElement || senderFullscreenRef.current) {
      senderFullscreenRef.current = false;
      setSenderFullscreen(false);
      if (document.fullscreenElement) {
        await document.exitFullscreen?.().catch(() => undefined);
      }
      return;
    }
    setSenderFullscreen(true);
    senderFullscreenRef.current = true;
    setActualFps(0);
    setDisplayFps(0);
    setAggressiveDual(false);
    aggressiveDualRef.current = false;
    aggressiveDualBlockedRef.current = false;
    displayFpsRef.current = 0;
    setPlaying(true);

    // Native fullscreen is preferred, but the fixed CSS layout below keeps
    // the QR stage usable in embedded browsers that reject the API.
    try {
      const requestNativeFullscreen =
        stage.requestFullscreen?.bind(stage) ??
        stage.webkitRequestFullscreen?.bind(stage) ??
        document.documentElement.requestFullscreen?.bind(document.documentElement);
      await requestNativeFullscreen?.();
    } catch {
      // CSS fullscreen remains active; iOS/embedded browsers commonly land
      // here even though the viewport-sized sender is still useful.
    }
  };

  useEffect(() => {
    const syncFullscreenState = () => {
      if (document.fullscreenElement) {
        senderFullscreenRef.current = true;
        setSenderFullscreen(true);
      } else if (senderFullscreenRef.current && !qrStageRef.current?.matches(":focus")) {
        senderFullscreenRef.current = false;
        setSenderFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const orderLength = playbackView.orderLength || readyTransfer?.packets.length || 0;
  const cycleFrame = readyTransfer ? playbackView.cycleFrame : 0;
  const cycleNumber = readyTransfer ? playbackView.cycleNumber : 1;
  const cycleProgress = readyTransfer ? playbackView.progress : 0;
  const compressionPercent =
    fileData && fileData.optical.meta.fileSize > 0
      ? Math.max(
          0,
          Math.round(
            (1 -
              fileData.optical.meta.transmittedSize /
                fileData.optical.meta.fileSize) *
              100,
          ),
        )
      : 0;
  const compressionPercentLabel =
    compressionPercent > 0 ? `${compressionPercent}%` : "<1%";
  const nominalRate = preset.usefulBytesPerFrame * preset.fps;
  const expectedRate = preset.usefulBytesPerFrame * receivableSymbolsPerSec(preset, 30);

  return (
    <main className="compact-sender">
      <section className="sender-grid" aria-label="Create a QR transfer">
        <div className="control-panel">
          <div className="simple-panel-heading">
            <h1>Send</h1>
          </div>

          <div
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={dropFile}
          >
            <input
              ref={inputRef}
              type="file"
              onChange={selectFile}
              aria-label="Choose a file to transfer"
            />
            <button
              className="file-button"
              type="button"
              disabled={processing}
              onClick={() => inputRef.current?.click()}
            >
              <span aria-hidden="true">{processing ? "…" : "＋"}</span>
              {processing
                ? preparationProgress > 0 && preparationProgress < 1
                  ? `Preparing ${Math.round(preparationProgress * 100)}%`
                  : "Preparing locally"
                : "Browse files"}
            </button>
          </div>

          {fileData ? (
            <div className="selected-file">
              <span className="file-glyph" aria-hidden="true">↗</span>
              <div>
                <strong>{fileData.optical.meta.filename}</strong>
                <span>
                  {formatBytes(fileData.optical.meta.fileSize)}
                  {fileData.optical.meta.compression !== "none"
                    ? ` → ${formatBytes(fileData.optical.meta.transmittedSize)} · ${compressionPercentLabel} smaller · ${fileData.optical.meta.compression}`
                    : " · sent as-is"}
                </span>
              </div>
              <button type="button" onClick={() => inputRef.current?.click()}>
                Change
              </button>
            </div>
          ) : null}

          <div className="simple-mode-heading">
            <strong>Transfer mode</strong>
          </div>

          <div className="preset-list" role="radiogroup" aria-label="Signal preset">
            {VISIBLE_PRESET_KEYS.map((key) => {
              const option = TRANSFER_PRESETS[key];
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={presetKey === key}
                  className={presetKey === key ? "selected" : ""}
                  key={key}
                  onClick={() => changePreset(key)}
                >
                  <span className="radio-dot" aria-hidden="true" />
                  <span>
                    <strong>{option.label}</strong>
                  </span>
                  <b>
                    {option.lanes === 1
                      ? `${option.fps} fps`
                      : `${option.fps} symbols/s · ${option.fps / option.lanes} fps/lane`}
                    {" · "}
                    {formatRate(option.usefulBytesPerFrame * option.fps)}
                  </b>
                </button>
              );
            })}
          </div>

          {error ? <p className="error-message" role="alert">{error}</p> : null}
        </div>

        <div className="qr-panel">
          <div
            ref={qrStageRef}
            className={`qr-stage codec-${preset.codec} ${readyTransfer ? "ready" : ""} ${playing ? "playing" : ""} ${senderFullscreen ? "sender-fullscreen" : ""} lanes-${preset.lanes}`}
          >
            {readyTransfer ? (
              <div className={`qr-canvas-grid lanes-${preset.lanes}`}>
                {Array.from({ length: preset.lanes }, (_, laneIndex) => (
                  <canvas
                    key={laneIndex}
                    ref={(canvas) => {
                      canvasRefs.current[laneIndex] = canvas;
                    }}
                    aria-label={
                      preset.lanes === 1
                        ? "Animated RaptorQ file transfer"
                        : `Animated RaptorQ file transfer lane ${laneIndex + 1}`
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="qr-placeholder" aria-hidden="true" />
            )}
            <button
              className="fullscreen-button"
              type="button"
              onClick={toggleFullscreen}
              disabled={!readyTransfer}
              aria-label={senderFullscreen ? "Exit QR code fullscreen" : "Show QR code fullscreen"}
            >
              {senderFullscreen ? "×" : "⛶"}
            </button>
          </div>

          <div className="stream-status" aria-live="polite">
            <div>
              <span className={`pulse-dot ${playing ? "live" : ""}`} aria-hidden="true" />
              <strong>
                {playing
                  ? "Broadcasting"
                  : readyTransfer
                    ? "Ready to broadcast"
                    : processing
                      ? "Preparing locally"
                      : "Choose a file"}
              </strong>
            </div>
            <span>
              {readyTransfer
                ? `${estimateDuration(readyTransfer, preset)} · expect ${formatRate(expectedRate)}+ (${formatRate(nominalRate)} on screen)${
                    playing && (actualFps > 0 || displayFps > 0)
                      ? `${
                          actualFps > 0
                            ? ` · ${actualFps.toFixed(1)} fps rendered`
                            : ""
                        }${
                          displayFps > 0
                            ? ` · ${displayFps.toFixed(1)} Hz rAF`
                            : ""
                        }${aggressiveDual ? " · dual-refresh" : ""}`
                      : ""
                  }`
                : processing
                  ? "Preparing"
                  : ""}
            </span>
          </div>

          {readyTransfer ? (
            <div className="broadcast-progress">
              <div>
                <strong>{Math.round(cycleProgress * 100)}% of this playback cycle</strong>
                <span>cycle {cycleNumber} · {cycleFrame.toLocaleString()} / {orderLength.toLocaleString()}</span>
              </div>
              <div
                className="broadcast-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(cycleProgress * 100)}
              >
                <span style={{ width: `${cycleProgress * 100}%` }} />
              </div>
            </div>
          ) : null}

          <button
            className="primary-action"
            type="button"
            disabled={!readyTransfer || processing}
            onClick={() => {
              if (!playing) {
                setActualFps(0);
                setDisplayFps(0);
                setAggressiveDual(false);
                aggressiveDualRef.current = false;
                aggressiveDualBlockedRef.current = false;
                displayFpsRef.current = 0;
              }
              setPlaying((current) => !current);
            }}
          >
            <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
            {playing ? "Pause stream" : "Start QR stream"}
          </button>

          <button className="link-action" type="button" onClick={copyScanLink}>
            <span aria-hidden="true">⌁</span>
            {copied ? "Receiver link copied" : "Copy receiver link"}
          </button>
        </div>
      </section>

    </main>
  );
}
