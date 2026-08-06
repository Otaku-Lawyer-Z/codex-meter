import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 20_000;
const COMMON_EXECUTABLE_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

async function settleAccountRequests(client) {
  const [rateResult, usageResult] = await Promise.allSettled([
    client.request("account/rateLimits/read", null),
    client.request("account/usage/read", null),
  ]);
  return { rateResult, usageResult };
}

function preferFulfilled(primary, fallback) {
  return primary.status === "fulfilled" ? primary : fallback;
}

export async function readAccountSnapshotWithRecovery({ client, reconnect }) {
  const first = await settleAccountRequests(client);
  if (first.rateResult.status === "fulfilled" && first.usageResult.status === "fulfilled") {
    return { ...first, reconnected: false, recoveryError: null };
  }

  try {
    const recoveredClient = await reconnect();
    const second = await settleAccountRequests(recoveredClient);
    return {
      rateResult: preferFulfilled(second.rateResult, first.rateResult),
      usageResult: preferFulfilled(second.usageResult, first.usageResult),
      reconnected: true,
      recoveryError: null,
    };
  } catch (error) {
    return { ...first, reconnected: true, recoveryError: error };
  }
}

export async function resolveCodexBinary() {
  const candidates = [
    process.env.CODEX_BINARY,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next common install location.
    }
  }

  // Shell-launched development sessions usually have Codex on PATH.
  return "codex";
}

export function buildCodexSpawnEnvironment({ binary, env = process.env } = {}) {
  const directories = [];

  if (binary && path.isAbsolute(binary)) {
    directories.push(path.dirname(binary));
  }

  directories.push(
    ...COMMON_EXECUTABLE_DIRECTORIES,
    ...(env.PATH || "").split(path.delimiter),
  );

  return {
    ...env,
    PATH: [...new Set(directories.filter(Boolean))].join(path.delimiter),
  };
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ binary, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    super();
    this.binary = binary;
    this.requestTimeoutMs = requestTimeoutMs;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.closing = false;
    this.stderrTail = [];
  }

  async start() {
    if (this.process && this.ready) return;
    this.binary ||= await resolveCodexBinary();
    this.closing = false;

    const child = spawn(this.binary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexSpawnEnvironment({ binary: this.binary }),
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail.push(...String(chunk).split("\n").filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-12);
    });

    child.on("error", (error) => this.#handleExit(error));
    child.on("exit", (code, signal) => {
      const suffix = this.stderrTail.length ? ` ${this.stderrTail.at(-1)}` : "";
      this.#handleExit(new Error(`Codex App Server 已退出 (${code ?? signal ?? "unknown"}).${suffix}`));
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_usage_dashboard",
        title: "Codex Meter",
        version: "0.3.7",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "thread/started",
          "item/started",
          "item/completed",
          "item/agentMessage/delta",
        ],
      },
    });
    this.notify("initialized", {});
    this.ready = true;
    this.emit("ready");
  }

  request(method, params = null) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error("Codex App Server 尚未连接。"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时。`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.#write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  stop() {
    this.closing = true;
    this.ready = false;
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
  }

  #write(message) {
    this.process?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex 请求失败。"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  #handleExit(error) {
    if (!this.process && this.closing) return;
    this.ready = false;
    this.process = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.emit("disconnect", error);
  }
}
