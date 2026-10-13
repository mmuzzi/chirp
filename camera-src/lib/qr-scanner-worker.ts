import {
  prepareZXingModule,
  readBarcodes,
} from "zxing-wasm/reader";
import zxingReaderWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

type WorkerRequest = {
  id: number;
  data: ArrayBuffer;
  width: number;
  height: number;
  robust: boolean;
  maxNumberOfSymbols: number;
};

type WorkerResponse = {
  id: number;
  results?: Array<{
    bytes: ArrayBuffer;
    position: {
      topLeft: { x: number; y: number };
      topRight: { x: number; y: number };
      bottomLeft: { x: number; y: number };
      bottomRight: { x: number; y: number };
    };
  }>;
  error?: string;
};

let ready: Promise<unknown> | undefined;

function prepareQrScanner() {
  if (!ready) {
    ready = Promise.resolve(
      prepareZXingModule({
        overrides: {
          locateFile: (path: string) =>
            path.endsWith(".wasm") ? zxingReaderWasmUrl : path,
        },
        equalityFn: Object.is,
        fireImmediately: true,
      }),
    );
  }
  return ready;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    await prepareQrScanner();
    const image = new ImageData(
      new Uint8ClampedArray(request.data),
      request.width,
      request.height,
    );
    const results = await readBarcodes(image, {
      formats: ["QRCode"],
      tryHarder: request.robust,
      tryRotate: false,
      tryInvert: false,
      tryDownscale: false,
      tryDenoise: false,
      binarizer: request.robust ? "LocalAverage" : "GlobalHistogram",
      maxNumberOfSymbols: Math.max(
        1,
        Math.min(2, Math.round(request.maxNumberOfSymbols || 1)),
      ),
      textMode: "Plain",
    });
    const valid = results
      .filter(
        (candidate) =>
          candidate.isValid &&
          candidate.symbology === "QRCode" &&
          candidate.bytes.length > 0,
      )
      .map((candidate) => ({
        bytes: new Uint8Array(candidate.bytes).buffer,
        position: candidate.position,
      }));
    const response: WorkerResponse = { id: request.id, results: valid };
    self.postMessage(response, {
      transfer: valid.map((result) => result.bytes),
    });
  } catch (cause) {
    const response: WorkerResponse = {
      id: request.id,
      error: cause instanceof Error ? cause.message : "QR worker failed",
    };
    self.postMessage(response);
  }
};

export {};
