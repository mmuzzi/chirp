import { encodeRaptorQPackets } from "@raptorqr/core/fec/raptorq_wasm";
import { CompressionMode } from "@/lib/compression";

const FRAME_MAGIC = new Uint8Array([0x51, 0x46, 0x34]); // QF4
const CONTAINER_MAGIC = new Uint8Array([0x51, 0x46, 0x43, 0x34]); // QFC4
const FRAME_HEADER_BYTES = 19;
const FRAME_CRC_BYTES = 4;
const CONTAINER_HEADER_BYTES = 23;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const OPTICAL_FRAME_OVERHEAD = FRAME_HEADER_BYTES + FRAME_CRC_BYTES;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
const RAPTORQ_PAYLOAD_ID_BYTES = 4;
const RAPTORQ_MAX_SOURCE_SYMBOLS_PER_BLOCK = 56_403;

export type OpticalFileMeta = {
  filename: string;
  mime: string;
  fileSize: number;
  transmittedSize: number;
  fileCrc: number;
  transmittedCrc: number;
  compression: CompressionMode;
};

export type PreparedOpticalFile = {
  meta: OpticalFileMeta;
  container: Uint8Array;
};

export type OpticalTransfer = {
  meta: OpticalFileMeta;
  /** The sender preset that produced these packets. */
  profileKey: string;
  session: number;
  containerLength: number;
  symbolSize: number;
  sourcePacketCount: number;
  packets: Uint8Array[];
  sourcePacketIndices: number[];
  /** The repair symbols used during the first playback pass. */
  initialRepairPacketIndices?: number[];
  /** Additional distinct repair symbols reserved for the next pass. */
  deferredRepairPacketIndices?: number[];
  /** All repair symbols in the encoded pool, including deferred symbols. */
  repairPacketIndices: number[];
};

export type OpticalFrame = {
  session: number;
  containerLength: number;
  originalSize: number;
  compressed: boolean;
  symbolSize: number;
  payload: Uint8Array;
};

function interleavePacketIndices(source: number[], repair: number[]) {
  if (source.length === 0) return [...repair];
  if (repair.length === 0) return [...source];
  const order: number[] = [];
  let repairIndex = 0;
  let accumulator = 0;
  for (const sourceIndex of source) {
    order.push(sourceIndex);
    accumulator += repair.length;
    while (repairIndex < repair.length && accumulator >= source.length) {
      order.push(repair[repairIndex]);
      repairIndex += 1;
      accumulator -= source.length;
    }
  }
  while (repairIndex < repair.length) {
    order.push(repair[repairIndex]);
    repairIndex += 1;
  }
  return order;
}

