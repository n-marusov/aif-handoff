import { describe, expect, it } from "vitest";
import { appSettings, projects, taskComments, tasks } from "../schema.js";

// BR: BR-constraint.audit.state-snapshot
// FR: REQ-FR-audit.logging.record-state-transition
// NFR: REQ-NFR-data.compliance.database-migration-integrity
// KI: KI-07

describe("shared schema contract", () => {
  it("exposes core tables and selected columns without DB driver", () => {
    expect(projects["id"]).toBeDefined();
    expect(projects["rootPath"]).toBeDefined();

    expect(tasks["id"]).toBeDefined();
    expect(tasks["status"]).toBeDefined();
    expect(tasks["plan"]).toBeDefined();
    expect(tasks["runtimeLimitSnapshotJson"]).toBeDefined();

    expect(taskComments["taskId"]).toBeDefined();
    expect(taskComments["message"]).toBeDefined();

    expect(appSettings["defaultTaskRuntimeProfileId"]).toBeDefined();
  });
});
