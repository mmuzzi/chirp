import type { QrPosition } from "./qr-scanner";

export type AffineTransform = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

/** A 3x3 projective transform in row-major form. */
export type ProjectiveTransform = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
  i: number;
};

export type QrRectifier = {
  outputSize: number;
  projectiveError: number;
  perspective: boolean;
  sourceBounds: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  /** Full transform used for coordinate mapping after a decoded crop. */
  sourceToRectified: ProjectiveTransform;
  rectifiedToSource: ProjectiveTransform;
  /** Fast Canvas2D path for rotations and near-parallelograms. */
  affineSourceToRectified: AffineTransform;
};

function distance(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function applyProjective(
  transform: ProjectiveTransform,
  point: { x: number; y: number },
) {
  const denominator = transform.g * point.x + transform.h * point.y + transform.i;
  if (Math.abs(denominator) < 0.0000001) {
    return { x: Number.NaN, y: Number.NaN };
  }
  return {
    x:
      (transform.a * point.x + transform.c * point.y + transform.e) /
      denominator,
    y:
      (transform.b * point.x + transform.d * point.y + transform.f) /
      denominator,
  };
}

function invertProjective(transform: ProjectiveTransform): ProjectiveTransform | undefined {
  const {
    a,
    b,
    c,
    d,
    e,
    f,
    g,
    h,
    i,
  } = transform;
  const determinant =
    a * (d * i - f * h) - c * (b * i - f * g) + e * (b * h - d * g);
  if (Math.abs(determinant) < 0.0000001) return undefined;
  const inverse: ProjectiveTransform = {
    a: (d * i - f * h) / determinant,
    b: (f * g - b * i) / determinant,
    c: (e * h - c * i) / determinant,
    d: (a * i - e * g) / determinant,
    e: (c * f - e * d) / determinant,
    f: (e * b - a * f) / determinant,
    g: (b * h - d * g) / determinant,
    h: (c * g - a * h) / determinant,
    i: (a * d - c * b) / determinant,
  };
  // Normalize so a map composed with its inverse remains numerically stable
  // for the small coordinates used by the scan canvas.
  if (Math.abs(inverse.i) > 0.0000001) {
    const scale = inverse.i;
    return Object.fromEntries(
      Object.entries(inverse).map(([key, value]) => [key, value / scale]),
    ) as ProjectiveTransform;
  }
  return inverse;
}

function solveHomography(
  source: Array<{ x: number; y: number }>,
  destination: Array<{ x: number; y: number }>,
): ProjectiveTransform | undefined {
  // Solve the standard eight-parameter homography system with h22 fixed to 1.
  // This runs once per tracked lock, not once per decoded pixel.
  const matrix = Array.from({ length: 8 }, () => Array(9).fill(0));
  for (let index = 0; index < 4; index += 1) {
    const sourcePoint = source[index];
    const destinationPoint = destination[index];
    if (!sourcePoint || !destinationPoint) return undefined;
    const x = sourcePoint.x;
    const y = sourcePoint.y;
    const u = destinationPoint.x;
    const v = destinationPoint.y;
    const row = index * 2;
    matrix[row] = [x, y, 1, 0, 0, 0, -u * x, -u * y, u];
    matrix[row + 1] = [0, 0, 0, x, y, 1, -v * x, -v * y, v];
  }

  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot][column]) < 0.0000001) return undefined;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const pivotValue = matrix[column][column];
    for (let entry = column; entry <= 8; entry += 1) {
      matrix[column][entry] /= pivotValue;
    }
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      if (Math.abs(factor) < 0.0000001) continue;
      for (let entry = column; entry <= 8; entry += 1) {
        matrix[row][entry] -= factor * matrix[column][entry];
      }
    }
  }

  return {
    a: matrix[0][8],
    b: matrix[3][8],
    c: matrix[1][8],
    d: matrix[4][8],
    e: matrix[2][8],
    f: matrix[5][8],
    g: matrix[6][8],
    h: matrix[7][8],
    i: 1,
  };
}

function createAffineApproximation(
  topLeft: { x: number; y: number },
  topRight: { x: number; y: number },
  bottomLeft: { x: number; y: number },
  outputSize: number,
): AffineTransform | undefined {
  const sourceA = topRight.x - topLeft.x;
  const sourceB = topRight.y - topLeft.y;
  const sourceC = bottomLeft.x - topLeft.x;
  const sourceD = bottomLeft.y - topLeft.y;
  const determinant = sourceA * sourceD - sourceB * sourceC;
  if (Math.abs(determinant) < 0.000001) return undefined;
  const transform: AffineTransform = {
    a: (sourceD / determinant) * outputSize,
    b: (-sourceB / determinant) * outputSize,
    c: (-sourceC / determinant) * outputSize,
    d: (sourceA / determinant) * outputSize,
    e: 0,
    f: 0,
  };
  transform.e = -transform.a * topLeft.x - transform.c * topLeft.y;
  transform.f = -transform.b * topLeft.x - transform.d * topLeft.y;
  return transform;
}