function seededRandom(seed: number) {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffledPacketIndices(indices: readonly number[], random: () => number) {
  const shuffled = [...indices];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

/**
 * Build a packet order for one playback cycle. Source and repair symbols are
 * shuffled independently, then interleaved so a periodic camera/display
 * miss does not reject the same packet on every replay.
 */
export function createOpticalPlaybackOrder(
  transfer: Pick<
    OpticalTransfer,
    | "session"
    | "sourcePacketIndices"
    | "repairPacketIndices"
    | "initialRepairPacketIndices"
    | "deferredRepairPacketIndices"
  >,
  cycle = 0,
) {
  const random = seededRandom(
    transfer.session ^ Math.imul((cycle + 1) >>> 0, 0x9e3779b9),
  );
  const initialRepair =
    transfer.initialRepairPacketIndices ?? transfer.repairPacketIndices;
  const deferredRepair = transfer.deferredRepairPacketIndices ?? [];
  // The first pass keeps the configured latency. If recovery has not
  // completed by then, spend the next pass on distinct repair symbols instead
  // of replaying the same finite stream and generating duplicate reads.
  const repairForCycle =
    cycle === 0
      ? initialRepair
      : cycle === 1 && deferredRepair.length > 0
        ? deferredRepair
        : transfer.repairPacketIndices;
  const sourceOrder = shuffledPacketIndices(transfer.sourcePacketIndices, random);
  const repairOrder = shuffledPacketIndices(repairForCycle, random);
  // Once the first pass has been shown, lead with symbols the receiver has
  // never seen. This keeps a cycle boundary from immediately replaying a long
  // run of source packets while the deferred repair pool is doing its job.
  if (cycle === 1 && deferredRepair.length > 0) {
    return [...repairOrder, ...sourceOrder];
  }
  return interleavePacketIndices(
    sourceOrder,
    repairOrder,
  );
}

function classifyRaptorQPackets(
  serializedPackets: readonly Uint8Array[],
  dataLength: number,
  maxTransportPayloadSize: number,
) {
  const sourceSymbolSize = maxTransportPayloadSize - RAPTORQ_PAYLOAD_ID_BYTES;
  if (!Number.isInteger(sourceSymbolSize) || sourceSymbolSize <= 0) {
    throw new RangeError(`Invalid RaptorQ transport payload size: ${maxTransportPayloadSize}`);
  }
  if (!Number.isInteger(dataLength) || dataLength < 0) {
    throw new RangeError(`Invalid RaptorQ data length: ${dataLength}`);
  }

  const totalSourceSymbols = Math.max(1, Math.ceil(dataLength / sourceSymbolSize));
  const sourceBlockCount = Math.max(
    1,
    Math.ceil(totalSourceSymbols / RAPTORQ_MAX_SOURCE_SYMBOLS_PER_BLOCK),
  );
  const largestBlockSourceCount = Math.ceil(totalSourceSymbols / sourceBlockCount);
  const smallestBlockSourceCount = largestBlockSourceCount - 1;
  const largerBlockCount =
    totalSourceSymbols - smallestBlockSourceCount * sourceBlockCount;
  const sourcePacketIndices: number[] = [];
  const repairPacketIndices: number[] = [];

  serializedPackets.forEach((payload, packetIndex) => {
    if (payload.length < RAPTORQ_PAYLOAD_ID_BYTES) {
      throw new Error(
        `RaptorQ packet ${packetIndex} is too short for a ${RAPTORQ_PAYLOAD_ID_BYTES}-byte Payload ID`,
      );
    }
    const sourceBlockNumber = payload[0];
    if (sourceBlockNumber >= sourceBlockCount) {
      throw new Error(
        `RaptorQ packet ${packetIndex} references source block ${sourceBlockNumber}, but the transfer has ${sourceBlockCount} source blocks`,
      );
    }
    const encodingSymbolId =
      ((payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
    const sourceCountForBlock =
      sourceBlockNumber < largerBlockCount
        ? largestBlockSourceCount
        : smallestBlockSourceCount;
    if (encodingSymbolId < sourceCountForBlock) {
      sourcePacketIndices.push(packetIndex);
    } else {
      repairPacketIndices.push(packetIndex);
    }
  });

  return { sourcePacketIndices, repairPacketIndices };
}

export function crc32Update(crc: number, bytes: Uint8Array) {
  let next = crc >>> 0;
  for (const byte of bytes) {
    next ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      next = (next >>> 1) ^ (0xedb88320 & -(next & 1));
    }
  }
  return next >>> 0;
}

export function crc32Finalize(crc: number) {
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(bytes: Uint8Array) {
  return crc32Finalize(crc32Update(0xffffffff, bytes));
}

function utf8Prefix(value: string, maximumBytes: number) {
  const bytes = textEncoder.encode(value);
  if (bytes.length <= maximumBytes) return bytes;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
}

function buildOpticalContainerFromMeta(
  transmitted: Uint8Array,
  options: {
    filename: string;
    mime?: string;
    compression: CompressionMode;
    fileSize: number;
    fileCrc: number;
  },
) {
  if (
    !Number.isInteger(options.fileSize) ||
    options.fileSize < 0 ||
    options.fileSize > MAX_FILE_BYTES ||
    transmitted.length > MAX_FILE_BYTES
  ) {
    throw new Error("This browser build supports files up to 512 MB.");
  }

  const filenameBytes = utf8Prefix(options.filename || "transfer.bin", 255);
  const mimeBytes = utf8Prefix(
    options.mime || "application/octet-stream",
    255,
  );
  const transmittedCrc = crc32(transmitted);
  const container = new Uint8Array(
    CONTAINER_HEADER_BYTES +
      filenameBytes.length +
      mimeBytes.length +
      transmitted.length,
  );
  const view = new DataView(container.buffer);
  container.set(CONTAINER_MAGIC, 0);
  container[4] =
    options.compression === "gzip"
      ? 1
      : options.compression === "brotli"
        ? 2
        : 0;
  container[5] = filenameBytes.length;
  container[6] = mimeBytes.length;
  view.setUint32(7, options.fileSize, true);
  view.setUint32(11, options.fileCrc >>> 0, true);
  view.setUint32(15, transmitted.length, true);
  view.setUint32(19, transmittedCrc, true);
  container.set(filenameBytes, CONTAINER_HEADER_BYTES);
  container.set(mimeBytes, CONTAINER_HEADER_BYTES + filenameBytes.length);
  container.set(
    transmitted,
    CONTAINER_HEADER_BYTES + filenameBytes.length + mimeBytes.length,
  );

  return {
    meta: {
      filename: textDecoder.decode(filenameBytes),
      mime: textDecoder.decode(mimeBytes),
      fileSize: options.fileSize,
      transmittedSize: transmitted.length,
      fileCrc: options.fileCrc >>> 0,
      transmittedCrc,
      compression: options.compression,
    },
    container,
  };
}

export function buildOpticalContainerFromMetadata(
  transmitted: Uint8Array,
  options: {
    filename: string;
    mime?: string;
    compression: CompressionMode;
    fileSize: number;
    fileCrc: number;
  },
) {
  return buildOpticalContainerFromMeta(transmitted, options);
}

/*
 * Keep the original-byte API for small callers and tests. Large Blob callers
 * can use buildOpticalContainerFromMetadata after computing the original CRC
 * while reading the file stream.
 */
export function buildOpticalContainer(
  original: Uint8Array,
  transmitted: Uint8Array,
  options: {
    filename: string;
    mime?: string;
    compression: CompressionMode;
  },
) {
  return buildOpticalContainerFromMeta(transmitted, {
    ...options,
    fileSize: original.length,
    fileCrc: crc32(original),
  });
}

export function parseOpticalContainer(container: Uint8Array): {
  meta: OpticalFileMeta;
  transmitted: Uint8Array;
} {
  if (container.length < CONTAINER_HEADER_BYTES) {
    throw new Error("Recovered transfer is missing its file header.");
  }
  for (let index = 0; index < CONTAINER_MAGIC.length; index += 1) {
    if (container[index] !== CONTAINER_MAGIC[index]) {
      throw new Error("Recovered transfer has an invalid file header.");
    }
  }

  const view = new DataView(
    container.buffer,
    container.byteOffset,
    container.byteLength,
  );
  const compression: CompressionMode =
    container[4] === 1 ? "gzip" : container[4] === 2 ? "brotli" : "none";
  const filenameLength = container[5];
  const mimeLength = container[6];
  const fileSize = view.getUint32(7, true);
  const fileCrc = view.getUint32(11, true);
  const transmittedSize = view.getUint32(15, true);
  const transmittedCrc = view.getUint32(19, true);
  const payloadOffset =
    CONTAINER_HEADER_BYTES + filenameLength + mimeLength;
  if (payloadOffset + transmittedSize !== container.length) {
    throw new Error("Recovered transfer length did not match its file header.");
  }

  const filename = textDecoder.decode(
    container.subarray(
      CONTAINER_HEADER_BYTES,
      CONTAINER_HEADER_BYTES + filenameLength,
    ),
  );
  const mime = textDecoder.decode(
    container.subarray(
      CONTAINER_HEADER_BYTES + filenameLength,
      payloadOffset,
    ),
  );
  const transmitted = container.slice(payloadOffset);
  if (crc32(transmitted) !== transmittedCrc) {
    throw new Error("Recovered optical payload failed its checksum.");
  }

  return {
    meta: {
      filename: filename || "transfer.bin",
      mime: mime || "application/octet-stream",
      fileSize,
      transmittedSize,
      fileCrc,
      transmittedCrc,
      compression,
    },
    transmitted,
  };
}

function serializeFrame(
  payload: Uint8Array,
  options: {
    session: number;
    containerLength: number;
    originalSize: number;
    compressed: boolean;
    symbolSize: number;
  },
) {
  if (payload.length !== options.symbolSize) {
    throw new Error("RaptorQ symbol length does not match the transfer profile.");
  }
  const frame = new Uint8Array(
    FRAME_HEADER_BYTES + payload.length + FRAME_CRC_BYTES,
  );
  const view = new DataView(frame.buffer);
  frame.set(FRAME_MAGIC, 0);
  frame[3] = options.compressed ? 1 : 0;
  view.setUint32(4, options.session, true);
  view.setUint32(8, options.containerLength, true);
  view.setUint32(12, options.originalSize, true);
  view.setUint16(16, options.symbolSize, true);
  frame[18] = 1; // protocol revision
  frame.set(payload, FRAME_HEADER_BYTES);
  view.setUint32(
    FRAME_HEADER_BYTES + payload.length,
    crc32(frame.subarray(0, FRAME_HEADER_BYTES + payload.length)),
    true,
  );
  return frame;
}

export function parseOpticalFrame(frame: Uint8Array): OpticalFrame {
  if (frame.length < OPTICAL_FRAME_OVERHEAD + 5) {
    throw new Error("Optical frame is too short.");
  }
  for (let index = 0; index < FRAME_MAGIC.length; index += 1) {
    if (frame[index] !== FRAME_MAGIC[index]) {
      throw new Error("This is not a QRFerry v4 optical frame.");
    }
  }
  if (frame[18] !== 1) throw new Error("Unsupported optical frame revision.");

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const symbolSize = view.getUint16(16, true);
  if (frame.length !== FRAME_HEADER_BYTES + symbolSize + FRAME_CRC_BYTES) {
    throw new Error("Optical frame length does not match its header.");
  }
  const expectedCrc = view.getUint32(FRAME_HEADER_BYTES + symbolSize, true);
  const actualCrc = crc32(frame.subarray(0, FRAME_HEADER_BYTES + symbolSize));
  if (expectedCrc !== actualCrc) {
    throw new Error("Optical frame checksum failed.");
  }

  return {
    session: view.getUint32(4, true),
    containerLength: view.getUint32(8, true),
    originalSize: view.getUint32(12, true),
    compressed: (frame[3] & 1) === 1,
    symbolSize,
    payload: frame.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + symbolSize),
  };
}

export async function createOpticalTransfer(
  prepared: PreparedOpticalFile,
  options: {
    symbolSize: number;
    repairPercent: number;
    /** Optional larger pool used to provide fresh repair symbols after pass 1. */
    repairPoolPercent?: number;
    profileKey?: string;
  },
): Promise<OpticalTransfer> {
  if (!Number.isInteger(options.symbolSize) || options.symbolSize < 128) {
    throw new Error("The optical symbol size is invalid.");
  }
  const session = crc32(prepared.container);
  const encoded = await encodeRaptorQPackets(
    prepared.container,
    options.symbolSize,
    Math.max(options.repairPercent, options.repairPoolPercent ?? options.repairPercent),
  );
  const classification = classifyRaptorQPackets(
    encoded,
    prepared.container.length,
    options.symbolSize,
  );
  const packets = encoded.map((payload) =>
    serializeFrame(payload, {
      session,
      containerLength: prepared.container.length,
      originalSize: prepared.meta.fileSize,
      compressed: prepared.meta.compression !== "none",
      symbolSize: options.symbolSize,
    }),
  );
  const initialRepairCount = Math.min(
    classification.repairPacketIndices.length,
    Math.max(
      0,
      Math.ceil(
        Math.max(1, Math.ceil(prepared.container.length / (options.symbolSize - 4))) *
          (options.repairPercent / 100),
      ),
    ),
  );
  const initialRepairPacketIndices = classification.repairPacketIndices.slice(
    0,
    initialRepairCount,
  );
  const deferredRepairPacketIndices = classification.repairPacketIndices.slice(
    initialRepairCount,
  );

  return {
    meta: prepared.meta,
    profileKey: options.profileKey ?? "unknown",
    session,
    containerLength: prepared.container.length,
    symbolSize: options.symbolSize,
    sourcePacketCount: Math.max(
      1,
      Math.ceil(prepared.container.length / (options.symbolSize - 4)),
    ),
    packets,
    initialRepairPacketIndices,
    deferredRepairPacketIndices,
    ...classification,
  };
}

export function raptorPacketKey(frame: OpticalFrame) {
  if (frame.payload.length < 4) throw new Error("RaptorQ payload ID is missing.");
  return `${frame.session}:${raptorPacketId(frame)}`;
}

/** The session is checked separately, so the four-byte Payload ID is enough. */
export function raptorPacketId(frame: OpticalFrame) {
  if (frame.payload.length < 4) throw new Error("RaptorQ payload ID is missing.");
  return (
    ((frame.payload[0] << 24) |
      (frame.payload[1] << 16) |
      (frame.payload[2] << 8) |
      frame.payload[3]) >>> 0
  );
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function formatRate(bytesPerSecond: number) {
  const megabitsPerSecond = (Math.max(0, bytesPerSecond) * 8) / 1_000_000;
  return `${megabitsPerSecond >= 1 ? megabitsPerSecond.toFixed(1) : megabitsPerSecond.toFixed(2)} Mbps`;
}
