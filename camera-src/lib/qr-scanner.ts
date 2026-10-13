import {
  prepareZXingModule,
  readBarcodes,
} from "zxing-wasm/reader";
import zxingReaderWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

let ready: Promise<unknown> | undefined;

export type QrPoint = { x: number; y: number };
export type QrPosition = {
  topLeft: QrPoint;
  topRight: QrPoint;
  bottomLeft: QrPoint;
  bottomRight: QrPoint;
};

export type DecodedQr = {
  bytes: Uint8Array;
  position: QrPosition;
};

export function prepareQrScanner() {
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

export async function scanRawQr(
  image: ImageData,
  robust: boolean,
): Promise<DecodedQr | null> {
  const results = await scanRawQrs(image, robust, 1);
  return results[0] ?? null;
}

export async function scanRawQrs(
  image: ImageData,
  robust: boolean,
  maxNumberOfSymbols = 2,
): Promise<DecodedQr[]> {
  await prepareQrScanner();
  const results = await readBarcodes(image, {
    formats: ["QRCode"],
    tryHarder: robust,
    tryRotate: false,
    tryInvert: false,
    tryDownscale: false,
    tryDenoise: false,
    binarizer: robust ? "LocalAverage" : "GlobalHistogram",
    maxNumberOfSymbols,
    textMode: "Plain",
  });
  return results
    .filter(
      (candidate) =>
        candidate.isValid &&
        candidate.symbology === "QRCode" &&
        candidate.bytes.length > 0,
    )
    .map((candidate) => ({
      bytes: new Uint8Array(candidate.bytes),
      position: candidate.position,
    }));
}
