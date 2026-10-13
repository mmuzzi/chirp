import { Gzip, gzip, gunzip } from "fflate";

export type CompressionMode = "none" | "gzip" | "brotli";

const MIN_SAVED_BYTES = 1024;
const STREAM_OUTPUT_BYTES = 128 * 1024;

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    if (typeof window !== "undefined") window.setTimeout(resolve, 0);
    else setTimeout(resolve, 0);
  });
}

type BrotliStreamResult = {
  buf: Uint8Array;
  code: number;
  input_offset: number;
  free(): void;
};

type BrotliCompressor = {
  compress(input: Uint8Array | undefined, outputSize: number): BrotliStreamResult;
  free(): void;
};

export type StreamCompressionOptions = {
  skipCompression?: boolean;
  onChunk?: (chunk: Uint8Array) => void;
  onProgress?: (processedBytes: number) => void;
};

export type CompressionResult = {
  bytes: Uint8Array;
  mode: CompressionMode;
  savedBytes: number;
};

export type CompressionOptions = {
  skipCompression?: boolean;
};

function gzipAsync(bytes: Uint8Array) {
  return new Promise<Uint8Array>((resolve, reject) => {
    gzip(bytes, { level: 9, mem: 12, mtime: 0 }, (error, compressed) => {
      if (error) reject(error);
      else resolve(compressed);
    });
  });
}

function gunzipAsync(bytes: Uint8Array) {
  return new Promise<Uint8Array>((resolve, reject) => {
    gunzip(bytes, (error, decompressed) => {
      if (error) reject(error);
      else resolve(decompressed);
    });
  });
}

async function brotliCompress(bytes: Uint8Array) {
  const brotliPackage = await import("brotli-wasm");
  const brotli = await brotliPackage.default;
  return new Uint8Array(brotli.compress(bytes, { quality: 11 }));
}

async function brotliDecompress(bytes: Uint8Array) {
  const brotliPackage = await import("brotli-wasm");
  const brotli = await brotliPackage.default;
  return new Uint8Array(brotli.decompress(bytes));
}

