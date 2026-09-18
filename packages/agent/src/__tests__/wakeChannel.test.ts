import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Мок @aif/shared до импортов
vi.mock("@aif/shared", () => ({
  logger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getEnv: () => ({
    API_BASE_URL: "http://localhost:3009",
  }),
}));

import {
  connectWakeChannel,
  closeWakeChannel,
  isWakeChannelConnected,
  waitForApiReady,
  getReconnectDelay,
  _resetForTesting,
} from "../wakeChannel.js";

const wsMockState = vi.hoisted(() => ({
  lastCreatedWs: null as null | {
    _simulateOpen(): void;
    _simulateClose(): void;
    _simulateMessage(data: string): void;
  },
  MockWebSocket: class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    addEventListener(event: string, fn: (...args: unknown[]) => void): void {
      (this.listeners[event] ??= []).push(fn);
    }

    removeEventListener(event: string, fn: (...args: unknown[]) => void): void {
      const list = this.listeners[event];
      if (!list) return;
      this.listeners[event] = list.filter((f) => f !== fn);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
    }

    _emit(event: string, data?: unknown): void {
      for (const fn of this.listeners[event] ?? []) fn(data);
    }

    _simulateOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      this._emit("open");
    }

    _simulateClose(): void {
      this.readyState = MockWebSocket.CLOSED;
      this._emit("close");
    }

    _simulateMessage(data: string): void {
      this._emit("message", { data });
    }
  },
}));

vi.mock("ws", () => ({
  WebSocket: class extends wsMockState.MockWebSocket {
    static OPEN = wsMockState.MockWebSocket.OPEN;
    static CONNECTING = wsMockState.MockWebSocket.CONNECTING;
    static CLOSED = wsMockState.MockWebSocket.CLOSED;

    constructor() {
      super();
      wsMockState.lastCreatedWs = this;
    }
  },
}));

// ---------------------------------------------------------------------------
// Мок fetch для waitForApiReady
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTesting();
  wsMockState.lastCreatedWs = null;
  fetchMock.mockReset();
});

afterEach(() => {
  closeWakeChannel();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------
describe("wakeChannel", () => {
  describe("connectWakeChannel", () => {
    it("creates a WebSocket and returns true", () => {
      const callback = vi.fn();
      const result = connectWakeChannel(callback);

      expect(result).toBe(true);
      expect(wsMockState.lastCreatedWs).not.toBeNull();
    });

    it("resets reconnect attempts on successful open", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      wsMockState.lastCreatedWs!._simulateOpen();

      expect(isWakeChannelConnected()).toBe(true);
    });

    it("invokes callback on wake events", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      wsMockState.lastCreatedWs!._simulateOpen();

      wsMockState.lastCreatedWs!._simulateMessage(JSON.stringify({ type: "task:created" }));
      expect(callback).toHaveBeenCalledWith("task:created");
    });

    it("debounces rapid wake events", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      wsMockState.lastCreatedWs!._simulateOpen();

      wsMockState.lastCreatedWs!._simulateMessage(JSON.stringify({ type: "task:created" }));
      wsMockState.lastCreatedWs!._simulateMessage(JSON.stringify({ type: "task:moved" }));

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("ignores non-wake events", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      wsMockState.lastCreatedWs!._simulateOpen();

      wsMockState.lastCreatedWs!._simulateMessage(JSON.stringify({ type: "heartbeat" }));
      expect(callback).not.toHaveBeenCalled();
    });

    it("ignores malformed messages", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      wsMockState.lastCreatedWs!._simulateOpen();

      wsMockState.lastCreatedWs!._simulateMessage("not json");
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("scheduleReconnect", () => {
    it("reconnects on close with exponential backoff", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      const ws1 = wsMockState.lastCreatedWs!;
      ws1._simulateClose();

      // Первое переподключение: база ~1 с
      vi.advanceTimersByTime(1500);
      expect(wsMockState.lastCreatedWs).not.toBe(ws1);
    });

    it("does not reconnect after closeWakeChannel()", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      const ws1 = wsMockState.lastCreatedWs!;

      closeWakeChannel();
      ws1._simulateClose();

      vi.advanceTimersByTime(60000);
      // После close новый WS не создаётся
      expect(wsMockState.lastCreatedWs).toBe(ws1);
    });
  });

  describe("closeWakeChannel", () => {
    it("cleans up all state", () => {
      const callback = vi.fn();
      connectWakeChannel(callback);
      closeWakeChannel();

      expect(isWakeChannelConnected()).toBe(false);
    });
  });

  describe("getReconnectDelay", () => {
    it("returns exponentially increasing delays", () => {
      // С джиттером задержка >= base * 2^attempt
      const d0 = getReconnectDelay(0);
      const d1 = getReconnectDelay(1);
      const d2 = getReconnectDelay(2);

      expect(d0).toBeGreaterThanOrEqual(1000);
      expect(d1).toBeGreaterThanOrEqual(2000);
      expect(d2).toBeGreaterThanOrEqual(4000);
    });

    it("caps at RECONNECT_MAX_MS (30s)", () => {
      const d10 = getReconnectDelay(10);
      // макс. база = 30000, джиттер до 30% = 39000
      expect(d10).toBeLessThanOrEqual(39000);
    });
  });

  describe("waitForApiReady", () => {
    it("resolves true on immediate success", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ready: true }),
      });
      const result = await waitForApiReady();
      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries on fetch failure and succeeds", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ready: true }),
      });

      const promise = waitForApiReady();
      // Прокручиваем таймер за первую задержку повтора
      await vi.advanceTimersByTimeAsync(READINESS_RETRY_DELAY_MS);
      const result = await promise;

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ready: true }),
      });

      const promise = waitForApiReady();
      await vi.advanceTimersByTimeAsync(READINESS_RETRY_DELAY_MS);
      const result = await promise;

      expect(result).toBe(true);
    });

    it("returns false after exhausting retries", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const promise = waitForApiReady();
      // Прокручиваем таймер за все повторы (10 повторов * 2 с = 20 с)
      for (let i = 0; i < READINESS_MAX_RETRIES; i++) {
        await vi.advanceTimersByTimeAsync(READINESS_RETRY_DELAY_MS + 100);
      }
      const result = await promise;

      expect(result).toBe(false);
    });
  });
});

// Реэкспорт констант для тестовых проверок
const READINESS_RETRY_DELAY_MS = 2000;
const READINESS_MAX_RETRIES = 10;
