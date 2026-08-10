import type { EnvironmentId } from "@t3tools/contracts";

export const WEBRTC_FAST_PATH_COOLDOWN_MS = 30_000;

export class WebRtcFastPathCooldown {
  readonly #cooldownMs: number;
  readonly #untilByEnvironment = new Map<EnvironmentId, number>();

  constructor(cooldownMs = WEBRTC_FAST_PATH_COOLDOWN_MS) {
    this.#cooldownMs = cooldownMs;
  }

  isActive(environmentId: EnvironmentId, nowMs: number): boolean {
    const untilMs = this.#untilByEnvironment.get(environmentId);
    if (untilMs === undefined) {
      return false;
    }
    if (nowMs >= untilMs) {
      this.#untilByEnvironment.delete(environmentId);
      return false;
    }
    return true;
  }

  start(environmentId: EnvironmentId, nowMs: number): void {
    this.#untilByEnvironment.set(environmentId, nowMs + this.#cooldownMs);
  }
}
