import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    ...opts,
  });
  document.dispatchEvent(event);
}

describe("useKeyboardShortcut", () => {
  it("fires handler on matching key", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut({ key: "Escape" }, handler));

    fireKey("Escape");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores non-matching keys", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut({ key: "Escape" }, handler));

    fireKey("Enter");
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires meta when meta: true", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut({ key: "KeyK", meta: true }, handler));

    fireKey("KeyK");
    expect(handler).not.toHaveBeenCalled();

    fireKey("KeyK", { metaKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("accepts ctrlKey as meta substitute", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut({ key: "KeyK", meta: true }, handler));

    fireKey("KeyK", { ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("requires shift when shift: true", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut({ key: "Enter", shift: true }, handler));

    fireKey("Enter");
    expect(handler).not.toHaveBeenCalled();

    fireKey("Enter", { shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does nothing when enabled is false", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut({ key: "Escape", enabled: false }, handler));

    fireKey("Escape");
    expect(handler).not.toHaveBeenCalled();
  });

  it("cleans up on unmount", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcut({ key: "Escape" }, handler));

    unmount();
    fireKey("Escape");
    expect(handler).not.toHaveBeenCalled();
  });

  it("matches by event.code for key codes like KeyK", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcut({ key: "KeyK", meta: true }, handler));

    // event.key = "k", но event.code = "KeyK"
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: true,
        bubbles: true,
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
