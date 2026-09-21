import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Guard-контракт E2E-стенда (docker-compose.e2e.yml + scripts/e2e-docker.mjs +
// .env.e2e.example). Защищает от регрессий класса
// «GitLab root не создаётся из-за пароля, который не проходит проверку
// сложности, или дефолты стенда разъезжаются между файлами».
//
// Файлы лежат в корне репозитория и есть не во всех окружениях (например, в
// CI-контейнере api без полного COPY контекста), поэтому тест исполняется
// только там, где файлы доступны: отсутствие стендовых файлов — это
// «не применимо», а не провал.
//
// Корень репозитория ищем подъёмом от process.cwd() до каталога со стендовым
// compose-файлом: vitest может стартовать и из корня пакета, и из корня
// репозитория (npx ищет vitest в node_modules выше), полагаться на cwd нельзя.
function findRepoRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(resolve(dir, "docker-compose.e2e.yml"))) return dir;
    const parent = dirname(resolve(dir));
    if (parent === resolve(dir)) return dir;
    dir = parent;
  }
}

const repoRoot = findRepoRoot();

// Paths построены через resolve(), а не конкатенацией: конкатенация на
// window\-путях и путях без хвостового разделителя даёт невалидные имена,
// existsSync всегда false и весь сьют молча уходил в skip (описанный guard
// контракта стенда не работал).
const STAND_FILES = [
  resolve(repoRoot, "docker-compose.e2e.yml"),
  resolve(repoRoot, "scripts/e2e-docker.mjs"),
  resolve(repoRoot, ".env.e2e.example"),
];

const standAvailable = STAND_FILES.every(existsSync);

/** Вытаскивает дефолтный root-пароль из исходника e2e-скрипта. */
function passwordFromScript(): string | undefined {
  const source = readFileSync(resolve(repoRoot, "scripts/e2e-docker.mjs"), "utf8");
  return source.match(/DEFAULT_GITLAB_ROOT_PASSWORD\s*=\s*"([^"]+)"/)?.[1];
}

/** Вытаскивает дефолт ${GITLAB_ROOT_PASSWORD:-…} из compose-расширения. */
function passwordFromCompose(): string | undefined {
  const source = readFileSync(resolve(repoRoot, "docker-compose.e2e.yml"), "utf8");
  return source.match(/\$\{GITLAB_ROOT_PASSWORD:-([^}]+)\}/)?.[1];
}

/** Вытаскивает GITLAB_ROOT_PASSWORD=… из шаблона .env.e2e. */
function passwordFromEnvTemplate(): string | undefined {
  const source = readFileSync(resolve(repoRoot, ".env.e2e.example"), "utf8");
  return source.match(/^GITLAB_ROOT_PASSWORD=(.+)$/m)?.[1]?.trim();
}

/** GitLab отклоняет пароли со словарными словами/username (для root это "root"). */
function looksGitLabValid(password: string): boolean {
  return password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

describe.skipIf(!standAvailable)("E2E GitLab stand contract", () => {
  it("keeps a single, GitLab-valid GITLAB_ROOT_PASSWORD default across all files", () => {
    const passwords = [passwordFromScript(), passwordFromCompose(), passwordFromEnvTemplate()];

    expect(new Set(passwords).size, JSON.stringify(passwords)).toBe(1);
    const [password] = passwords;
    expect(password, "default password must be set").toBeDefined();
    expect(password!.toLowerCase(), "must not contain the username 'root'").not.toContain("root");
    expect(password, "must pass GitLab's minimum strength heuristic").toSatisfy(looksGitLabValid);
  });
});
