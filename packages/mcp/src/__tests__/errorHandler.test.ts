import { describe, it, expect } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { toMcpError, rateLimitError, validationError } from "../middleware/errorHandler.js";

describe("errorHandler", () => {
  describe("toMcpError", () => {
    it("passes through McpError unchanged", () => {
      const err = new McpError(ErrorCode.InvalidParams, "test");
      expect(toMcpError(err)).toBe(err);
    });

    it("converts generic errors to internal error", () => {
      const err = new Error("something broke");
      const result = toMcpError(err);
      expect(result).toBeInstanceOf(McpError);
      expect(result.code).toBe(ErrorCode.InternalError);
    });

    it("handles non-Error values", () => {
      const result = toMcpError("string error");
      expect(result).toBeInstanceOf(McpError);
      expect(result.code).toBe(ErrorCode.InternalError);
      expect(result.message).toContain("string error");
    });
  });

  describe("rateLimitError", () => {
    it("creates rate limit error with tool name", () => {
      const err = rateLimitError("handoff_list_tasks");
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(ErrorCode.InvalidRequest);
      expect(err.message).toContain("handoff_list_tasks");
    });
  });

  describe("validationError", () => {
    it("creates validation error with message", () => {
      const err = validationError("Bad input");
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(ErrorCode.InvalidParams);
      expect(err.message).toContain("Bad input");
    });

    it("includes field errors when provided", () => {
      const err = validationError("Invalid", { taskId: ["must be UUID"] });
      expect(err.message).toContain("taskId");
      expect(err.message).toContain("must be UUID");
    });
  });
});
