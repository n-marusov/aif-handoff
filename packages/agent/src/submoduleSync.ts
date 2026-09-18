/**
 * Best-effort синхронизация git-сабмодулей проекта.
 *
 * Инициализация выполняется на каждом sync, а не только при первой подготовке
 * репозитория: так проекты, подключённые раньше, тоже получат заполненные
 * сабмодули. Команда идемпотентна, поэтому повторные вызовы безопасны, а ошибка
 * никогда не прерывает импорт проекта - недоступный URL или проблема с
 * авторизацией сабмодуля остаются шумом в логе, а не поводом для отката.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectById } from "@aif/data";
import { logger } from "@aif/shared";

const log = logger("submodule-sync");

export interface SubmoduleSyncResult {
  ok: boolean;
  submodulesInitialized?: boolean;
  error?: string;
}

/**
 * Best-effort init git-подмодулей уже подготовленного репозитория проекта.
 *
 * Выполняет `git submodule update --init --recursive`, когда есть .gitmodules.
 * Рассчитан на вызов при каждом sync (а не только при первой подготовке), чтобы
 * проекты, подключённые до выката фичи инициализации подмодулей, тоже получили
 * заполненные подмодули.
 *
 * Вызов не блокирует — сбой (недоступный URL подмодуля, ошибка авторизации)
 * логируется, но никогда не пробрасывается: рабочий процесс импорта должен
 * продолжаться, даже если подмодули загрузить не удалось.
 */
export function syncProjectSubmodules(projectId: string): SubmoduleSyncResult {
  const project = findProjectById(projectId);
  // Проект может быть ещё не подготовлен: тогда синхронизировать просто нечего.
  if (!project?.rootPath) {
    log.debug({ projectId }, "Submodule sync skipped: no project root");
    return { ok: true, submodulesInitialized: false };
  }

  // Наличие .gitmodules - единственный признак того, что сабмодули вообще есть.
  const gitmodulesPath = join(project.rootPath, ".gitmodules");
  if (!existsSync(gitmodulesPath)) {
    log.debug({ projectId }, "No .gitmodules found; skipping submodule sync");
    return { ok: true, submodulesInitialized: false };
  }

  log.info({ projectId, projectRoot: project.rootPath }, "Syncing git submodules");
  try {
    // execFileSync без shell: список аргументов фиксирован, подстановки путей нет.
    execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
      cwd: project.rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    log.info({ projectId }, "Submodules synchronized");
    return { ok: true, submodulesInitialized: true };
  } catch (err) {
    // Ошибка возвращается вызывающему как данные, а не выбрасывается дальше.
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ projectId, err: message }, "Submodule sync failed (non-blocking)");
    return { ok: false, submodulesInitialized: false, error: message };
  }
}
