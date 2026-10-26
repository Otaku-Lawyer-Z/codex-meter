import { execFile } from "node:child_process";
import { access, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tailCache = new Map();
const MAX_TAIL_BYTES = 768 * 1024;
const MAX_ACTIVE_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_IDLE_WITHOUT_ACTIVITY_MS = 5 * 60 * 1000;
const MAX_PENDING_TOOL_AGE_MS = 30 * 60 * 1000;
const MAX_FAILED_AGE_MS = 5 * 60 * 1000;
const RUNTIME_CLOSED_GRACE_MS = 15 * 1000;
const STATE_DB_RETRY_DELAYS_MS = [0, 250, 750];

const THREAD_QUERY = `
SELECT
  id,
  substr(title, 1, 180) AS title,
  cwd,
  rollout_path AS rolloutPath,
  updated_at_ms AS updatedAtMs,
  substr(first_user_message, 1, 180) AS firstUserMessage,
  agent_nickname AS agentNickname,
  agent_role AS agentRole,
  model,
  reasoning_effort AS reasoningEffort
FROM threads
WHERE archived = 0 AND rollout_path <> ''
ORDER BY updated_at_ms DESC
LIMIT 30;
`;

export function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A live JSONL file can end with one partial line while Codex is writing it.
    }
  }
  return events;
}

function payloadType(event) {
  return event?.payload?.type || "";
}

function eventTime(event) {
  const value = Date.parse(event?.timestamp || "");
  return Number.isFinite(value) ? value : 0;
}

function lastIndex(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return index;
  }
  return -1;
}

function isFinalAnswer(event) {
  return ["agent_message", "message"].includes(payloadType(event))
    && event?.payload?.phase === "final_answer";
}

function isUserMessage(event) {
  return payloadType(event) === "user_message"
    || (event?.type === "response_item" && payloadType(event) === "message"
      && event?.payload?.role === "user");
}

function unresolvedCall(events, names) {
  const outputs = new Set(
    events
      .filter((event) => ["function_call_output", "custom_tool_call_output"].includes(payloadType(event)))
      .map((event) => event.payload.call_id)
      .filter(Boolean),
  );
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!["function_call", "custom_tool_call"].includes(payloadType(event))) continue;
    const name = String(event.payload.name || "");
    if (names.some((candidate) => name.includes(candidate)) && !outputs.has(event.payload.call_id)) return event;
  }
  return null;
}

function friendlyToolStage(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("request_user_input")) return "等待你的回复";
  if (normalized.includes("approval")) return "等待你的确认";
  if (normalized.includes("wait")) return "等待后台任务";
  if (normalized.includes("web") || normalized.includes("browser") || normalized.includes("chrome")) return "正在检索资料";
  if (normalized.includes("imagegen")) return "正在生成图像";
  if (normalized.includes("apply_patch")) return "正在修改文件";
  if (normalized.includes("exec") || normalized.includes("command")) return "正在执行本机操作";
  if (normalized.includes("computer")) return "正在操作应用界面";
  return "正在调用工具";
}

function currentStage(events) {
  const pending = unresolvedCall(events, [""]);
  if (pending) return friendlyToolStage(pending.payload.name);

  const last = [...events].reverse().find((event) => !["token_count", "usage_limit"].includes(payloadType(event)));
  const type = payloadType(last);
  if (["reasoning", "agent_reasoning"].includes(type)) return "正在分析任务";
  if (["custom_tool_call_output", "function_call_output"].includes(type)) return "正在整理工具结果";
  if (type === "patch_apply_end" || type === "file_change") return "正在修改项目文件";
  if (type === "agent_message" || (type === "message" && last?.payload?.phase === "commentary")) return "正在汇报进展";
  if (type === "error") return "任务出现异常";
  return "正在处理任务";
}

