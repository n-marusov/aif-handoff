import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const authMocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isValid: vi.fn(),
  reportFailure: vi.fn(),
}));
const notificationMocks = vi.hoisted(() => ({
  settings: { desktop: false, sound: false },
  showTaskAssignment: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getAuthSession: authMocks.getAuthSession,
  },
  webSocketAuthenticationIsValid: authMocks.isValid,
  reportWebSocketAuthenticationFailure: authMocks.reportFailure,
}));

vi.mock("@/hooks/useNotificationSettings", () => ({
  useNotificationSettings: () => ({
    settings: notificationMocks.settings,
  }),
}));

vi.mock("@/lib/notifications", () => ({
  playStatusChangeBeep: vi.fn(),
  showTaskAssignmentNotification: notificationMocks.showTaskAssignment,
  showTaskMovedNotification: vi.fn(),
}));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send() {}

  addEventListener(type: string, listener: () => void) {
    if (type === "open") {
      this.onopen = listener;
    }
  }
}

const { useWebSocket } = await import("@/hooks/useWebSocket");

function createWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useWebSocket live feedback events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    authMocks.isValid.mockReturnValue(true);
    notificationMocks.settings.desktop = false;
    notificationMocks.settings.sound = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("patches lastHeartbeatAt on the cached task and list without invalidating the board", () => {
    const queryClient = new QueryClient();
    const setQueryData = vi.spyOn(queryClient, "setQueryData");
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(["task", "task-1"], {
      id: "task-1",
      title: "Running task",
      status: "implementing",
      lastHeartbeatAt: null,
    });
    queryClient.setQueryData(
      ["tasks", "project-1"],
      [{ id: "task-1", title: "Running task", status: "implementing", lastHeartbeatAt: null }],
    );
    renderHook(() => useWebSocket(), { wrapper: createWrapper(queryClient) });

    act(() => {
      FakeWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: "task:heartbeat",
          payload: { taskId: "task-1", lastHeartbeatAt: "2026-08-16T02:00:00.000Z" },
        }),
      } as MessageEvent);
    });

    expect(setQueryData).toHaveBeenCalledWith(["task", "task-1"], expect.any(Function));
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["tasks"] });
  });

  it("invalidates only the open task detail and dispatches a usage event", () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    renderHook(() => useWebSocket(), { wrapper: createWrapper(queryClient) });

    act(() => {
      FakeWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: "task:usage_updated",
          payload: {
            taskId: "task-1",
            projectId: "project-1",
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.01 },
          },
        }),
      } as MessageEvent);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["task", "task-1"] });
    expect(dispatchEvent).toHaveBeenCalled();
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe("task:usage_updated");
  });
});
