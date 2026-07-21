import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UsageCacheStore, isUsagePayload } from "../src/lib/usage-cache.mjs";

const payload = {
  summary: { lifetimeTokens: 1234 },
  dailyUsageBuckets: [{ startDate: "2026-07-21", tokens: 42 }],
};

test("usage cache validates, persists, and reloads the last good payload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-meter-cache-"));
  try {
    const store = new UsageCacheStore(directory);
    assert.equal(isUsagePayload(payload), true);
    assert.equal(await store.save(payload, 1_800_000_000_000), true);
    assert.equal(await store.save(payload, 1_800_000_001_000), false);

    const loaded = await new UsageCacheStore(directory).load();
    assert.deepEqual(loaded, { payload, savedAt: 1_800_000_000_000 });
    assert.match(await readFile(path.join(directory, "usage-cache.json"), "utf8"), /lifetimeTokens/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage cache rejects incomplete payloads", () => {
  assert.equal(isUsagePayload(null), false);
  assert.equal(isUsagePayload({ summary: {}, dailyUsageBuckets: null }), false);
});
