/**
 * `expiresIn: "4h"` rather than an ISO timestamp the caller has to compute.
 *
 * Milliseconds are accepted too, because a number is what a timer takes and
 * making somebody write `"3600000ms"` would be the kind of ceremony this SDK
 * exists to remove.
 */
export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function durationMs(value: Duration): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new TypeError(
      `Could not read "${value}" as a duration. Use a number of milliseconds, or a string like "30m", "4h" or "2d".`
    );
  }
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
}
