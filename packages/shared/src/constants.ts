/**
 * Единый источник правды по статусам задачи: подписи, цвета и порядок колонок Kanban.
 *
 * STATUS_CONFIG и ORDERED_STATUSES обязаны совпадать по составу и порядку - на них
 * опираются и доска в UI, и серверная сортировка. Статус, добавленный здесь, но
 * отсутствующий в конечном автомате (stateMachine.ts), останется недостижимым.
 */

import type { TaskStatus } from "./types.js";

export const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; order: number }> = {
  backlog: { label: "Backlog", color: "#6B7280", order: 0 },
  planning: { label: "Planning", color: "#F59E0B", order: 1 },
  improve: { label: "Improve", color: "#D97706", order: 2 },
  // PR/MR с планом опубликован и ждёт одобрения человеком до старта реализации.
  plan_review: { label: "Plan Review", color: "#6366F1", order: 3 },
  implementing: { label: "Implementing", color: "#8B5CF6", order: 4 },
  verify: { label: "Verify", color: "#0EA5E9", order: 5 },
  review: { label: "Review", color: "#EC4899", order: 6 },
  blocked_external: { label: "Blocked", color: "#EF4444", order: 7 },
  done: { label: "Done", color: "#10B981", order: 8 },
  accepted: { label: "Accepted", color: "#14B8A6", order: 9 },
};

export const ORDERED_STATUSES: TaskStatus[] = [
  "backlog",
  "planning",
  "improve",
  "plan_review",
  "implementing",
  "verify",
  "review",
  "blocked_external",
  "done",
  "accepted",
];

// Прогрев рантаймов: какие рабочие процессы поднимаются заранее при старте, чтобы
// первый запуск задачи не ждал инициализацию окружения. Каждая запись связывает вид
// workflow с профилем рантайма, из которого берутся настройки запуска.
export const WARMUP_TARGETS = [
  { workflowKind: "planner", profileMode: "plan" },
  { workflowKind: "implementer", profileMode: "task" },
  { workflowKind: "reviewer", profileMode: "review" },
] as const;

export const WARMUP_WORKFLOW_KINDS = [
  "planner",
  "implementer",
  "reviewer",
  // Аудит безопасности идёт под тем же профилем и режимом, что и обычное ревью,
  // поэтому может переиспользовать его прогретый рантайм.
  "review-security",
] as const;

export type WarmupTarget = (typeof WARMUP_TARGETS)[number];
export type WarmupWorkflowKind = (typeof WARMUP_WORKFLOW_KINDS)[number];
export type WarmupProfileMode = WarmupTarget["profileMode"];

// Прогревается только планировщик: планирование - первый этап жизненного цикла
// задачи, а поднимать все три процесса сразу означает лишний расход ресурсов.
export const DEFAULT_WARMUP_TARGET = WARMUP_TARGETS[0];

// Предикат-охранник типа: принимает произвольную строку (в том числе из БД) и
// сужает её до известного вида workflow. Нужен потому, что список видов со временем
// расширяется, а в базе могут остаться значения от прежних версий.
export function isWarmupWorkflowKind(
  workflowKind: string | null | undefined,
): workflowKind is WarmupWorkflowKind {
  return WARMUP_WORKFLOW_KINDS.some((kind) => kind === workflowKind);
}

/**
 * Префиксы каталогов, которые никогда не должны попадать в коммит.
 *
 * Это локальные артефакты инструментов: им нет места в репозитории целевого проекта,
 * поэтому они исключаются из всех коммитов и PR/MR.
 */
// Завершающая косая черта обязательна: шаблоны сравниваются с префиксом пути,
// поэтому ".claude/" отсекает каталог, но не одноимённый файл ".claude".
export const NON_COMMIT_PATH_PATTERNS = [".claude/", ".llm-backup/"] as const;
