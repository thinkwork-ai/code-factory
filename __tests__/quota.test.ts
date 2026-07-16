/**
 * Quota classifier + cooldown window (U6, R14 / AE8). A simulated clock drives
 * both the store's `ended_at` stamping and the classifier's `now`, so no test
 * depends on wall-clock time.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStore, type FactoryStore } from "../src/store/db.js";
import { classifyQuota, quotaResumeKey } from "../src/sweep/quota.js";

let dir: string;
let store: FactoryStore;
/** Mutable simulated clock shared with the store (controls ended_at stamps). */
let clockNow: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factory-quota-test-"));
  clockNow = new Date("2026-07-12T00:00:00.000Z");
  store = openStore(dir, () => clockNow);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const at = (base: Date, minutes: number): Date =>
  new Date(base.getTime() + minutes * 60_000);

function insertQuotaCooldown(issueId: string, endedAt: Date): void {
  const id = store.insertAttempt({
    issueId,
    phase: "implement",
    attemptNumber: 1,
    state: "Running",
  });
  clockNow = endedAt; // ended_at is stamped from the store clock
  store.transitionAttempt(id, "QuotaCooldown", "provider rate-limit");
}

describe("classifyQuota — cooldown window (AE8)", () => {
  it("is `clear` when there is no terminal attempt", () => {
    expect(classifyQuota(store, "iss_none", clockNow).kind).toBe("clear");
  });

  it("is `clear` when the latest terminal attempt is not a QuotaCooldown", () => {
    const id = store.insertAttempt({
      issueId: "iss_ok",
      phase: "implement",
      attemptNumber: 1,
      state: "Running",
    });
    store.transitionAttempt(id, "Succeeded", "merged");
    expect(classifyQuota(store, "iss_ok", clockNow).kind).toBe("clear");
  });

  it("is `cooldown` (with an until) while inside the window", () => {
    const ended = new Date("2026-07-12T01:00:00.000Z");
    insertQuotaCooldown("iss_q", ended);

    const verdict = classifyQuota(store, "iss_q", at(ended, 10), [30]);
    expect(verdict.kind).toBe("cooldown");
    if (verdict.kind === "cooldown") {
      expect(verdict.until.toISOString()).toBe(at(ended, 30).toISOString());
    }
  });

  it("no kill/relaunch during cooldown — the classifier never touches the worker", () => {
    // (There is no worker to kill: QuotaCooldown is terminal. This asserts the
    // classifier is a pure read — the attempt row is unchanged after classify.)
    const ended = new Date("2026-07-12T01:00:00.000Z");
    insertQuotaCooldown("iss_q", ended);
    const before = store.getLatestTerminalAttempt("iss_q");
    classifyQuota(store, "iss_q", at(ended, 5), [30]);
    const after = store.getLatestTerminalAttempt("iss_q");
    expect(after).toEqual(before);
  });

  it("becomes `clear` (retry) PAST the window while tiers remain", () => {
    const ended = new Date("2026-07-12T01:00:00.000Z");
    insertQuotaCooldown("iss_q", ended);

    // At exactly the window edge it is still cooling (strict <); past it the
    // verdict clears so the engine's normal routing performs the retry.
    expect(classifyQuota(store, "iss_q", at(ended, 29), [30]).kind).toBe(
      "cooldown",
    );
    expect(classifyQuota(store, "iss_q", at(ended, 30), [30]).kind).toBe(
      "clear",
    );
    expect(classifyQuota(store, "iss_q", at(ended, 120), [30]).kind).toBe(
      "clear",
    );
  });

  it("only the NEWEST terminal attempt governs (a later Succeeded clears an earlier cooldown)", () => {
    const ended = new Date("2026-07-12T01:00:00.000Z");
    insertQuotaCooldown("iss_q", ended);
    // A later attempt succeeds — the newest terminal is now Succeeded.
    const id2 = store.insertAttempt({
      issueId: "iss_q",
      phase: "implement",
      attemptNumber: 2,
      state: "Running",
    });
    store.transitionAttempt(id2, "Succeeded", "merged");
    expect(classifyQuota(store, "iss_q", at(ended, 5), [30]).kind).toBe("clear");
  });
});

// ---------------------------------------------------------------------------
// Tiered backoff + operator resume (quota-tiers)
// ---------------------------------------------------------------------------