function concatChunks(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function pushBrotliChunk(
  compressor: BrotliCompressor,
  codes: { NeedsMoreInput: number; NeedsMoreOutput: number },
  chunk: Uint8Array,
  output: Uint8Array[],
) {
  let inputOffset = 0;
  while (inputOffset < chunk.length) {
    const result = compressor.compress(
      chunk.subarray(inputOffset),
      STREAM_OUTPUT_BYTES,
    );
    if (result.buf.length > 0) output.push(result.buf.slice());
    inputOffset += result.input_offset;
    const resultCode = result.code;
    result.free();
    if (resultCode === codes.NeedsMoreOutput) continue;
    if (resultCode === codes.NeedsMoreInput) {
      if (inputOffset !== chunk.length) {
        throw new Error("Brotli did not consume a complete input chunk.");
      }
      return;
    }
    throw new Error(`Brotli compression failed with stream code ${resultCode}.`);
  }
}

function finishBrotliStream(
  compressor: BrotliCompressor,
  codes: { ResultSuccess: number; NeedsMoreOutput: number },
  output: Uint8Array[],
) {
  while (true) {
    const result = compressor.compress(undefined, STREAM_OUTPUT_BYTES);
    if (result.buf.length > 0) output.push(result.buf.slice());
    const resultCode = result.code;
    result.free();
    if (resultCode === codes.NeedsMoreOutput) continue;
    if (resultCode === codes.ResultSuccess) return;
    throw new Error(`Brotli flush failed with stream code ${resultCode}.`);
  }
}

export async function compressForTransfer(
  bytes: Uint8Array,
  options: CompressionOptions = {},
): Promise<CompressionResult> {
  if (options.skipCompression || bytes.length < 768) {
    return { bytes, mode: "none", savedBytes: 0 };
  }

  const gzipPromise = gzipAsync(bytes);
  const brotliPromise = brotliCompress(bytes).catch(() => undefined);
  const [gzipBytes, brotliBytes] = await Promise.all([
    gzipPromise,
    brotliPromise,
  ]);
  const best =
    brotliBytes && brotliBytes.length < gzipBytes.length
      ? { bytes: brotliBytes, mode: "brotli" as const }
      : { bytes: gzipBytes, mode: "gzip" as const };
  // Keep a small safety margin: a token saving is not worth decompression work.
  if (best.bytes.length + MIN_SAVED_BYTES >= bytes.length) {
    return { bytes, mode: "none", savedBytes: 0 };
  }
  return {
    ...best,
    savedBytes: bytes.length - best.bytes.length,
  };
}

/**
 * Compress a Blob without first materializing the complete input in one
 * ArrayBuffer. Brotli and gzip both consume the file as chunks; the original
 * chunks are retained only as a fallback when compression is not worthwhile.
 */
export async function compressReadableStreamForTransfer(
  source: ReadableStream<Uint8Array>,
  size: number,
  options: StreamCompressionOptions = {},
): Promise<CompressionResult> {
  const originalChunks: Uint8Array[] = [];
  const gzipChunks: Uint8Array[] = [];
  const brotliChunks: Uint8Array[] = [];
  const shouldCompress = !options.skipCompression && size >= 768;
  let gzipStream: Gzip | undefined;
  let brotliStream: BrotliCompressor | undefined;
  let brotliCodes: {
    ResultSuccess: number;
    NeedsMoreInput: number;
    NeedsMoreOutput: number;
  } | undefined;

  if (shouldCompress) {
    gzipStream = new Gzip(
      { level: 9, mem: 12, mtime: 0 },
      (chunk) => {
        if (chunk.length > 0) gzipChunks.push(chunk.slice());
      },
    );
    try {
      const brotliPackage = await import("brotli-wasm");
      const brotli = await brotliPackage.default;
      brotliStream = new brotli.CompressStream(11);
      brotliCodes = brotli.BrotliStreamResultCode;
    } catch {
      // Gzip remains a valid fallback if the optional Brotli WASM cannot load.
    }
  }

  let processedBytes = 0;
  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      originalChunks.push(chunk.slice());
      options.onChunk?.(chunk);
      processedBytes += chunk.length;
      options.onProgress?.(processedBytes);

      if (gzipStream) gzipStream.push(chunk);
      if (brotliStream && brotliCodes) {
        pushBrotliChunk(brotliStream, brotliCodes, chunk, brotliChunks);
      }

      // Give the browser a paint opportunity between large input chunks.
      await yieldToBrowser();
    }
    if (gzipStream) gzipStream.push(new Uint8Array(0), true);
    if (brotliStream && brotliCodes) {
      finishBrotliStream(brotliStream, brotliCodes, brotliChunks);
    }
  } finally {
    reader.releaseLock();
    brotliStream?.free();
  }

  const originalBytes = () => concatChunks(originalChunks);
  if (!shouldCompress) {
    return { bytes: originalBytes(), mode: "none", savedBytes: 0 };
  }

  const gzipBytes = concatChunks(gzipChunks);
  const brotliBytes = brotliChunks.length > 0 ? concatChunks(brotliChunks) : undefined;
  const best =
    brotliBytes && brotliBytes.length < gzipBytes.length
      ? { bytes: brotliBytes, mode: "brotli" as const }
      : { bytes: gzipBytes, mode: "gzip" as const };
  if (best.bytes.length + MIN_SAVED_BYTES >= size) {
    return { bytes: originalBytes(), mode: "none", savedBytes: 0 };
  }
  return {
    ...best,
    savedBytes: size - best.bytes.length,
  };
}

export async function decompressTransfer(
  bytes: Uint8Array,
  mode: CompressionMode,
) {
  if (mode === "gzip") return gunzipAsync(bytes);
  if (mode === "brotli") return brotliDecompress(bytes);
  return bytes;
}