/**
 * Build a tracked QR deskew transform. ZXing remains authoritative for
 * acquisition; this path only rectifies a crop after a stable lock.
 */
export function createQrRectifier(
  position: QrPosition,
  sourceWidth: number,
  sourceHeight: number,
  marginScale = 1.18,
): QrRectifier | undefined {
  const points = [
    position.topLeft,
    position.topRight,
    position.bottomLeft,
    position.bottomRight,
  ];
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const expanded = points.map((point) => ({
    x: Math.min(
      sourceWidth - 1,
      Math.max(0, center.x + (point.x - center.x) * marginScale),
    ),
    y: Math.min(
      sourceHeight - 1,
      Math.max(0, center.y + (point.y - center.y) * marginScale),
    ),
  }));
  const [topLeft, topRight, bottomLeft, bottomRight] = expanded;
  if (!topLeft || !topRight || !bottomLeft || !bottomRight) return undefined;

  const horizontal = Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight));
  const vertical = Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight));
  if (horizontal < 8 || vertical < 8) return undefined;

  const predictedBottomRight = {
    x: topRight.x + bottomLeft.x - topLeft.x,
    y: topRight.y + bottomLeft.y - topLeft.y,
  };
  const projectiveError =
    distance(predictedBottomRight, bottomRight) / Math.max(horizontal, vertical);
  // A very extreme or clipped quadrilateral is more likely to be a stale
  // track than a useful crop. Reacquire through the normal full-frame path.
  if (projectiveError > 0.24) return undefined;

  // V40 has roughly two modules per pixel at this size on the negotiated
  // iPhone camera. Keeping one fixed backing size avoids resizing the crop
  // canvas as corner jitter crosses a threshold, and makes the common affine
  // path materially cheaper than the old 512px crop.
  const outputSize = 384;
  const sourceToRectified = solveHomography(
    [topLeft, topRight, bottomLeft, bottomRight],
    [
      { x: 0, y: 0 },
      { x: outputSize, y: 0 },
      { x: 0, y: outputSize },
      { x: outputSize, y: outputSize },
    ],
  );
  const affineSourceToRectified = createAffineApproximation(
    topLeft,
    topRight,
    bottomLeft,
    outputSize,
  );
  if (!sourceToRectified || !affineSourceToRectified) return undefined;
  const rectifiedToSource = invertProjective(sourceToRectified);
  if (!rectifiedToSource) return undefined;

  const left = Math.max(0, Math.floor(Math.min(...expanded.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...expanded.map((point) => point.y))));
  const right = Math.min(sourceWidth, Math.ceil(Math.max(...expanded.map((point) => point.x))));
  const bottom = Math.min(sourceHeight, Math.ceil(Math.max(...expanded.map((point) => point.y))));
  if (right - left < 8 || bottom - top < 8) return undefined;

  return {
    outputSize,
    projectiveError,
    // Small corner noise is not enough evidence to justify the O(n²) CPU
    // homography warp. Reserve it for a visibly trapezoidal crop.
    perspective: projectiveError > 0.08,
    sourceBounds: { left, top, width: right - left, height: bottom - top },
    sourceToRectified,
    rectifiedToSource,
    affineSourceToRectified,
  };
}

export function mapQrPosition(
  position: QrPosition,
  transform: ProjectiveTransform,
): QrPosition {
  return {
    topLeft: applyProjective(transform, position.topLeft),
    topRight: applyProjective(transform, position.topRight),
    bottomLeft: applyProjective(transform, position.bottomLeft),
    bottomRight: applyProjective(transform, position.bottomRight),
  };
}

export function mapRectifiedPoint(
  transform: QrRectifier,
  point: { x: number; y: number },
) {
  return applyProjective(transform.rectifiedToSource, point);
}

/**
 * CPU fallback for a projective crop. It is only used for a trapezoid; the
 * common rotation/near-square case stays on the cheap Canvas2D affine path.
 * Nearest-neighbour sampling preserves the QR module edges.
 */
export function warpPerspectiveQr(
  source: ImageData,
  rectifier: QrRectifier,
  sourceOffsetX: number,
  sourceOffsetY: number,
): ImageData {
  const size = rectifier.outputSize;
  const output = new Uint8ClampedArray(size * size * 4);
  output.fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourcePoint = mapRectifiedPoint(rectifier, {
        x: x + 0.5,
        y: y + 0.5,
      });
      const sourceX = Math.round(sourcePoint.x - sourceOffsetX);
      const sourceY = Math.round(sourcePoint.y - sourceOffsetY);
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >= source.width ||
        sourceY >= source.height
      ) {
        continue;
      }
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const outputOffset = (y * size + x) * 4;
      output[outputOffset] = source.data[sourceOffset] ?? 255;
      output[outputOffset + 1] = source.data[sourceOffset + 1] ?? 255;
      output[outputOffset + 2] = source.data[sourceOffset + 2] ?? 255;
      output[outputOffset + 3] = 255;
    }
  }
  return new ImageData(output, size, size);
}
