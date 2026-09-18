import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { createBrokerRuntime } from "../loginBroker.js";

const FIXTURE_STDOUT_LINES = [
  "Welcome to Codex [v0.124.0]\n",
  "Follow these steps to sign in with ChatGPT using device code authorization:\n",
  "\n1. Open this link in your browser and sign in to your account\n",
  "   https://auth.openai.com/codex/device\n",
  "\n2. Enter this one-time code (expires in 15 minutes)\n",
  "   5PZO-GPZLR\n",
];

/**
 * Легковесная заглушка запускаемого дочернего процесса. Выдаёт фикстуру device-auth
 * несколькими фрагментами, имитируя потоковый вывод настоящего CLI.
 */
function createStubChild(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
  const stdout = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdout"];
  const stderr = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stderr"];
  (proc as unknown as { stdout: typeof stdout }).stdout = stdout;
  (proc as unknown as { stderr: typeof stderr }).stderr = stderr;
  (proc as unknown as { killed: boolean }).killed = false;
  (proc as unknown as { exitCode: number | null }).exitCode = null;
  (proc as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => {
    (proc as unknown as { killed: boolean }).killed = true;
    return true;
  });

  // Выдаём фрагменты через микротаски, имитируя потоковый вывод.
  queueMicrotask(() => {
    for (const line of FIXTURE_STDOUT_LINES) {
      stdout.emit("data", Buffer.from(line));
    }
  });

  return proc as ChildProcessWithoutNullStreams;
}

describe("loginBroker device-auth integration", () => {
  it("start returns sessionId, verificationUrl and userCode", async () => {
    const stub = createStubChild();
    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    const res = await runtime.app.request("/codex/login/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      verificationUrl: string;
      userCode: string;
      startedAt: string;
    };
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(body.userCode).toBe("5PZO-GPZLR");
    expect(typeof body.startedAt).toBe("string");
  });

  it("status reports active session details, then a successful terminal result on code=0 exit", async () => {
    const stub = createStubChild();
    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    const startRes = await runtime.app.request("/codex/login/start", { method: "POST" });
    const startBody = (await startRes.json()) as { sessionId: string };

    const activeRes = await runtime.app.request("/codex/login/status");
    const activeBody = (await activeRes.json()) as {
      active: boolean;
      verificationUrl?: string;
      userCode?: string;
    };
    expect(activeBody.active).toBe(true);
    expect(activeBody.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(activeBody.userCode).toBe("5PZO-GPZLR");

    // Симулируем выход codex CLI после того, как пользователь завершил браузерную авторизацию.
    (stub as unknown as { exitCode: number | null }).exitCode = 0;
    stub.emit("exit", 0, null);

    expect(runtime.getCurrentSession()).toBeNull();

    const inactiveRes = await runtime.app.request("/codex/login/status");
    const inactiveBody = (await inactiveRes.json()) as {
      active: boolean;
      lastResult?: { ok: boolean; reason: string; sessionId: string; exitCode: number | null };
    };
    expect(inactiveBody.active).toBe(false);
    expect(inactiveBody.lastResult).toBeDefined();
    expect(inactiveBody.lastResult?.ok).toBe(true);
    expect(inactiveBody.lastResult?.reason).toBe("success");
    expect(inactiveBody.lastResult?.sessionId).toBe(startBody.sessionId);
    expect(inactiveBody.lastResult?.exitCode).toBe(0);
  });

  it("non-zero exit produces a failed terminal result, not success", async () => {
    const stub = createStubChild();
    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    const startRes = await runtime.app.request("/codex/login/start", { method: "POST" });
    const startBody = (await startRes.json()) as { sessionId: string };

    (stub as unknown as { exitCode: number | null }).exitCode = 1;
    stub.emit("exit", 1, null);

    const inactiveRes = await runtime.app.request("/codex/login/status");
    const inactiveBody = (await inactiveRes.json()) as {
      active: boolean;
      lastResult?: { ok: boolean; reason: string; sessionId: string; exitCode: number | null };
    };
    expect(inactiveBody.active).toBe(false);
    expect(inactiveBody.lastResult?.ok).toBe(false);
    expect(inactiveBody.lastResult?.reason).toBe("exit_nonzero");
    expect(inactiveBody.lastResult?.exitCode).toBe(1);
    expect(inactiveBody.lastResult?.sessionId).toBe(startBody.sessionId);
  });

  it("signal kill produces a failed terminal result with reason=signal", async () => {
    const stub = createStubChild();
    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    await runtime.app.request("/codex/login/start", { method: "POST" });

    (stub as unknown as { exitCode: number | null }).exitCode = null;
    stub.emit("exit", null, "SIGKILL");

    const inactiveRes = await runtime.app.request("/codex/login/status");
    const inactiveBody = (await inactiveRes.json()) as {
      active: boolean;
      lastResult?: { ok: boolean; reason: string; signal: string | null };
    };
    expect(inactiveBody.lastResult?.ok).toBe(false);
    expect(inactiveBody.lastResult?.reason).toBe("signal");
    expect(inactiveBody.lastResult?.signal).toBe("SIGKILL");
  });

  it("async child error during parsing records reason=spawn_failed", async () => {
    const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
    const stdout = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdout"];
    const stderr = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stderr"];
    (proc as unknown as { stdout: typeof stdout }).stdout = stdout;
    (proc as unknown as { stderr: typeof stderr }).stderr = stderr;
    (proc as unknown as { killed: boolean }).killed = false;
    (proc as unknown as { exitCode: number | null }).exitCode = null;
    (proc as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => true);
    // Генерируем error-событие до любого stdout — имитирует ENOENT бинарника codex.
    queueMicrotask(() => proc.emit("error", new Error("spawn codex ENOENT")));

    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => proc) as unknown as typeof import("node:child_process").spawn,
    });

    const startRes = await runtime.app.request("/codex/login/start", { method: "POST" });
    expect(startRes.status).toBe(500);

    const lastResult = runtime.getLastResult();
    expect(lastResult?.ok).toBe(false);
    expect(lastResult?.reason).toBe("spawn_failed");
  });

  it("cancel records a failed terminal result with reason=cancel", async () => {
    const stub = createStubChild();
    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    await runtime.app.request("/codex/login/start", { method: "POST" });
    await runtime.app.request("/codex/login/cancel", { method: "POST" });

    const lastResult = runtime.getLastResult();
    expect(lastResult?.ok).toBe(false);
    expect(lastResult?.reason).toBe("cancel");
  });

  it("returns 409 when a session is already active", async () => {
    const stub = createStubChild();
    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    await runtime.app.request("/codex/login/start", { method: "POST" });
    const second = await runtime.app.request("/codex/login/start", { method: "POST" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: string;
      verificationUrl: string;
      userCode: string;
    };
    expect(body.error).toBe("session_already_active");
    expect(body.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(body.userCode).toBe("5PZO-GPZLR");
  });

  it("cancel clears the active session and SIGTERMs the child", async () => {
    const stub = createStubChild();
    const runtime = createBrokerRuntime({
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    await runtime.app.request("/codex/login/start", { method: "POST" });
    expect(runtime.getCurrentSession()).not.toBeNull();

    const cancelRes = await runtime.app.request("/codex/login/cancel", { method: "POST" });
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as { ok: boolean; cancelled: boolean };
    expect(cancelBody.ok).toBe(true);
    expect(cancelBody.cancelled).toBe(true);

    expect(runtime.getCurrentSession()).toBeNull();
    expect(stub.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
