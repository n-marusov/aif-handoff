import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Project, ProjectTaskOverview } from "@aif/shared/browser";
import { ProjectsOverview } from "@/components/project/ProjectsOverview";

// Регрессия загрузки пустого проекта.
//
// ProjectsOverview выводит `isLoading` из состояния overview-запроса, поэтому
// проект с нулём задач должен рендерить свою карточку (бейдж 0 / 0) вместо
// бесконечных скелетон-карточек.

const emptyProject: Project = {
  id: "proj-empty",
  name: "Empty Project",
  rootPath: "/tmp/empty",
  plannerMaxBudgetUsd: null,
  planCheckerMaxBudgetUsd: null,
  implementerMaxBudgetUsd: null,
  reviewSidecarMaxBudgetUsd: null,
  pinnedAt: null,
  groupName: null,
  autoQueueMode: false,
  parallelEnabled: false,
  defaultTaskRuntimeProfileId: null,
  defaultPlanRuntimeProfileId: null,
  defaultReviewRuntimeProfileId: null,
  defaultChatRuntimeProfileId: null,
  tokenInput: undefined,
  tokenOutput: undefined,
  tokenTotal: undefined,
  costUsd: undefined,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const emptyOverview: ProjectTaskOverview = {
  projectId: "proj-empty",
  lastActivityAt: null,
  totalTasks: 0,
  completedTasks: 0,
  acceptedTasks: 0,
  backlogTasks: 0,
  activeTasks: 0,
  blockedTasks: 0,
  autoModeTasks: 0,
  fixTasks: 0,
  totalRetries: 0,
  totalTokenInput: 0,
  totalTokenOutput: 0,
  totalTokenTotal: 0,
  totalCostUsd: 0,
  statusCounts: {
    backlog: 0,
    planning: 0,
    improve: 0,
    plan_review: 0,
    implementing: 0,
    review: 0,
    verify: 0,
    blocked_external: 0,
    done: 0,
    accepted: 0,
  },
  statusPreviews: {
    backlog: [],
    planning: [],
    improve: [],
    plan_review: [],
    implementing: [],
    review: [],
    verify: [],
    blocked_external: [],
    done: [],
    accepted: [],
  },
};

describe("ProjectsOverview empty-project loading regression", () => {
  it("does not stay in loading state when a project has zero tasks", () => {
    // Симулируем разрешённое состояние useProjectTaskOverviews:
    // overview-запрос успешно завершился для проекта без задач (без загрузки).
    vi.mock("@/hooks/useProjects", () => ({
      useProjectTaskOverviews: () => ({
        data: [emptyOverview],
        isLoading: false,
      }),
    }));

    render(<ProjectsOverview projects={[emptyProject]} onSelectProject={() => {}} />);

    // Карточка проекта должна отрендериться (не скелетоны). Бейдж "0 / 0"
    // подтверждает: пустой проект разрешился в настоящую карточку без загрузки.
    expect(screen.getByText("Empty Project")).toBeDefined();
    expect(screen.getByText("0 / 0")).toBeDefined();
    // Скелетоны рендериться не должны.
    expect(screen.queryByRole("status")).toBeNull();
  });
});
