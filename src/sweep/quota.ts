/**
 * Quota classifier + tiered cooldown windows (U6, R14 / AE8 / KTD-9).
 *
 * A provider rate-limit signal lands an attempt in the terminal `QuotaCooldown`
 * state (classified by the runner adapter — driveAttempt in workers/attempts.ts
 * — NOT here; this module never kills a worker). Once cooled, the naive engine
 * would relaunch on the very next tick — a 30s retry hammer against a
 * throttling provider. This module surfaces a tiered-backoff verdict so
 * `decideAction` can:
 *
 *   - return `wait` while the latest attempt is `QuotaCooldown` AND now is
 *     still inside its tier's window (default tiers: 5 → 15 → 30 minutes,
 *     selected by the CONSECUTIVE QuotaCooldown streak);
 *   - route normally (retry) once the window elapses — an expired window is a
 *     retry, not an escalation: each retry that hits quota again advances the
 *     streak and widens the next window;
 *   - escalate (block) only once the streak EXHAUSTS the tier table — every
 *     tier was waited out and the provider still throttled (AE8: "no
 *     kill/relaunch escalation fires unless the cooldown window is exceeded").
 *
 * The operator short-circuits any verdict with the Slack `resume` verb, which
 * stamps a resume marker (meta `quota-resume:<issueId>`): attempts that ended
 * at or before the marker are invisible to this classifier, so the next tick
 * retries immediately with a reset streak.
 *
 * Pure over an injected `now` — no clock, no I/O beyond the store reads.
 */

import type { AttemptRow, FactoryStore } from "../store/db.js";

/**
 * Default cooldown tiers, in minutes: streak 1 waits tiers[0], streak 2 waits
 * tiers[1], … A streak beyond the last tier escalates instead of waiting.
 */
export const DEFAULT_QUOTA_COOLDOWN_TIERS: readonly number[] = [5, 15, 30];

/** Meta key carrying the operator's `resume` marker for one issue. */
export function quotaResumeKey(issueId: string): string {
  return `quota-resume:${issueId}`;
}

/**
 * Streaks are counted over at most this many recent terminal attempts. The
 * bound only matters past tiers.length (already escalation territory), so it
 * just keeps the read small.
 */
const STREAK_SCAN_LIMIT = 20;

export type QuotaVerdict =
  /** Latest attempt is not a quota cooldown — quota does not constrain routing. */
  | { kind: "clear" }
  /** Cooling down: still inside this tier's window. decideAction should `wait`. */
  | {
      kind: "cooldown";
      until: Date;
      endedAt: Date;
      /** Consecutive QuotaCooldown attempts, 1-based (this one included). */
      streak: number;
      /** This tier's window, minutes. */
      windowMinutes: number;
      /** Total number of tiers, for "tier 2/3" rendering. */
      tierCount: number;
    }
  /** Every tier was waited out and quota still hit: escalate, don't retry. */
  | { kind: "exhausted"; endedAt: Date; streak: number };

/**
 * The most-recent terminal attempt for an issue, or undefined when the issue
 * has no settled attempts yet. Exposed for the sweep classifier and tests.
 */
export function latestTerminalAttempt(
  store: FactoryStore,
  issueId: string,
): AttemptRow | undefined {
  return store.getLatestTerminalAttempt(issueId);
}

/**
 * The operator's resume marker for an issue, or null. Exposed for the Slack
 * `resume` executor (which writes it) and tests.
 */
export function quotaResumeMarker(store: FactoryStore, issueId: string): Date | null {
  const raw = store.getMeta(quotaResumeKey(issueId));
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Classify quota state for an issue from its newest terminal attempts.
 * `now`/`tiers` are injected so timer behaviour is deterministic under a
 * simulated clock.
 */
export function classifyQuota(
  store: FactoryStore,
  issueId: string,
  now: Date,
  tiers: readonly number[] = DEFAULT_QUOTA_COOLDOWN_TIERS,
): QuotaVerdict {
  const recent = store.listRecentTerminalAttempts(issueId, STREAK_SCAN_LIMIT);
  const latest = recent[0];
  if (latest === undefined || latest.state !== "QuotaCooldown") {
    return { kind: "clear" };
  }
  // A QuotaCooldown attempt always stamps ended_at (terminal transition), but
  // treat a missing timestamp as "just now" (fail toward waiting, never toward
  // an immediate retry hammer).
  const endedAt = latest.ended_at !== null ? new Date(latest.ended_at) : now;
  // Operator resume: attempts settled at or before the marker are invisible.
  const marker = quotaResumeMarker(store, issueId);
  if (marker !== null && endedAt.getTime() <= marker.getTime()) {
    return { kind: "clear" };
  }
  // Consecutive QuotaCooldown streak, newest-first, stopping at the first
  // non-quota terminal attempt or at the resume marker (a resume resets it).
  let streak = 0;
  for (const attempt of recent) {
    if (attempt.state !== "QuotaCooldown") break;
    const attemptEndedAt =
      attempt.ended_at !== null ? new Date(attempt.ended_at) : now;
    if (marker !== null && attemptEndedAt.getTime() <= marker.getTime()) break;
    streak += 1;
  }
  const effectiveTiers = tiers.length > 0 ? tiers : DEFAULT_QUOTA_COOLDOWN_TIERS;
  if (streak > effectiveTiers.length) {
    return { kind: "exhausted", endedAt, streak };
  }
  const windowMinutes = effectiveTiers[streak - 1]!;
  const until = new Date(endedAt.getTime() + windowMinutes * 60_000);
  if (now.getTime() < until.getTime()) {
    return {
      kind: "cooldown",
      until,
      endedAt,
      streak,
      windowMinutes,
      tierCount: effectiveTiers.length,
    };
  }
  // Window elapsed within the tier table: clear → the engine routes normally
  // and the next launch is the retry.
  return { kind: "clear" };
}
