import { describe, it, expect, vi, beforeEach } from "vitest";
import { broadcastTaskEvent } from "../notifier.js";

describe("broadcastTaskEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST request to broadcast endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await broadcastTaskEvent("http://localhost:3009", "task-123", "task:updated");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3009/tasks/task-123/broadcast",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("task:updated");
  });

  it("handles non-OK response without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    // Не должен бросать исключение
    await broadcastTaskEvent("http://localhost:3009", "task-123", "sync:task_updated");
  });

  it("handles fetch errors without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    // Не должен бросать исключение
    await broadcastTaskEvent("http://localhost:3009", "task-123", "task:created");
  });
});
