import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient, readAccountSnapshotWithRecovery } from "./lib/codex-client.mjs";
import { normalizeDashboardData } from "./lib/normalize.mjs";
import { readCodexTaskSnapshot, recoverTaskSnapshot } from "./lib/task-monitor.mjs";
import { SettingsStore } from "./lib/settings.mjs";
import { UsageCacheStore, isUsagePayload } from "./lib/usage-cache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_INTERVALS = new Set([15, 30, 60, 300]);
const TASK_REFRESH_INTERVAL_MS = 2_000;
const TASK_RETRY_INTERVAL_MS = 750;
const WAKE_GRACE_MS = 20_000;
const WAKE_RECONNECT_DEDUP_MS = 5_000;

let mainWindow;
let client;
let clientGeneration = 0;
let connecting = null;
let store;
let usageCache;
let cachedUsagePayload = null;
let cachedUsageSavedAt = null;
let refreshTimer;
let reconnectTimer;
let boundsSaveTimer;
let taskTimer;
let refreshing = null;
let taskRefreshing = null;
let taskFailureStartedAt = null;
let wakeGraceUntil = 0;
let lastWakeReconnectAt = 0;

let state = {
  connection: "connecting",
  error: null,
  data: null,
  updatedAt: null,
};

let taskState = {
  items: [],
  total: 0,
  running: 0,
  waiting: 0,
  projects: 0,
  error: null,
  updatedAt: null,
  checkedAt: null,
  recovering: false,
};

app.setName("Codex Meter");
nativeTheme.themeSource = "dark";

function pushState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dashboard:state", state);
  }
}

function pushTaskState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("tasks:state", taskState);
  }
}

async function refreshTasks() {
  if (taskRefreshing) return taskRefreshing;
  taskRefreshing = (async () => {
    try {
      const snapshot = await readCodexTaskSnapshot();
      taskState = {
        ...snapshot,
        checkedAt: Date.now(),
        recovering: false,
      };
      taskFailureStartedAt = null;
      wakeGraceUntil = 0;
    } catch (error) {
      const now = Date.now();
      taskFailureStartedAt ??= now;
      taskState = recoverTaskSnapshot(taskState, error, {
        now,
        failureStartedAt: taskFailureStartedAt,
        wakeGraceUntil,
      });
    } finally {
      pushTaskState();
      taskRefreshing = null;
    }
    return taskState;
  })();
  return taskRefreshing;
}

function scheduleTaskRefresh(delay = 0) {
  clearTimeout(taskTimer);
  taskTimer = setTimeout(async () => {
    await refreshTasks();
    scheduleTaskRefresh(taskState.recovering ? TASK_RETRY_INTERVAL_MS : TASK_REFRESH_INTERVAL_MS);
  }, delay);
}

function suspendRefreshes() {
  clearTimeout(taskTimer);
  clearTimeout(refreshTimer);
}

function invalidateDataClient() {
  clientGeneration += 1;
  client?.stop();
  client = null;
  clearTimeout(reconnectTimer);
}

function resumeRefreshes() {
  const now = Date.now();
  if (now - lastWakeReconnectAt >= WAKE_RECONNECT_DEDUP_MS) {
    lastWakeReconnectAt = now;
    invalidateDataClient();
    state = { ...state, connection: "connecting", error: null };
    pushState();
  }
  wakeGraceUntil = now + WAKE_GRACE_MS;
  taskFailureStartedAt = now;
  taskState = {
    ...taskState,
    recovering: true,
    error: null,
    checkedAt: now,
  };
  pushTaskState();
  scheduleTaskRefresh(300);
  scheduleRefresh(1_200);
}

async function connect({ force = false } = {}) {
  clearTimeout(reconnectTimer);
  if (!force && client?.ready) return client;
  if (connecting) {
    await connecting.catch(() => {});
    if (!force && client?.ready) return client;
  }

  state = { ...state, connection: "connecting", error: null };
  pushState();

  client?.stop();
  const generation = ++clientGeneration;
  const nextClient = new CodexAppServerClient();
  client = nextClient;
  nextClient.on("notification", (message) => {
    if (message.method === "account/rateLimits/updated") scheduleRefresh(350);
  });
  nextClient.on("disconnect", (error) => {
    if (generation !== clientGeneration) return;
    state = { ...state, connection: "error", error: friendlyError(error) };
    pushState();
    reconnectTimer = setTimeout(() => connect().catch(handleConnectionError), 5_000);
  });

  const attempt = (async () => {
    await nextClient.start();
    if (generation !== clientGeneration) {
      nextClient.stop();
      return client;
    }
    state = { ...state, connection: "connected", error: null };
    pushState();
    return nextClient;
  })();
  connecting = attempt;
  try {
    return await attempt;
  } catch (error) {
    if (generation === clientGeneration) handleConnectionError(error);
    throw error;
  } finally {
    if (connecting === attempt) connecting = null;
  }
}

function handleConnectionError(error) {
  state = { ...state, connection: "error", error: friendlyError(error) };
  pushState();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect().catch(handleConnectionError), 5_000);
}

