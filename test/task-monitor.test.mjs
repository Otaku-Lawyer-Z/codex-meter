import test from "node:test";
import assert from "node:assert/strict";
import {
  analyseThread,
  buildTaskSnapshot,
  parseJsonLines,
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
