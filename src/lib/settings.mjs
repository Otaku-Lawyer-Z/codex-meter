import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  alwaysOnTop: false,
  launchAtLogin: false,
  refreshIntervalSeconds: 30,
  windowBounds: null,
};

export class SettingsStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, "settings.json");
    this.data = { ...DEFAULTS };
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      this.data = { ...DEFAULTS, ...parsed };
    } catch {
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  get() {
    return { ...this.data };
  }

  async update(patch) {
    this.data = { ...this.data, ...patch };
    await mkdir(path.dirname(this.file), { recursive: true });
    const tempFile = `${this.file}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(tempFile, this.file);
    return this.get();
  }
}
