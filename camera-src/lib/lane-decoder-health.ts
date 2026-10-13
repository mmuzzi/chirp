export type LanePair = readonly [number, number];

export type LaneDecoderHealth = {
  ready: boolean;
  quarantine: boolean;
  minAttempts: number;
  weakestLaneSuccessRate: number;
  fallbackRate: number;
  reason: "probing" | "healthy" | "low-success" | "fallback-storm";
};

export const LANE_HEALTH_MIN_ATTEMPTS = 8;
export const LANE_HEALTH_MIN_SUCCESS_RATE = 0.5;
export const LANE_HEALTH_MAX_FALLBACK_RATE = 0.5;

/**
 * Decide whether tracked decoding has earned the right to stay on the hot
 * path. The conservative side wins: before enough observations, keep trying;
 * after a poor probe window, quarantine the optimization and preserve the
 * combined decoder as the correctness path.
 */
export function evaluateLaneDecoderHealth(
  attempts: LanePair,
  successes: LanePair,
  fallbacks: number,
): LaneDecoderHealth {
  const minAttempts = Math.min(attempts[0], attempts[1]);
  if (minAttempts < LANE_HEALTH_MIN_ATTEMPTS) {
    return {
      ready: false,
      quarantine: false,
      minAttempts,
      weakestLaneSuccessRate: 0,
      fallbackRate: 0,
      reason: "probing",
    };
  }

  const weakestLaneSuccessRate = Math.min(
    successes[0] / Math.max(1, attempts[0]),
    successes[1] / Math.max(1, attempts[1]),
  );
  const fallbackRate = fallbacks / Math.max(1, minAttempts);
  if (weakestLaneSuccessRate < LANE_HEALTH_MIN_SUCCESS_RATE) {
    return {
      ready: true,
      quarantine: true,
      minAttempts,
      weakestLaneSuccessRate,
      fallbackRate,
      reason: "low-success",
    };
  }
  if (fallbackRate > LANE_HEALTH_MAX_FALLBACK_RATE) {
    return {
      ready: true,
      quarantine: true,
      minAttempts,
      weakestLaneSuccessRate,
      fallbackRate,
      reason: "fallback-storm",
    };
  }
  return {
    ready: true,
    quarantine: false,
    minAttempts,
    weakestLaneSuccessRate,
    fallbackRate,
    reason: "healthy",
  };
}
