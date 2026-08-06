import test from "node:test";
import assert from "node:assert/strict";
import {
  analyseThread,
  buildTaskSnapshot,
  isTransientStateDbError,
  parseOpenCodexRolloutPaths,
  parseJsonLines,
  recoverTaskSnapshot,
  retryTransientStateDb,
} from "../src/lib/task-monitor.mjs";

const thread = {
  id: "thread-1",
  title: "Build Codex usage dashboard",
  cwd: "/Users/test/Documents/levelup",
  updatedAtMs: 1_800_000_020_000,
};

const event = (timestamp, type, extra = {}) => ({
  timestamp: new Date(timestamp).toISOString(),
  type: "event_msg",
  payload: { type, ...extra },
});

test("parseJsonLines ignores a partial live line", () => {
  const text = `${JSON.stringify(event(1_800_000_000_000, "user_message"))}\n{"partial":`;
  assert.equal(parseJsonLines(text).length, 1);
});

test("analyseThread recognizes an active Codex task and its project", () => {
  const events = [
    event(1_800_000_000_000, "user_message"),
    { timestamp: new Date(1_800_000_010_000).toISOString(), type: "response_item", payload: { type: "reasoning" } },
  ];
  const result = analyseThread(thread, events, 1_800_000_020_000);
  assert.equal(result.title, "Build Codex usage dashboard");
  assert.equal(result.project, "levelup");
  assert.equal(result.status, "running");
  assert.equal(result.stage, "正在分析任务");
});

test("analyseThread recognizes unresolved user input as waiting", () => {
  const events = [
    event(1_800_000_000_000, "user_message"),
    {
      timestamp: new Date(1_800_000_010_000).toISOString(),
      type: "response_item",
      payload: { type: "function_call", name: "request_user_input", call_id: "call-1" },
    },
  ];
  const result = analyseThread(thread, events, 1_800_000_020_000);
  assert.equal(result.status, "waiting");
  assert.equal(result.stage, "等待你的回复");
});

test("analyseThread removes a task after task_complete", () => {
  const events = [
    event(1_800_000_000_000, "user_message"),
    event(1_800_000_010_000, "task_complete"),
  ];
  assert.equal(analyseThread(thread, events, 1_800_000_020_000), null);
});

test("analyseThread removes a user-interrupted task immediately", () => {
  const events = [
    event(1_800_000_000_000, "user_message"),
    event(1_800_000_010_000, "turn_aborted", { reason: "interrupted" }),
  ];
  assert.equal(analyseThread(thread, events, 1_800_000_020_000), null);
});

test("analyseThread treats a final answer as terminal when task_complete is missing", () => {
  const events = [
    event(1_800_000_000_000, "user_message"),
    event(1_800_000_010_000, "agent_message", { phase: "final_answer" }),
  ];
  assert.equal(analyseThread(thread, events, 1_800_000_020_000), null);
});

test("analyseThread removes an inactive runtime after a short race-condition grace period", () => {
  const events = [event(1_800_000_000_000, "user_message")];
  assert.notEqual(
    analyseThread(thread, events, 1_800_000_010_000, { runtimeActive: false }),
    null,
  );
  assert.equal(
    analyseThread(thread, events, 1_800_000_020_000, { runtimeActive: false }),
    null,
  );
});

test("parseOpenCodexRolloutPaths only accepts JSONL files held by Codex", () => {
  const output = [
    "p101",
    "ccodex",
    "f21",
    "n/Users/example/.codex/sessions/active.jsonl",
    "p102",
    "cnode",
    "f22",
    "n/Users/example/.codex/sessions/not-codex.jsonl",
    "p103",
    "ccodex",
    "f23",
    "n/Users/example/.codex/state_5.sqlite",
  ].join("\n");

  assert.deepEqual(
    [...parseOpenCodexRolloutPaths(output)],
    ["/Users/example/.codex/sessions/active.jsonl"],
  );
});

test("buildTaskSnapshot counts active tasks and distinct projects", () => {
  const second = { ...thread, id: "thread-2", cwd: "/Users/test/Documents/case", title: "整理案件资料" };
  const eventsByThread = new Map([
    [thread.id, [event(1_800_000_000_000, "user_message")]],
    [second.id, [event(1_800_000_001_000, "user_message")]],
  ]);
  const snapshot = buildTaskSnapshot([thread, second], eventsByThread, { updatedAt: 1_800_000_020_000 });
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.running, 2);
  assert.equal(snapshot.projects, 2);
});

test("sleep-wake sqlite errors are transient", () => {
  const error = new Error("Error: in prepare, unable to open database file (14)");
  assert.equal(isTransientStateDbError(error), true);
});

test("transient database reads retry before surfacing an error", async () => {
  let attempts = 0;
  const result = await retryTransientStateDb(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("unable to open database file (14)");
    return "ready";
  }, { delays: [0, 1, 1], wait: async () => {} });
  assert.equal(result, "ready");
  assert.equal(attempts, 3);
});

test("wake recovery keeps the last snapshot and hides raw sqlite commands", () => {
  const previous = {
    items: [{ id: "thread-1" }],
    total: 1,
    running: 1,
    waiting: 0,
    projects: 1,
    updatedAt: 1_800_000_000_000,
    error: null,
  };
  const raw = new Error("Command failed: /usr/bin/sqlite3 SELECT secret-looking-query; unable to open database file (14)");
  const recovering = recoverTaskSnapshot(previous, raw, {
    now: 1_800_000_005_000,
    failureStartedAt: 1_800_000_005_000,
    wakeGraceUntil: 1_800_000_025_000,
  });
  assert.equal(recovering.items, previous.items);
  assert.equal(recovering.updatedAt, previous.updatedAt);
  assert.equal(recovering.recovering, true);
  assert.equal(recovering.error, null);

  const prolonged = recoverTaskSnapshot(previous, raw, {
    now: 1_800_000_030_000,
    failureStartedAt: 1_800_000_005_000,
    wakeGraceUntil: 1_800_000_025_000,
  });
  assert.equal(prolonged.error, "Codex 任务状态暂时不可用，正在自动重试。");
  assert.equal(prolonged.error.includes("sqlite3"), false);
});