export function analyseThread(thread, events, now = Date.now(), { runtimeActive = null } = {}) {
  const latestUserIndex = lastIndex(events, isUserMessage);
  const latestStartIndex = lastIndex(events, (event) => payloadType(event) === "task_started");
  const latestCompleteIndex = lastIndex(events, (event) => payloadType(event) === "task_complete");
  const latestAbortIndex = lastIndex(events, (event) => payloadType(event) === "turn_aborted");
  const latestFinalAnswerIndex = lastIndex(events, isFinalAnswer);
  const latestTerminalIndex = Math.max(latestCompleteIndex, latestAbortIndex, latestFinalAnswerIndex);
  const updatedAt = eventTime(events.at(-1)) || Number(thread.updatedAtMs) || 0;
  const inactiveFor = Math.max(0, now - updatedAt);
  const hasOpenTurn = Math.max(latestUserIndex, latestStartIndex) > latestTerminalIndex
    || (latestUserIndex === -1 && latestStartIndex === -1
      && latestTerminalIndex === -1 && inactiveFor <= MAX_ACTIVE_AGE_MS);
  if (!hasOpenTurn) return null;

  // Keep elapsed time and pending calls within the current turn, including when
  // the user sends another message while that turn is still running.
  const firstUserIndex = events.findIndex((event, index) => index > latestTerminalIndex && isUserMessage(event));
  const startIndex = latestStartIndex > latestTerminalIndex
    ? latestStartIndex
    : firstUserIndex >= 0 ? firstUserIndex : latestTerminalIndex + 1;
  const turnEvents = events.slice(startIndex);
  const waitingForInput = unresolvedCall(turnEvents, ["request_user_input"]);
  const waitingForApproval = unresolvedCall(turnEvents, ["approval"]);
  const pendingToolCall = unresolvedCall(turnEvents, [""]);
  const lastErrorIndex = lastIndex(turnEvents, (event) => payloadType(event) === "error");
  const lastMeaningfulIndex = lastIndex(
    turnEvents,
    (event) => !["token_count", "usage_limit"].includes(payloadType(event)),
  );
  const failed = lastErrorIndex > lastIndex(turnEvents, isUserMessage)
    && lastErrorIndex === lastMeaningfulIndex;

  if (runtimeActive === false && inactiveFor > RUNTIME_CLOSED_GRACE_MS) return null;
  if (failed && inactiveFor > MAX_FAILED_AGE_MS) return null;
  if (pendingToolCall && inactiveFor > MAX_PENDING_TOOL_AGE_MS) return null;
  if (!waitingForInput && !waitingForApproval && !pendingToolCall
    && inactiveFor > MAX_IDLE_WITHOUT_ACTIVITY_MS) return null;
  if (inactiveFor > MAX_ACTIVE_AGE_MS) return null;

  const startEvent = turnEvents[0];
  const status = failed ? "failed" : waitingForInput || waitingForApproval ? "waiting" : "running";
  const labels = { running: "执行中", waiting: "等待中", failed: "异常" };
  const title = String(thread.title || thread.agentNickname || thread.firstUserMessage || "未命名 Codex 任务")
    .replace(/\s+/g, " ")
    .trim();

  const context = [...turnEvents].reverse().find((event) => event.type === "turn_context")?.payload;
  const model = context?.model || thread.model || null;
  const reasoningEffort = context
    ? context.effort ?? context.reasoning_effort ?? null
    : thread.reasoningEffort || null;

  return {
    id: thread.id,
    model,
    reasoningEffort,
    title,
    project: path.basename(thread.cwd || "") || "未命名项目",
    cwd: thread.cwd || "",
    status,
    statusLabel: labels[status],
    stage: waitingForInput ? "等待你的回复" : waitingForApproval ? "等待你的确认" : currentStage(turnEvents),
    startedAt: eventTime(startEvent) || Number(thread.updatedAtMs) || now,
    updatedAt,
    isSubagent: Boolean(thread.agentNickname || thread.agentRole),
  };
}

export function buildTaskSnapshot(
  threads,
  eventsByThread,
  { updatedAt = Date.now(), activeRolloutPaths = null } = {},
) {
  const items = threads
    .map((thread) => analyseThread(
      thread,
      eventsByThread.get(thread.id) || [],
      updatedAt,
      {
        runtimeActive: activeRolloutPaths instanceof Set && thread.rolloutPath
          ? activeRolloutPaths.has(path.resolve(thread.rolloutPath))
          : null,
      },
    ))
    .filter(Boolean)
    .sort((a, b) => {
      const rank = { running: 0, waiting: 1, failed: 2 };
      return rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt;
    });
  return {
    items,
    total: items.length,
    running: items.filter((item) => item.status === "running").length,
    waiting: items.filter((item) => item.status === "waiting").length,
    projects: new Set(items.map((item) => item.cwd)).size,
    updatedAt,
    error: null,
  };
}

