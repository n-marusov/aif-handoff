/**
 * Сборка промптов для git-коммита.
 *
 * Модуль сам git не запускает: он формирует текстовую инструкцию для агента, поэтому
 * промпт здесь - это контракт. Пропущенный пункт (например, запрет push) означает, что
 * агент поступит иначе. Инфраструктурные каталоги из NON_COMMIT_PATH_PATTERNS исключаются
 * из индекса во всех вариантах промпта, иначе локальные артефакты инструментов уедут в
 * коммит.
 */

import { NON_COMMIT_PATH_PATTERNS } from "./constants.js";

const NEVER_STAGE_PATTERNS = NON_COMMIT_PATH_PATTERNS;
// Готовая формулировка запрета: подставляется в оба промпта дословно, чтобы правило
// не разошлось между интерактивным и авто-очередным сценариями.
const NEVER_STAGE_NOTE = `Do NOT stage or commit infrastructure directories: ${NEVER_STAGE_PATTERNS.join(", ")}. These are local tooling artifacts and must not appear in the repository.`;

// Промпт интерактивного коммита. Единственное отличие ветки push - текст пункта 5:
// проект может быть настроен на commit-only (`git.skip_push_after_commit: true`),
// и тогда инструкция должна прямо запрещать push, а не умалчивать о нём.
export function buildCommitPrompt(shouldPush: boolean): string {
  const pushLine = shouldPush
    ? "5. After committing, run `git push` on the current branch. Do not force-push."
    : "5. Do NOT push. The project is configured with `git.skip_push_after_commit: true` — commit only.";

  return [
    "You are running the aif-commit workflow. Follow these steps exactly:",
    "",
    "1. Run `git status` to see the current working tree.",
    `2. Stage all changes, excluding infrastructure directories. Run: git add -A && git reset -- ${NEVER_STAGE_PATTERNS.map((p) => `${p}`).join(" ")}`,
    `   ${NEVER_STAGE_NOTE}`,
    "3. Analyze the staged diff (`git diff --cached`) and draft ONE conventional commit message (feat/fix/chore/docs/refactor/test/perf, optional scope, short subject, body if helpful).",
    "4. Create the commit with `git commit -m ...`. Create exactly one commit. Do not amend.",
    pushLine,
    "",
    "Hard rules:",
    "- Never skip git hooks (no --no-verify).",
    "- Never rewrite history (no rebase, no reset --hard, no amend).",
    "- Never add the `Co-Authored-By` trailer.",
    "- If there are no changes to commit, report that and stop — do NOT create an empty commit.",
  ].join("\n");
}

/**
 * Неинтерактивный промпт коммита для автоочереди.
 *
 * Отличия от {@link buildCommitPrompt}:
 * 1. Модель обязана работать через инструмент `shell_exec`, а не запускать команды
 *    напрямую: при API-транспорте доступны только инструменты рабочего пространства.
 * 2. Шаг подтверждения отсутствует - модель коммитит автоматически, не спрашивая
 *    пользователя.
 * 3. Используется в {@link ensureAutoQueueTaskCommit}, когда транспорт рантайма не даёт
 *    нативного доступа к shell и git (например, API-транспорт).
 */
export function buildAutoQueueCommitPrompt(): string {
  const resetPathList = NEVER_STAGE_PATTERNS.join(" ");
  return [
    "You are running the auto-queue commit workflow. Commit all changes without questions.",
    "",
    "Available workspace tools: read_file, list_dir, write_file, apply_patch, shell_exec.",
    // При API-транспорте прямой доступ к оболочке не выдаётся: единственный способ
    // выполнить git - вызвать инструмент shell_exec, поэтому это указано отдельно.
    "Use the `shell_exec` tool to run ALL shell commands — including git commands.",
    "",
    "Follow these steps exactly:",
    "",
    '1. Run `git status --porcelain` via shell_exec: {"command": "git status --porcelain"}.',
    "   If there are no changes, report that nothing to commit and stop.",
    `2. Stage all changes, excluding infrastructure directories: {"command": "git add -A && git reset -- ${resetPathList}"}.`,
    `   ${NEVER_STAGE_NOTE}`,
    '3. Analyze the staged diff: {"command": "git diff --cached"}.',
    "4. Draft ONE conventional commit message (feat/fix/chore/docs/refactor/test/perf, optional scope, short subject, body if helpful).",
    '5. Create the commit: {"command": "git commit -m <subject> -m <body>"}. Use exactly one commit. Do not amend.',
    "",
    // Жёсткие правила дублируются здесь намеренно: промпт остаётся единственным
    // контролем над агентом в неинтерактивном режиме, где нет человека для
    // подтверждения действий.
    "Hard rules:",
    "- Never skip git hooks (no --no-verify flag for git commit).",
    "- Never rewrite history (no rebase, no reset --hard, no amend).",
    "- Never add the `Co-Authored-By` trailer.",
    "- If there are no changes to commit, report that and stop — do NOT create an empty commit.",
    "- Do NOT ask the user for confirmation. Commit immediately.",
    // Push выполняет сам конвейер уже после коммита: если агент запушит здесь, ветка
    // уйдёт в удалённый репозиторий до прохождения гейтов автоматизации.
    "- Do NOT push. The auto-queue flow will push the branch after the commit.",
  ].join("\n");
}
