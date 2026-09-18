/**
 * Константы системных правил для субагентских запусков.
 *
 * Эти строки участвуют в runtime-подсказках и напрямую влияют на границы
 * исполнения в конвейере задач.
 */

// Глобальная граница области работ: только текущий корень проекта.
export const PROJECT_SCOPE_SYSTEM_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

// Граница review-режима: проверяется только дельта текущей задачи.
/**
 * Правило области работ для review-профиля.
 * Ограничивает ревью изменениями текущей задачи.
 */
export const REVIEW_DIFF_SCOPE_SYSTEM_APPEND =
  "Review scope rule: review ONLY code that changed as part of this task's implementation " +
  "(the diff introduced by the current plan's tasks). Do NOT audit unrelated files, " +
  "pre-existing code paths, or broader project concerns. If a concern is outside the changed " +
  'scope, note it briefly as "out of scope" and move on. Reference changed files/lines ' +
  "explicitly. Ignore pre-existing issues unless they are directly aggravated by the change. " +
  "Your job is to validate the delta, not the whole codebase.";
