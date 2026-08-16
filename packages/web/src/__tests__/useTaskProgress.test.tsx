import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTaskProgress } from "@/hooks/useTaskProgress";

vi.mock("@/lib/api", () => ({
  api: { getSettings: vi.fn().mockResolvedValue({ agentActivitySilenceMs: 90_000 }) },
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useTaskProgress", () => {
  it("returns idle for non-in-progress statuses", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentActivitySilenceMs: 90_000 });
    const { result } = renderHook(() => useTaskProgress("backlog", null, null), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current).toBe("idle");
  });

  it("returns working while an in-flight tool is present regardless of activity age", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentActivitySilenceMs: 90_000 });
    const stale = new Date(Date.now() - 100_000).toISOString();
    const { result } = renderHook(
      () =>
        useTaskProgress("implementing", stale, {
          name: "Bash",
          startedAt: new Date().toISOString(),
        }),
      { wrapper: createWrapper(queryClient) },
    );
    expect(result.current).toBe("working");
  });

  it("returns working for recent activity", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentActivitySilenceMs: 90_000 });
    const fresh = new Date(Date.now() - 1_000).toISOString();
    const { result } = renderHook(() => useTaskProgress("implementing", fresh, null), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current).toBe("working");
  });

  it("returns hung when activity is older than the silence threshold", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["settings"], { agentActivitySilenceMs: 90_000 });
    const stale = new Date(Date.now() - 100_000).toISOString();
    const { result } = renderHook(() => useTaskProgress("implementing", stale, null), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current).toBe("hung");
  });
});
