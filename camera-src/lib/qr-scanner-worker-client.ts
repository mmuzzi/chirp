import type { DecodedQr, QrPosition } from "./qr-scanner";

type PendingRequest = {
  resolve: (value: DecodedQr[]) => void;
  reject: (cause: unknown) => void;
};

type WorkerResponse = {
  id: number;
  results?: Array<{
    bytes: ArrayBuffer;
    position: QrPosition;
  }>;
  error?: string;
};

/**
 * Keep the expensive ZXing call away from the camera callback's main thread.
 * The receiver deliberately submits one full panorama at a time; a single
 * worker is therefore both cheaper and more predictable than two workers
 * decoding crops that were frequently rejected and then decoded again.
 */
class QrDecoderWorker {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor() {
    this.worker = new Worker(new URL("./qr-scanner-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.error) {
        request.reject(new Error(event.data.error));
        return;
      }
      request.resolve(
        (event.data.results ?? []).map((result) => ({
          bytes: new Uint8Array(result.bytes),
          position: result.position,
        })),
      );
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "QR decoder worker failed.");
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
  }

  decode(image: ImageData, robust: boolean, maxNumberOfSymbols: number) {
    const id = this.nextId++;
    return new Promise<DecodedQr[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const pixels = image.data;
      // Tracked crops are dedicated ImageData allocations. Transfer their
      // backing buffer directly instead of copying every RGBA byte again on
      // the main thread. Keep the slice fallback for unusual subarray views.
      const data =
        pixels.byteOffset === 0 &&
        pixels.byteLength === pixels.buffer.byteLength &&
        pixels.buffer instanceof ArrayBuffer
          ? pixels.buffer
          : pixels.slice().buffer;
      try {
        this.worker.postMessage(
          {
            id,
            data,
            width: image.width,
            height: image.height,
            robust,
            maxNumberOfSymbols,
          },
          [data],
        );
      } catch (cause) {
        this.pending.delete(id);
        reject(cause);
      }
    });
  }

  terminate() {
    this.worker.terminate();
    const error = new Error("QR decoder worker stopped.");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export class QrDecoder {
  private readonly worker: QrDecoderWorker;

  constructor() {
    this.worker = new QrDecoderWorker();
  }

  decode(image: ImageData, robust: boolean, maxNumberOfSymbols = 2) {
    return this.worker.decode(image, robust, maxNumberOfSymbols);
  }

  terminate() {
    this.worker.terminate();
  }
}

/** Two independent workers let the probationary lane path test both crops in
 * parallel. The combined decoder above remains the normal fallback/authority.
 */
export class LaneDecoderPool {
  private readonly workers: QrDecoderWorker[];

  constructor(count = 2) {
    this.workers = Array.from(
      { length: Math.max(1, count) },
      () => new QrDecoderWorker(),
    );
  }

  async decode(lane: number, image: ImageData, robust: boolean) {
    const results = await this.workers[lane % this.workers.length].decode(
      image,
      robust,
      1,
    );
    return results[0] ?? null;
  }

  terminate() {
    for (const worker of this.workers) worker.terminate();
  }
}
