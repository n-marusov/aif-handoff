/**
 * Создание базовой структуры каталога проекта: сам каталог и git-репозиторий.
 *
 * Каталог .ai-factory/ здесь НЕ создаётся намеренно: его создаёт только `ai-factory init`,
 * и отсутствие этой папки служит корректным признаком того, что инициализация не
 * завершилась и её можно безопасно повторить. Это низкоуровневый примитив: вызывающий код
 * обычно использует runtime-осведомлённый initProject() из @aif/runtime, который
 * дополнительно запускает `ai-factory init`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { logger } from "./logger.js";

const log = logger("project-init");

export function initBaseProjectDirectory(projectRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });

  // Проверка существующего .git делает операцию идемпотентной: повторный вызов на
  // уже инициализированном проекте не пересоздаёт историю и не затирает коммиты.
  const gitDir = resolve(projectRoot, ".git");
  if (!existsSync(gitDir)) {
    try {
      execSync("git init", { cwd: projectRoot, stdio: "ignore" });
      execSync("git add -A", { cwd: projectRoot, stdio: "ignore" });
      execSync('git commit -m "init: project scaffold"', {
        cwd: projectRoot,
        stdio: "ignore",
      });
      log.info({ projectRoot }, "Initialized git repo");
    } catch (err) {
      // Ошибка git не прерывает инициализацию: каталог проекта уже создан, а
      // отсутствие репозитория пользователь обнаружит позже и исправит вручную.
      log.warn({ projectRoot, err }, "git init failed");
    }
  }
}
