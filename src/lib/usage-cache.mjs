import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_VERSION = 1;

export function isUsagePayload(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.summary
    && typeof value.summary === "object"
    && Array.isArray(value.dailyUsageBuckets),
  );
}

export class UsageCacheStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, "usage-cache.json");
    this.lastPayloadJson = null;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed?.version !== CACHE_VERSION || !isUsagePayload(parsed.payload)) return null;
      this.lastPayloadJson = JSON.stringify(parsed.payload);
      return { payload: parsed.payload, savedAt: Number(parsed.savedAt) || null };
    } catch {
      return null;
    }
  }

  async save(payload, savedAt = Date.now()) {
    if (!isUsagePayload(payload)) return false;
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === this.lastPayloadJson) return false;

    await mkdir(path.dirname(this.file), { recursive: true });
    const tempFile = `${this.file}.tmp`;
    await writeFile(tempFile, `${JSON.stringify({ version: CACHE_VERSION, savedAt, payload }, null, 2)}\n`, "utf8");
    await rename(tempFile, this.file);
    this.lastPayloadJson = payloadJson;
    return true;
  }
}
