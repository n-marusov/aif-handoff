import { describe, expect, it, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTaskProgress, useInFlightSeconds } from "@/hooks/useTaskProgress";

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

describe("useInFlightSeconds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when no tool is in flight", () => {
    const { result } = renderHook(() => useInFlightSeconds(null));
    expect(result.current).toBeNull();
  });

  it("returns elapsed seconds since the tool started", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T10:00:00.000Z"));
    const startedAt = "2026-08-16T10:00:00.000Z";
    const { result } = renderHook(() => useInFlightSeconds(startedAt));
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(result.current).toBe(12);

    act(() => {
      vi.advanceTimersByTime(48_000);
    });
    expect(result.current).toBe(60);
  });

  it("stops ticking and returns null when startedAt is cleared", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T10:00:00.000Z"));
    const initialProps: { startedAt: string | null } = {
      startedAt: "2026-08-16T10:00:00.000Z",
    };
    const { result, rerender } = renderHook(
      (props: { startedAt: string | null }) => useInFlightSeconds(props.startedAt),
      { initialProps },
    );
    expect(result.current).toBe(0);

    rerender({ startedAt: null } as { startedAt: string | null });
    expect(result.current).toBeNull();
  });
});
