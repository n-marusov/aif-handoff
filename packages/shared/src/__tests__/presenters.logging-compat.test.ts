import { describe, expect, it, vi } from "vitest";

const warn = vi.fn();

vi.mock("../logger.js", () => ({
  logger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  }),
}));

const { parseRuntimeLimitSnapshot } = await import("../presenters.js");

// BR: BR-fact.audit.observability
// FR: REQ-FR-audit.errors.classify-runtime-error
// NFR: REQ-NFR-ops.observability.log-level-config
// KI: KI-06

describe("presenters logging compatibility", () => {
  it("logs malformed runtime-limit snapshot under shared component semantics", () => {
    warn.mockClear();

    const snapshot = parseRuntimeLimitSnapshot("{broken", "task", "task-1");
    expect(snapshot).toBeNull();

    expect(warn).toHaveBeenCalled();
    const calls = JSON.stringify(warn.mock.calls);
    expect(calls).toContain("Malformed persisted runtime-limit snapshot");
    expect(calls).toContain("json_parse_failed");
  });
});
