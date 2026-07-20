import { execFile } from "node:child_process";
import { access, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tailCache = new Map();
const MAX_TAIL_BYTES = 768 * 1024;
const MAX_ACTIVE_AGE_MS = 12 * 60 * 60 * 1000;

const THREAD_QUERY = `
SELECT
  id,
  substr(title, 1, 180) AS title,
  cwd,
  rollout_path AS rolloutPath,
  updated_at_ms AS updatedAtMs,
  substr(first_user_message, 1, 180) AS firstUserMessage,
  agent_nickname AS agentNickname,
  agent_role AS agentRole
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
  if (["error", "turn_aborted"].includes(type)) return "任务出现异常";
  return "正在处理任务";
}

export function analyseThread(thread, events, now = Date.now()) {
  const latestUserIndex = lastIndex(events, (event) => payloadType(event) === "user_message");
  const latestCompleteIndex = lastIndex(events, (event) => payloadType(event) === "task_complete");
  const updatedAt = eventTime(events.at(-1)) || Number(thread.updatedAtMs) || 0;
  const hasOpenTurn = latestUserIndex > latestCompleteIndex
    || (latestUserIndex === -1 && latestCompleteIndex === -1 && now - updatedAt <= MAX_ACTIVE_AGE_MS);
  if (!hasOpenTurn) return null;

  const waitingForInput = unresolvedCall(events, ["request_user_input"]);
  const waitingForApproval = unresolvedCall(events, ["approval"]);
  const lastErrorIndex = lastIndex(events, (event) => ["error", "turn_aborted"].includes(payloadType(event)));
  const failed = lastErrorIndex > Math.max(latestUserIndex, latestCompleteIndex)
    && lastErrorIndex === events.length - 1;
  if (!waitingForInput && !waitingForApproval && !failed && now - updatedAt > MAX_ACTIVE_AGE_MS) return null;

  const startEvent = latestUserIndex >= 0 ? events[latestUserIndex] : events[0];
  const status = failed ? "failed" : waitingForInput || waitingForApproval ? "waiting" : "running";
  const labels = { running: "执行中", waiting: "等待中", failed: "异常" };
  const title = String(thread.title || thread.agentNickname || thread.firstUserMessage || "未命名 Codex 任务")
    .replace(/\s+/g, " ")
    .trim();

  return {
    id: thread.id,
    title,
    project: path.basename(thread.cwd || "") || "未命名项目",
    cwd: thread.cwd || "",
    status,
    statusLabel: labels[status],
    stage: waitingForInput ? "等待你的回复" : waitingForApproval ? "等待你的确认" : currentStage(events),
    startedAt: eventTime(startEvent) || Number(thread.updatedAtMs) || now,
    updatedAt,
    isSubagent: Boolean(thread.agentNickname || thread.agentRole),
  };
}

export function buildTaskSnapshot(threads, eventsByThread, { updatedAt = Date.now() } = {}) {
  const items = threads
    .map((thread) => analyseThread(thread, eventsByThread.get(thread.id) || [], updatedAt))
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
  throw new Error("没有找到 Codex 本地任务状态库。");
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
  const dbPath = await resolveStateDb();
  const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", dbPath, THREAD_QUERY], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const threads = JSON.parse(stdout || "[]");
  const eventsByThread = new Map();
  await Promise.all(threads.map(async (thread) => {
    try {
      eventsByThread.set(thread.id, await readTail(thread.rolloutPath));
    } catch {
      eventsByThread.set(thread.id, []);
    }
  }));
  return buildTaskSnapshot(threads, eventsByThread);
}