export function parseOpenCodexRolloutPaths(output) {
  const openPaths = new Set();
  let command = "";

  for (const line of String(output || "").split("\n")) {
    const field = line.slice(0, 1);
    const value = line.slice(1);
    if (field === "p") command = "";
    if (field === "c") command = value.toLowerCase();
    if (field === "n" && command === "codex" && value.endsWith(".jsonl")) {
      openPaths.add(path.resolve(value));
    }
  }

  return openPaths;
}

async function readOpenCodexRolloutPaths() {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-n", "-c", "codex", "-F", "pcn"], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseOpenCodexRolloutPaths(stdout);
  } catch (error) {
    if (Number(error?.code) === 1) return parseOpenCodexRolloutPaths(error?.stdout);
    return null;
  }
}

export function isTransientStateDbError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "").toLowerCase();
  return ["CODEX_STATE_DB_UNAVAILABLE", "SQLITE_CANTOPEN", "ENOENT", "EBUSY", "EIO"].includes(code)
    || message.includes("unable to open database file")
    || message.includes("database is locked")
    || message.includes("resource temporarily unavailable")
    || message.includes("没有找到 codex 本地任务状态库");
}

export async function retryTransientStateDb(
  operation,
  { delays = STATE_DB_RETRY_DELAYS_MS, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await wait(delays[attempt]);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientStateDbError(error) || attempt === delays.length - 1) throw error;
    }
  }
  throw lastError;
}

export function friendlyTaskMonitorError(error) {
  if (isTransientStateDbError(error)) return "Codex 任务状态暂时不可用，正在自动重试。";
  return "暂时无法读取 Codex 任务状态，请稍后重试。";
}

export function recoverTaskSnapshot(
  previous,
  error,
  { now = Date.now(), failureStartedAt = now, wakeGraceUntil = 0, graceMs = 15_000 } = {},
) {
  const hideTransientError = isTransientStateDbError(error)
    && (now < wakeGraceUntil || now - failureStartedAt < graceMs);
  return {
    ...previous,
    recovering: true,
    checkedAt: now,
    error: hideTransientError ? null : friendlyTaskMonitorError(error),
  };
}

async function resolveStateDb() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const candidates = [
    path.join(codexHome, "state_5.sqlite"),
    path.join(codexHome, "sqlite", "state_5.sqlite"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known Codex state database location.
    }
  }
  const error = new Error("没有找到 Codex 本地任务状态库。");
  error.code = "CODEX_STATE_DB_UNAVAILABLE";
  throw error;
}

async function readTail(filePath) {
  const info = await stat(filePath);
  const cached = tailCache.get(filePath);
  if (cached?.size === info.size && cached?.mtimeMs === info.mtimeMs) return cached.events;

  const length = Math.min(info.size, MAX_TAIL_BYTES);
  const position = Math.max(0, info.size - length);
  const handle = await open(filePath, "r");
  let text;
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    text = buffer.toString("utf8");
  } finally {
    await handle.close();
  }
  if (position > 0) text = text.slice(text.indexOf("\n") + 1);
  const events = parseJsonLines(text);
  tailCache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, events });
  return events;
}

export async function readCodexTaskSnapshot() {
  const threads = await retryTransientStateDb(async () => {
    const dbPath = await resolveStateDb();
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", dbPath, THREAD_QUERY], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(stdout || "[]");
  });
  const activeRolloutPathsPromise = readOpenCodexRolloutPaths();
  const eventsByThread = new Map();
  await Promise.all(threads.map(async (thread) => {
    try {
      eventsByThread.set(thread.id, await readTail(thread.rolloutPath));
    } catch {
      eventsByThread.set(thread.id, []);
    }
  }));
  return buildTaskSnapshot(threads, eventsByThread, {
    activeRolloutPaths: await activeRolloutPathsPromise,
  });
}
