const PLAN_LABELS = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro",
  team: "Team",
  business: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Education",
  unknown: "未知套餐",
};

const KNOWN_LIMIT_NAMES = {
  codex: "Codex",
  codex_bengalfox: "GPT-5.3-Codex-Spark",
};

export function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number)));
}

export function durationLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "额度周期";
  if (value === 300) return "5 小时额度";
  if (value === 10080) return "7 天额度";
  if (value % 10080 === 0) return `${value / 10080} 周额度`;
  if (value % 1440 === 0) return `${value / 1440} 天额度`;
  if (value % 60 === 0) return `${value / 60} 小时额度`;
  return `${value} 分钟额度`;
}

function normalizeWindow(window, kind) {
  if (!window) return null;
  const usedPercent = clampPercent(window.usedPercent);
  const resetsAtSeconds = Number(window.resetsAt);
  return {
    kind,
    label: durationLabel(window.windowDurationMins),
    durationMins: Number(window.windowDurationMins) || null,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: Number.isFinite(resetsAtSeconds) ? resetsAtSeconds * 1000 : null,
  };
}

function normalizeSnapshot(snapshot, fallbackId = "codex") {
  const id = snapshot?.limitId || fallbackId;
  const windows = [
    normalizeWindow(snapshot?.primary, "primary"),
    normalizeWindow(snapshot?.secondary, "secondary"),
  ].filter(Boolean);

  return {
    id,
    name: snapshot?.limitName || KNOWN_LIMIT_NAMES[id] || id,
    plan: PLAN_LABELS[snapshot?.planType] || snapshot?.planType || "未知套餐",
    reachedType: snapshot?.rateLimitReachedType || null,
    creditBalance: snapshot?.credits?.balance ?? null,
    hasCredits: Boolean(snapshot?.credits?.hasCredits),
    unlimitedCredits: Boolean(snapshot?.credits?.unlimited),
    windows,
  };
}

function normalizeResetCredits(summary) {
  const credits = Array.isArray(summary?.credits) ? summary.credits : [];
  return {
    availableCount: Math.max(0, Number(summary?.availableCount) || 0),
    credits: credits.map((credit) => ({
      title: credit.title || "完整额度重置",
      description: credit.description || "可用于重置 Codex 额度。",
      status: credit.status || "unknown",
      grantedAt: Number(credit.grantedAt) ? Number(credit.grantedAt) * 1000 : null,
      expiresAt: Number(credit.expiresAt) ? Number(credit.expiresAt) * 1000 : null,
      resetType: credit.resetType || "unknown",
    })),
  };
}

function normalizeUsage(payload) {
  const summary = payload?.summary || {};
  const daily = Array.isArray(payload?.dailyUsageBuckets)
    ? payload.dailyUsageBuckets
        .filter((bucket) => bucket?.startDate && Number.isFinite(Number(bucket?.tokens)))
        .map((bucket) => ({
          date: bucket.startDate,
          tokens: Math.max(0, Number(bucket.tokens)),
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
    : [];

  return {
    lifetimeTokens: numberOrNull(summary.lifetimeTokens),
    peakDailyTokens: numberOrNull(summary.peakDailyTokens),
    longestRunningTurnSec: numberOrNull(summary.longestRunningTurnSec),
    currentStreakDays: numberOrNull(summary.currentStreakDays),
    longestStreakDays: numberOrNull(summary.longestStreakDays),
    daily,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeDashboardData(ratePayload, usagePayload, now = Date.now()) {
  const map = ratePayload?.rateLimitsByLimitId;
  let limits;

  if (map && typeof map === "object" && Object.keys(map).length > 0) {
    limits = Object.entries(map).map(([id, snapshot]) => normalizeSnapshot(snapshot, id));
  } else if (ratePayload?.rateLimits) {
    limits = [normalizeSnapshot(ratePayload.rateLimits)];
  } else {
    limits = [];
  }

  limits.sort((a, b) => {
    if (a.id === "codex") return -1;
    if (b.id === "codex") return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    limits,
    resetCredits: normalizeResetCredits(ratePayload?.rateLimitResetCredits),
    usage: normalizeUsage(usagePayload),
    fetchedAt: now,
  };
}

export function formatCompactNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function formatFullNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("zh-CN").format(Number(value));
}

export function formatDateTime(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Number(timestamp)));
}

export function formatCountdown(timestamp, now = Date.now()) {
  if (!Number.isFinite(Number(timestamp))) return "等待服务器信息";
  const diff = Number(timestamp) - now;
  if (diff <= 0) return "正在重置";

  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${Math.max(1, minutes)} 分钟`;
}
