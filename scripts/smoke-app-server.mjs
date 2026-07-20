import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/lib/codex-client.mjs";
import { normalizeDashboardData } from "../src/lib/normalize.mjs";

const client = new CodexAppServerClient();

try {
  await client.start();
  const [rateLimits, usage] = await Promise.all([
    client.request("account/rateLimits/read", null),
    client.request("account/usage/read", null),
  ]);
  const dashboard = normalizeDashboardData(rateLimits, usage);
  assert.ok(dashboard.limits.length > 0, "Codex did not return any rate-limit buckets");
  assert.ok(dashboard.limits.some((limit) => limit.windows.length > 0), "No rate-limit window was returned");
  assert.ok(dashboard.resetCredits.availableCount >= 0, "Invalid reset credit count");
  process.stdout.write(`ok: ${dashboard.limits.length} limit bucket(s), ${dashboard.resetCredits.availableCount} reset credit(s)\n`);
} finally {
  client.stop();
}
