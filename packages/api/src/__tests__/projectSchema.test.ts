import { describe, expect, it } from "vitest";
import { createProjectSchema } from "../schemas.js";

describe("createProjectSchema", () => {
  it("accepts a name-only payload (rootPath optional)", () => {
    const result = createProjectSchema.safeParse({ name: "My Project" });
    expect(result.success).toBe(true);
  });

  it("still accepts an explicit rootPath", () => {
    const result = createProjectSchema.safeParse({
      name: "Demo",
      rootPath: "/home/www/demo",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty rootPath when it is provided", () => {
    const result = createProjectSchema.safeParse({ name: "Demo", rootPath: "" });
    expect(result.success).toBe(false);
  });
});
