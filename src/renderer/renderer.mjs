const api = window.codexMeter;

const nodes = Object.fromEntries(
  [
    "connection-pill", "connection-text", "updated-at", "error-banner", "error-message",
    "pin-button", "refresh-button", "settings-button", "settings-popover", "login-toggle",
    "interval-select", "hero-limit-name", "plan-badge", "hero-meter", "hero-remaining",
    "hero-window-label", "hero-countdown", "hero-reset-time", "hero-used", "hero-remain-small",
    "reset-count", "lifetime-tokens", "lifetime-detail", "streak-days", "streak-detail",
    "peak-tokens", "usage-chart", "chart-range", "credits-badge", "credit-list",
    "app-version",
  ].map((id) => [id, document.getElementById(id)]),
);

let settings = {};
let dashboardState = null;

const compactNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const fullNumber = new Intl.NumberFormat("zh-CN");
const dateTime = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const compactDateTime = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const shortDate = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

function safeNumber(value, formatter = compactNumber) {
  return Number.isFinite(Number(value)) ? formatter.format(Number(value)) : "—";
}

function countdown(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "等待服务器信息";
  const diff = Number(timestamp) - Date.now();
  if (diff <= 0) return "正在重置";
  const minutes = Math.floor(diff / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `${days} 天 ${hours} 小时 ${mins} 分`;
  if (hours) return `${hours} 小时 ${mins} 分`;
  return `${Math.max(1, mins)} 分钟`;
}

function setConnection(status) {
  nodes["connection-pill"].className = `connection-pill is-${status}`;
  const labels = { connected: "实时连接", connecting: "正在连接", error: "连接异常" };
  nodes["connection-text"].textContent = labels[status] || "未知状态";
}

function renderState(state) {
  dashboardState = state;
  setConnection(state.connection);

  nodes["error-banner"].hidden = !state.error;
  nodes["error-message"].textContent = state.error || "";
  nodes["updated-at"].textContent = state.updatedAt ? dateTime.format(new Date(state.updatedAt)) : "等待首次同步";
  nodes["refresh-button"].classList.toggle("is-spinning", state.connection === "connecting");

  if (!state.data) return;
  const { limits = [], resetCredits = {}, usage = {} } = state.data;
  const heroLimit = limits[0];
  const heroWindow = heroLimit?.windows?.[0];

  nodes["hero-limit-name"].textContent = heroLimit?.name || "Codex";
  nodes["plan-badge"].textContent = heroLimit?.plan || "—";
  nodes["hero-meter"].style.setProperty("--used", heroWindow?.usedPercent ?? 0);
  nodes["hero-remaining"].textContent = heroWindow ? `${heroWindow.remainingPercent}%` : "—";
  nodes["hero-window-label"].textContent = heroWindow?.label || "额度周期";
  nodes["hero-countdown"].dataset.resetAt = heroWindow?.resetsAt || "";
  nodes["hero-countdown"].textContent = heroWindow ? countdown(heroWindow.resetsAt) : "暂无限额窗口";
  nodes["hero-reset-time"].textContent = heroWindow?.resetsAt ? `${dateTime.format(new Date(heroWindow.resetsAt))} 重置` : "—";
  nodes["hero-used"].textContent = heroWindow ? `${heroWindow.usedPercent}%` : "—";
  nodes["hero-remain-small"].textContent = heroWindow ? `${heroWindow.remainingPercent}%` : "—";

  nodes["reset-count"].textContent = resetCredits.availableCount ?? "—";
  nodes["lifetime-tokens"].textContent = safeNumber(usage.lifetimeTokens);
  nodes["lifetime-detail"].textContent = Number.isFinite(usage.lifetimeTokens) ? `${safeNumber(usage.lifetimeTokens, fullNumber)} tokens` : "账户历史总量";
  nodes["streak-days"].textContent = usage.currentStreakDays ?? "—";
  nodes["streak-detail"].textContent = Number.isFinite(usage.longestStreakDays) ? `天 · 最长 ${usage.longestStreakDays} 天` : "天";
  nodes["peak-tokens"].textContent = safeNumber(usage.peakDailyTokens);

  renderUsage(usage.daily || []);
  renderCredits(resetCredits);
}

function renderUsage(daily) {
  nodes["usage-chart"].replaceChildren();
  const visible = daily.slice(-28);
  if (!visible.length) {
    nodes["usage-chart"].append(emptyMessage("每日 token 统计暂不可用。"));
    nodes["chart-range"].textContent = "—";
    return;
  }
  const max = Math.max(...visible.map((item) => item.tokens), 1);
  nodes["chart-range"].textContent = `${visible[0].date} — ${visible.at(-1).date}`;
  for (const item of visible) {
    const height = Math.max(3, Math.round((item.tokens / max) * 100));
    const wrap = element("div", "chart-bar-wrap");
    wrap.style.setProperty("--bar-height", `${height}%`);
    const tooltip = element("span", "chart-tooltip", `${shortDate.format(new Date(`${item.date}T12:00:00`))} · ${safeNumber(item.tokens)} tokens`);
    const bar = element("div", "chart-bar");
    bar.style.height = `${height}%`;
    wrap.append(tooltip, bar);
    nodes["usage-chart"].append(wrap);
  }
}

function renderCredits(summary) {
  const count = summary?.availableCount ?? 0;
  const credits = summary?.credits || [];
  nodes["credits-badge"].textContent = `${count} AVAILABLE`;
  nodes["credit-list"].replaceChildren();

  if (!credits.length) {
    nodes["credit-list"].append(emptyMessage(count ? `账户有 ${count} 次可用重置，但服务器未返回逐条明细。` : "目前没有可用的额度重置。"));
    return;
  }

  for (const credit of credits) {
    const item = element("div", "credit-item");
    const top = element("div", "credit-top");
    top.append(element("strong", "", credit.title), element("span", "credit-status", credit.status === "available" ? "可用" : credit.status));
    const timeline = element("div", "credit-timeline");
    const grantedCopy = credit.grantedAt ? compactDateTime.format(new Date(credit.grantedAt)) : "未知时间";
    const expiryCopy = credit.expiresAt ? compactDateTime.format(new Date(credit.expiresAt)) : "无到期时间";
    timeline.append(element("span", "", `${grantedCopy} 获赠 → ${expiryCopy} 到期`));
    const timer = element("b", "", countdown(credit.expiresAt));
    timer.dataset.resetAt = credit.expiresAt || "";
    timeline.append(timer);
    item.append(top, timeline);
    nodes["credit-list"].append(item);
  }
}

function emptyMessage(copy) {
  return element("div", "credits-empty", copy);
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function applySettings(next) {
  settings = { ...settings, ...next };
  nodes["pin-button"].setAttribute("aria-pressed", String(Boolean(settings.alwaysOnTop)));
  nodes["login-toggle"].checked = Boolean(settings.launchAtLogin);
  nodes["interval-select"].value = String(settings.refreshIntervalSeconds || 30);
}

nodes["refresh-button"].addEventListener("click", async () => {
  nodes["refresh-button"].classList.add("is-spinning");
  await api.refresh();
  nodes["refresh-button"].classList.remove("is-spinning");
});

nodes["pin-button"].addEventListener("click", async () => {
  applySettings(await api.setAlwaysOnTop(!settings.alwaysOnTop));
});

nodes["settings-button"].addEventListener("click", () => {
  const opening = nodes["settings-popover"].hidden;
  nodes["settings-popover"].hidden = !opening;
  nodes["settings-button"].setAttribute("aria-expanded", String(opening));
});

nodes["login-toggle"].addEventListener("change", async (event) => {
  applySettings(await api.setLaunchAtLogin(event.target.checked));
});

nodes["interval-select"].addEventListener("change", async (event) => {
  applySettings(await api.setRefreshInterval(Number(event.target.value)));
});

document.addEventListener("click", (event) => {
  if (nodes["settings-popover"].hidden) return;
  if (!nodes["settings-popover"].contains(event.target) && !nodes["settings-button"].contains(event.target)) {
    nodes["settings-popover"].hidden = true;
    nodes["settings-button"].setAttribute("aria-expanded", "false");
  }
});

setInterval(() => {
  document.querySelectorAll("[data-reset-at]").forEach((node) => {
    if (node.dataset.resetAt) node.textContent = countdown(Number(node.dataset.resetAt));
  });
}, 30_000);

const initial = await api.getInitial();
applySettings(initial.settings);
nodes["app-version"].textContent = `Codex Meter v${initial.version}`;
renderState(initial.state);
api.onState(renderState);
