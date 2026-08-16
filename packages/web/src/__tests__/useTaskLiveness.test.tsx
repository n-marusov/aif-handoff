import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTaskLiveness } from "@/hooks/useTaskLiveness";

vi.mock("@/lib/api", () => ({
  api: { getSettings: vi.fn().mockResolvedValue({ agentStageStaleTimeoutMs: 90_000 }) },
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useTaskLiveness", () => {
  it("returns idle for non-in-progress statuses", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentStageStaleTimeoutMs: 90_000 });
    const { result } = renderHook(() => useTaskLiveness("backlog", null), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current).toBe("idle");
  });

  it("returns running optimistically for in-progress tasks without a heartbeat", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentStageStaleTimeoutMs: 90_000 });
    const { result } = renderHook(() => useTaskLiveness("implementing", null), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current).toBe("running");
  });

  it("returns running for a fresh heartbeat", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentStageStaleTimeoutMs: 90_000 });
    const fresh = new Date(Date.now() - 1_000).toISOString();
    const { result } = renderHook(() => useTaskLiveness("implementing", fresh), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current).toBe("running");
  });

  it("returns stalled for a stale heartbeat", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentStageStaleTimeoutMs: 90_000 });
    const stale = new Date(Date.now() - 100_000).toISOString();
    const { result } = renderHook(() => useTaskLiveness("implementing", stale), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current).toBe("stalled");
  });
});
