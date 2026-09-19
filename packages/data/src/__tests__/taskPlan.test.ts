import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "../db.js";
import { projects, tasks } from "@aif/shared/schema";
import { persistTaskPlan } from "../taskPlan.js";
import { getCanonicalPlanPath } from "@aif/shared";

describe("persistTaskPlan", () => {
  it("updates DB plan and writes canonical PLAN.md", () => {
    const db = createTestDb();
    const rootPath = mkdtempSync(join(tmpdir(), "aif-task-plan-"));

    db.insert(projects)
      .values({
        id: "project-plan",
        name: "Project Plan",
        rootPath,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-plan",
        projectId: "project-plan",
        title: "Task plan",
        isFix: false,
        plan: "old",
      })
      .run();

    persistTaskPlan({
      db,
      taskId: "task-plan",
      planText: "## New Plan\n- [ ] Step 1",
      projectRoot: rootPath,
      isFix: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const row = db.select().from(tasks).where(eq(tasks.id, "task-plan")).get();
    expect(row?.plan).toBe("## New Plan\n- [ ] Step 1");
    expect(row?.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    const planPath = getCanonicalPlanPath({ projectRoot: rootPath, isFix: false });
    expect(readFileSync(planPath, "utf8")).toBe("## New Plan\n- [ ] Step 1\n");
  });

  it("resolves projectRoot/isFix from DB when omitted and writes FIX_PLAN.md", () => {
    const db = createTestDb();
    const rootPath = mkdtempSync(join(tmpdir(), "aif-task-fix-plan-"));

    db.insert(projects)
      .values({
        id: "project-fix",
        name: "Project Fix",
        rootPath,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-fix",
        projectId: "project-fix",
        title: "Fix task",
        isFix: true,
      })
      .run();

    persistTaskPlan({
      db,
      taskId: "task-fix",
      planText: "## Fix Plan\n- [ ] Reproduce",
    });

    const row = db.select().from(tasks).where(eq(tasks.id, "task-fix")).get();
    expect(row?.plan).toBe("## Fix Plan\n- [ ] Reproduce");

    const planPath = getCanonicalPlanPath({ projectRoot: rootPath, isFix: true });
    expect(readFileSync(planPath, "utf8")).toBe("## Fix Plan\n- [ ] Reproduce\n");
  });
});
