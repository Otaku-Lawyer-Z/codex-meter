import test from "node:test";
import assert from "node:assert/strict";
import {
  clampPercent,
  durationLabel,
  formatCountdown,
  formatCompactNumber,
  formatFullNumber,
  normalizeDashboardData,
} from "../src/lib/normalize.mjs";

test("clampPercent clamps invalid and out-of-range values", () => {
  assert.equal(clampPercent(-2), 0);
  assert.equal(clampPercent(47.6), 48);
  assert.equal(clampPercent(120), 100);
  assert.equal(clampPercent("not-a-number"), 0);
});

test("durationLabel recognizes common Codex windows", () => {
  assert.equal(durationLabel(300), "5 小时额度");
  assert.equal(durationLabel(10080), "7 天额度");
  assert.equal(durationLabel(1440), "1 天额度");
  assert.equal(durationLabel(null), "额度周期");
});

test("normalizeDashboardData preserves multiple buckets and reset details", () => {
  const now = 1_800_000_000_000;
  const result = normalizeDashboardData(
    {
      rateLimits: {},
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          limitName: "Spark",
          primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1800003600 },
          planType: "prolite",
        },
        codex: {
          limitId: "codex",
          primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1800001800 },
          planType: "plus",
        },
      },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{ title: "Full reset", status: "available", grantedAt: 1790000000, expiresAt: 1810000000 }],
      },
    },
    {
      summary: { lifetimeTokens: 1234, currentStreakDays: 4 },
      dailyUsageBuckets: [{ startDate: "2026-07-20", tokens: 500 }],
    },
    now,
  );

  assert.equal(result.limits[0].id, "codex");
  assert.equal(result.limits[0].windows[0].remainingPercent, 89);
  assert.equal(result.limits[0].windows[0].label, "5 小时额度");
  assert.equal(result.limits[1].name, "Spark");
  assert.equal(result.resetCredits.availableCount, 1);
  assert.equal(result.resetCredits.credits[0].expiresAt, 1_810_000_000_000);
  assert.equal(result.usage.lifetimeTokens, 1234);
  assert.equal(result.usage.daily[0].tokens, 500);
  assert.equal(result.fetchedAt, now);
});

test("formatCountdown produces stable Chinese countdowns", () => {
  const now = 1_800_000_000_000;
  assert.equal(formatCountdown(now + (2 * 1440 + 3 * 60 + 4) * 60_000, now), "2 天 3 小时 4 分");
  assert.equal(formatCountdown(now - 1, now), "正在重置");
});

test("missing token values are not rendered as zero", () => {
  const result = normalizeDashboardData({ rateLimitsByLimitId: {} }, null);
  assert.equal(result.usage.lifetimeTokens, null);
  assert.equal(formatCompactNumber(null), "—");
  assert.equal(formatFullNumber(undefined), "—");
});