describe("classifyQuota — tiered backoff", () => {
  function quotaHit(issueId: string, n: number, endedAt: Date): void {
    const id = store.insertAttempt({
      issueId,
      phase: "implement",
      attemptNumber: n,
      state: "Running",
    });
    clockNow = endedAt;
    store.transitionAttempt(id, "QuotaCooldown", "provider rate-limit");
  }

  it("streak 1 uses the first tier, streak 2 the second, streak 3 the third", () => {
    const t0 = new Date("2026-07-12T01:00:00.000Z");
    quotaHit("iss_t", 1, t0);
    let v = classifyQuota(store, "iss_t", at(t0, 1), [5, 15, 30]);
    expect(v).toMatchObject({ kind: "cooldown", streak: 1, windowMinutes: 5 });

    const t1 = at(t0, 6);
    quotaHit("iss_t", 2, t1);
    v = classifyQuota(store, "iss_t", at(t1, 1), [5, 15, 30]);
    expect(v).toMatchObject({ kind: "cooldown", streak: 2, windowMinutes: 15 });
    if (v.kind === "cooldown") {
      expect(v.until.toISOString()).toBe(at(t1, 15).toISOString());
    }

    const t2 = at(t1, 16);
    quotaHit("iss_t", 3, t2);
    v = classifyQuota(store, "iss_t", at(t2, 1), [5, 15, 30]);
    expect(v).toMatchObject({ kind: "cooldown", streak: 3, windowMinutes: 30 });
  });

  it("a streak beyond the last tier is `exhausted` (escalate, don't retry)", () => {
    const t0 = new Date("2026-07-12T01:00:00.000Z");
    quotaHit("iss_x", 1, t0);
    quotaHit("iss_x", 2, at(t0, 10));
    quotaHit("iss_x", 3, at(t0, 30));
    quotaHit("iss_x", 4, at(t0, 70));
    const v = classifyQuota(store, "iss_x", at(t0, 71), [5, 15, 30]);
    expect(v).toMatchObject({ kind: "exhausted", streak: 4 });
  });

  it("a non-quota terminal attempt resets the streak", () => {
    const t0 = new Date("2026-07-12T01:00:00.000Z");
    quotaHit("iss_r", 1, t0);
    quotaHit("iss_r", 2, at(t0, 10));
    const ok = store.insertAttempt({
      issueId: "iss_r",
      phase: "implement",
      attemptNumber: 3,
      state: "Running",
    });
    clockNow = at(t0, 30);
    store.transitionAttempt(ok, "Succeeded", "merged");
    quotaHit("iss_r", 4, at(t0, 40));
    const v = classifyQuota(store, "iss_r", at(t0, 41), [5, 15, 30]);
    expect(v).toMatchObject({ kind: "cooldown", streak: 1, windowMinutes: 5 });
  });

  it("the resume marker clears an active cooldown AND resets the streak", () => {
    const t0 = new Date("2026-07-12T01:00:00.000Z");
    quotaHit("iss_m", 1, t0);
    quotaHit("iss_m", 2, at(t0, 10));
    expect(classifyQuota(store, "iss_m", at(t0, 11), [5, 15, 30]).kind).toBe(
      "cooldown",
    );
    store.setMeta(quotaResumeKey("iss_m"), at(t0, 12).toISOString());
    expect(classifyQuota(store, "iss_m", at(t0, 13), [5, 15, 30]).kind).toBe(
      "clear",
    );
    // A NEW quota hit after the marker starts a fresh streak at tier 1.
    quotaHit("iss_m", 3, at(t0, 20));
    const v = classifyQuota(store, "iss_m", at(t0, 21), [5, 15, 30]);
    expect(v).toMatchObject({ kind: "cooldown", streak: 1, windowMinutes: 5 });
  });

  it("the resume marker also clears an exhausted streak", () => {
    const t0 = new Date("2026-07-12T01:00:00.000Z");
    for (let n = 1; n <= 4; n++) quotaHit("iss_e", n, at(t0, n * 10));
    expect(classifyQuota(store, "iss_e", at(t0, 41), [5, 15, 30]).kind).toBe(
      "exhausted",
    );
    store.setMeta(quotaResumeKey("iss_e"), at(t0, 42).toISOString());
    expect(classifyQuota(store, "iss_e", at(t0, 43), [5, 15, 30]).kind).toBe(
      "clear",
    );
  });
});
