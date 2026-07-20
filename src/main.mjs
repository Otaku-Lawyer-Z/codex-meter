import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./lib/codex-client.mjs";
import { normalizeDashboardData } from "./lib/normalize.mjs";
import { readCodexTaskSnapshot } from "./lib/task-monitor.mjs";
import { SettingsStore } from "./lib/settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_INTERVALS = new Set([15, 30, 60, 300]);

let mainWindow;
let client;
let store;
let refreshTimer;
let reconnectTimer;
let boundsSaveTimer;
let taskTimer;
let refreshing = null;
let taskRefreshing = null;

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
      taskState = await readCodexTaskSnapshot();
    } catch (error) {
      taskState = {
        ...taskState,
        error: `Codex 任务状态暂时不可用：${error?.message || String(error)}`,
        updatedAt: Date.now(),
      };
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
    scheduleTaskRefresh(2_000);
  }, delay);
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (client?.ready) return;

  state = { ...state, connection: "connecting", error: null };
  pushState();

  client?.stop();
  client = new CodexAppServerClient();
  client.on("notification", (message) => {
    if (message.method === "account/rateLimits/updated") scheduleRefresh(350);
  });
  client.on("disconnect", (error) => {
    state = { ...state, connection: "error", error: friendlyError(error) };
    pushState();
    reconnectTimer = setTimeout(() => connect().catch(handleConnectionError), 5_000);
  });

  try {
    await client.start();
    state = { ...state, connection: "connected", error: null };
    pushState();
  } catch (error) {
    handleConnectionError(error);
    throw error;
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
      const [rateResult, usageResult] = await Promise.allSettled([
        client.request("account/rateLimits/read", null),
        client.request("account/usage/read", null),
      ]);

      if (rateResult.status === "rejected") throw rateResult.reason;
      const previousUsage = state.data?.usage;
      const usagePayload = usageResult.status === "fulfilled" ? usageResult.value : null;
      const normalized = normalizeDashboardData(rateResult.value, usagePayload);
      if (!usagePayload && previousUsage) normalized.usage = previousUsage;

      state = {
        connection: "connected",
        error: usageResult.status === "rejected" ? "每日 token 趋势暂时不可用。" : null,
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
  await store.load();
  registerIpc();
  createWindow();
  scheduleTaskRefresh(0);
  connect().then(() => scheduleRefresh(0)).catch(handleConnectionError);

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
