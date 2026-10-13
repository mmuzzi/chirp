export type LaneSignature = {
  bits: Uint8Array;
  average: number;
};

const DEFAULT_GRID_SIZE = 12;

function luminance(data: Uint8ClampedArray, offset: number) {
  return (
    0.2126 * data[offset] +
    0.7152 * data[offset + 1] +
    0.0722 * data[offset + 2]
  );
}

/**
 * Sample a tiny normalized signature from a tracked QR crop. It is only a
 * gate: ZXing remains authoritative whenever the signature is ambiguous.
 */
export function sampleLaneSignature(
  image: ImageData,
  gridSize = DEFAULT_GRID_SIZE,
): LaneSignature {
  const bits = new Uint8Array(gridSize * gridSize);
  let total = 0;
  for (let row = 0; row < gridSize; row += 1) {
    const y = Math.min(
      image.height - 1,
      Math.floor(((row + 0.5) * image.height) / gridSize),
    );
    for (let column = 0; column < gridSize; column += 1) {
      const x = Math.min(
        image.width - 1,
        Math.floor(((column + 0.5) * image.width) / gridSize),
      );
      const value = luminance(image.data, (y * image.width + x) * 4);
      bits[row * gridSize + column] = value >= 128 ? 1 : 0;
      total += value;
    }
  }
  return { bits, average: total / bits.length };
}

/**
 * Return true only when there is strong evidence that the lane changed.
 * Conservative thresholds intentionally prefer an extra decode over a miss.
 */
export function laneSignatureChanged(
  previous: LaneSignature | undefined,
  next: LaneSignature,
) {
  if (!previous || previous.bits.length !== next.bits.length) return true;
  let differentBits = 0;
  for (let index = 0; index < next.bits.length; index += 1) {
    differentBits += previous.bits[index] === next.bits[index] ? 0 : 1;
  }
  const bitDifference = differentBits / next.bits.length;
  const averageDifference = Math.abs(previous.average - next.average);
  return bitDifference > 0.02 || averageDifference > 12;
}
