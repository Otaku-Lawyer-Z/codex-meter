import test from "node:test";
import assert from "node:assert/strict";
import { resolveCodexBinary } from "../src/lib/codex-client.mjs";

test("resolveCodexBinary finds an executable Codex installation", async () => {
  const binary = await resolveCodexBinary();
  assert.match(binary, /codex$/);
});
