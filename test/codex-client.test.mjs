import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexSpawnEnvironment,
  readAccountSnapshotWithRecovery,
  resolveCodexBinary,
} from "../src/lib/codex-client.mjs";

test("resolveCodexBinary finds an executable Codex installation", async () => {
  const binary = await resolveCodexBinary();
  assert.match(binary, /codex$/);
});

test("Codex spawn environment restores executable paths missing from login items", () => {
  const env = buildCodexSpawnEnvironment({
    binary: "/opt/homebrew/bin/codex",
    env: {
      HOME: "/Users/example",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });

  assert.deepEqual(env.PATH.split(":"), [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);
  assert.equal(env.HOME, "/Users/example");
});

function fakeClient(responses) {
  return {
    request(method) {
      const result = responses[method];
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

test("account usage failure reconnects and recovers the full snapshot", async () => {
  const staleClient = fakeClient({
    "account/rateLimits/read": { source: "stale-rate" },
    "account/usage/read": new Error("usage request failed after wake"),
  });
  const recoveredClient = fakeClient({
    "account/rateLimits/read": { source: "fresh-rate" },
    "account/usage/read": { dailyUsageBuckets: [{ startDate: "2026-07-21", tokens: 42 }] },
  });
  let reconnects = 0;

  const result = await readAccountSnapshotWithRecovery({
    client: staleClient,
    reconnect: async () => {
      reconnects += 1;
      return recoveredClient;
    },
  });

  assert.equal(reconnects, 1);
  assert.equal(result.reconnected, true);
  assert.equal(result.rateResult.value.source, "fresh-rate");
  assert.equal(result.usageResult.value.dailyUsageBuckets[0].tokens, 42);
});

test("healthy account snapshot does not reconnect", async () => {
  const client = fakeClient({
    "account/rateLimits/read": { ok: true },
    "account/usage/read": { summary: {}, dailyUsageBuckets: [] },
  });
  let reconnects = 0;
  const result = await readAccountSnapshotWithRecovery({
    client,
    reconnect: async () => {
      reconnects += 1;
      return client;
    },
  });
  assert.equal(reconnects, 0);
  assert.equal(result.reconnected, false);
});
