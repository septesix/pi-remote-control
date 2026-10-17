import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __launchDaemonForTests } from "../src/extension/index.js";

// Launches a real detached daemon on a private port and state directory. This is the only
// test that can fail the way /remote-control failed on Windows: a launch that needs a shell
// never reaches the code under test, so a mocked spawn can never prove otherwise.
// Set PI_RC_SKIP_REAL_LAUNCH=1 to skip in sandboxes that forbid child processes.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(packageRoot, "src", "cli-runner.cjs");
const describeReal = process.env.PI_RC_SKIP_REAL_LAUNCH ? describe.skip : describe;

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

function runnerCli(args: string[]) {
  return spawnSync(process.execPath, [runner, ...args, "--state-dir", stateDir], {
    encoding: "utf8",
    env: { ...process.env, PI_REMOTE_CONTROL_DIR: stateDir },
  });
}

let stateDir = "";
let healthUrl = "";
let logPath = "";

describeReal("real daemon launch", () => {
  beforeAll(async () => {
    const port = await freePort();
    stateDir = mkdtempSync(join(tmpdir(), "pi-remote-control-launch-"));
    logPath = join(stateDir, "daemon.log");
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ bindAddress: `127.0.0.1:${port}` }));
    healthUrl = `http://127.0.0.1:${port}/v1/health`;

    process.env.PI_REMOTE_CONTROL_DIR = stateDir;
    process.env.PI_REMOTE_CONTROL_LOG = logPath;
    // Nothing but Node on PATH: no sh, no nohup, no coreutils, on every platform.
    process.env.PATH = dirname(process.execPath);
    process.env.Path = process.env.PATH;
  });

  afterAll(() => {
    runnerCli(["stop"]);
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("starts a detached daemon with no shell available", async () => {
    expect(spawnSync("sh", ["-c", "true"], { encoding: "utf8" }).error).toBeDefined();
    expect(existsSync(logPath)).toBe(false);

    const started = Date.now();
    await __launchDaemonForTests();

    const health = await fetch(healthUrl).then((response) => response.json() as Promise<Record<string, unknown>>);
    expect(health.status).toBe("ok");
    expect(readFileSync(logPath, "utf8")).toContain("listening");
    const probe = spawnSync(process.execPath, [runner, "status"], { encoding: "utf8", env: { ...process.env, PI_REMOTE_CONTROL_DIR: stateDir } });
    expect(`${probe.stdout}${probe.stderr}`, "daemon status").toContain("is running");
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("accepts a daemon that already holds the singleton lock", async () => {
    // The seam always answers "stopped", so this exercises the lost-lock-race branch.
    await expect(__launchDaemonForTests()).resolves.toBeUndefined();
    expect((await fetch(healthUrl)).ok).toBe(true);
  }, 60_000);

  it("reports a daemon that dies during startup without burning the readiness budget", async () => {
    runnerCli(["stop"]);
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ bindAddress: "192.0.2.1:17999" }));

    const started = Date.now();
    await expect(__launchDaemonForTests()).rejects.toThrow(/before becoming ready|could not start/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