function friendlyError(error) {
  const message = error?.message || String(error);
  if (message.includes("ENOENT")) {
    return "没有找到 Codex CLI。请先安装 Codex，或通过 CODEX_BINARY 指定路径。";
  }
  if (message.toLowerCase().includes("not logged in")) {
    return "Codex 尚未登录。请先在 Codex 应用或命令行完成登录。";
  }
  return message;
}

async function refreshData() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (!client?.ready) await connect();
      const { rateResult, usageResult, recoveryError } = await readAccountSnapshotWithRecovery({
        client,
        reconnect: () => connect({ force: true }),
      });

      if (rateResult.status === "rejected") throw rateResult.reason;
      const previousUsage = state.data?.usage;
      const liveUsageAvailable = usageResult.status === "fulfilled" && isUsagePayload(usageResult.value);
      const usagePayload = liveUsageAvailable ? usageResult.value : cachedUsagePayload;
      if (liveUsageAvailable) {
        cachedUsagePayload = usageResult.value;
        cachedUsageSavedAt = Date.now();
        usageCache.save(cachedUsagePayload, cachedUsageSavedAt).catch(() => {});
      }
      const normalized = normalizeDashboardData(rateResult.value, usagePayload);
      if (!usagePayload && previousUsage) normalized.usage = previousUsage;

      state = {
        connection: "connected",
        error: liveUsageAvailable
          ? null
          : cachedUsagePayload
            ? `每日 token 实时读取正在恢复，当前显示 ${formatCacheAge(cachedUsageSavedAt)}的缓存数据。`
            : friendlyUsageError(usageResult.reason || recoveryError),
        data: normalized,
        updatedAt: Date.now(),
      };
      pushState();
      return state;
    } catch (error) {
      state = { ...state, connection: "error", error: friendlyError(error) };
      pushState();
      return state;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function formatCacheAge(savedAt) {
  if (savedAt === null || savedAt === undefined || !Number.isFinite(Number(savedAt))) return "上次成功读取";
  const minutes = Math.max(0, Math.floor((Date.now() - Number(savedAt)) / 60_000));
  if (minutes < 1) return "刚刚保存";
  if (minutes < 60) return `${minutes} 分钟前保存`;
  return `${Math.floor(minutes / 60)} 小时前保存`;
}

function friendlyUsageError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("not logged in") || message.includes("authentication")) {
    return "Codex 登录状态已失效，暂时无法读取每日 token 统计。";
  }
  return "每日 token 实时读取正在自动恢复，历史数据没有丢失。";
}

function scheduleRefresh(delay = 0) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshData();
    const seconds = store?.get().refreshIntervalSeconds || 30;
    scheduleRefresh(seconds * 1000);
  }, delay);
}

async function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  await store.update({ windowBounds: mainWindow.getBounds() });
}

function createWindow() {
  const settings = store.get();
  const saved = settings.windowBounds || {};
  mainWindow = new BrowserWindow({
    width: saved.width || 1180,
    height: saved.height || 760,
    x: saved.x,
    y: saved.y,
    minWidth: 820,
    minHeight: 620,
    title: "Codex Meter",
    backgroundColor: "#08111d",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: "under-window",
    visualEffectState: "active",
    transparent: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  if (settings.alwaysOnTop) mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  const queueBoundsSave = () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => saveBounds().catch(() => {}), 500);
  };
  mainWindow.on("resize", queueBoundsSave);
  mainWindow.on("move", queueBoundsSave);
}

function registerIpc() {
  ipcMain.handle("dashboard:initial", () => ({
    state,
    taskState,
    settings: store.get(),
    version: app.getVersion(),
  }));
  ipcMain.handle("dashboard:refresh", async () => {
    await Promise.all([refreshData(), refreshTasks()]);
    return state;
  });
  ipcMain.handle("dashboard:set-always-on-top", async (_event, enabled) => {
    const value = Boolean(enabled);
    mainWindow.setAlwaysOnTop(value, value ? "floating" : "normal");
    return store.update({ alwaysOnTop: value });
  });
  ipcMain.handle("dashboard:set-launch-at-login", async (_event, enabled) => {
    const value = Boolean(enabled);
    app.setLoginItemSettings({ openAtLogin: value, openAsHidden: false });
    return store.update({ launchAtLogin: value });
  });
  ipcMain.handle("dashboard:set-refresh-interval", async (_event, seconds) => {
    const value = Number(seconds);
    if (!ALLOWED_INTERVALS.has(value)) throw new Error("不支持的刷新间隔。 ");
    const settings = await store.update({ refreshIntervalSeconds: value });
    scheduleRefresh(value * 1000);
    return settings;
  });
}

app.whenReady().then(async () => {
  store = new SettingsStore(app.getPath("userData"));
  usageCache = new UsageCacheStore(app.getPath("userData"));
  await store.load();
  const cachedUsage = await usageCache.load();
  cachedUsagePayload = cachedUsage?.payload || null;
  cachedUsageSavedAt = cachedUsage?.savedAt || null;
  registerIpc();
  createWindow();
  powerMonitor.on("suspend", suspendRefreshes);
  powerMonitor.on("resume", resumeRefreshes);
  powerMonitor.on("unlock-screen", resumeRefreshes);
  scheduleTaskRefresh(0);
  connect().then(() => scheduleRefresh(0)).catch(() => {});

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  clearTimeout(taskTimer);
  client?.stop();
});
