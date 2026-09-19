import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type {
  TaskAssigneeSummary,
  TaskListItemRow as SharedListItemRow,
  TaskSummaryRow as SharedSummaryRow,
  RuntimeProfileUsageState as SharedUsageState,
} from "@aif/shared";
import type { ListTaskListItemRow, TaskSummaryRow } from "../index.js";
import type { RuntimeProfileUsageState } from "../usage.js";

// Known issue: "Дублирование типов-проекций строк между `@aif/shared/presenters.ts` и `@aif/data`".
// Reproducer (Task 7): projection types have a single definition in @aif/shared; @aif/data
// imports them instead of re-declaring `Pick<TaskRow, ...>` projections.

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time assertions that data's exported result shapes match the shared definitions.
type _ListRowMatchesShared = Expect<
  Equal<ListTaskListItemRow, SharedListItemRow & { assignees: TaskAssigneeSummary[] }>
>;
type _SummaryRowMatchesShared = Expect<Equal<TaskSummaryRow, SharedSummaryRow>>;
type _UsageStateMatchesShared = Expect<Equal<RuntimeProfileUsageState, SharedUsageState>>;

describe("projection type definitions", () => {
  it("keeps no local Pick<TaskRow, ...> projection declarations in data", () => {
    for (const file of ["../tasks.ts", "../usage.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/Pick<TaskRow,/);
    }
  });

  it("exports the shared projection types from the data barrel", () => {
    // Runtime assertion keeps the module executed; the type checks above are compile-time.
    expect(true).toBe(true);
  });
});
