/**
 * Подготовка локального git-репозитория под подключение GitHub.
 *
 * Назначение: довести каталог проекта до рабочего состояния (origin, помощник
 * учётных данных, safe.directory, определение ветки по умолчанию, каркас AI Factory)
 * одним синхронным вызовом.
 *
 * Почему так:
 * - Общий алгоритм живёт в repositoryPrepare.ts, здесь остаётся только специфика
 *   провайдера. Файл намеренно симметричен gitlabPrepare.ts: правки в одной половине
 *   почти всегда нужно повторять в другой, иначе провайдеры разойдутся в поведении.
 * - Отличий от GitLab ровно два: форма URL удалённого репозитория и имя пользователя
 *   в учётных данных. Всё остальное обязано совпадать.
 * - Ошибки не подавляются и не повторяются: первый сбой превращается в
 *   типизированный RepositoryPrepareError, потому что частично подготовленный
 *   репозиторий опаснее явного отказа.
 */

import { findGitHubRepository, findProjectById, markGitHubRepositoryPrepared } from "@aif/data";
import { logger } from "@aif/shared";
import type { GitHubRepositoryConnection } from "@aif/shared";
import { prepareRepository, RepositoryPrepareError } from "./repositoryPrepare.js";

const log = logger("github-prepare");

export interface PrepareGitHubInput {
  projectRoot: string;
  connection: GitHubRepositoryConnection;
}

// URL строится из htmlUrl, а не из отдельного поля: так адреса GitHub Enterprise
// работают без дополнительной настройки.
// Хвостовые разделители срезаются, а суффикс .git добавляется ровно один раз - иначе
// повторная подготовка дала бы ссылку вида repo.git.git.
/**
 * HTTPS clone URL подключённого репозитория, выведенный из `htmlUrl`, чтобы
 * хосты GitHub Enterprise работали без отдельного поля конфигурации.
 */
export function buildGitHubRemoteUrl(connection: GitHubRepositoryConnection): string {
  const base = connection.htmlUrl.trim().replace(/\/+$/, "");
  return base.endsWith(".git") ? base : `${base}.git`;
}

/**
 * Авто-подготовка локального git-репозитория для подключения GitHub (только
 * стандартный git): origin, credential helper, safe.directory, определение
 * ветки по умолчанию и init скаффолдинга AI Factory (с коммитом). Это
 * GitHub-аналог GitLab-потока авто-подготовки — закрывает разрыв
 * паритета, ранее требовавший ручного клона. Выполняется синхронно;
 * при первом сбое бросает типизированную ошибку (без молчаливых повторов).
 */
export function prepareGitHubRepository(input: PrepareGitHubInput): { gitPreparedAt: string } {
  const { projectRoot, connection } = input;
  // credentialUsername фиксирован: x-access-token - соглашение GitHub для доступа по
  // токену через стандартный git credential helper. Симметричное место в GitLab
  // использует oauth2.
  const { preparedAt } = prepareRepository({
    projectId: connection.projectId,
    projectRoot,
    provider: "github",
    remoteUrl: buildGitHubRemoteUrl(connection),
    tokenEnvVar: connection.tokenEnvVar,
    credentialUsername: "x-access-token",
    defaultBranch: connection.defaultBranch,
  });

  // Отметка в базе идёт после успешной подготовки: при исключении выше она не
  // выставляется, поэтому частичный результат не выглядит завершённым.
  const prepared = markGitHubRepositoryPrepared(connection.projectId);
  log.info({ projectId: connection.projectId }, "GitHub repository prepared");
  // Приоритет у значения из базы: оно отражает фактическую запись, а preparedAt из
  // алгоритма - только момент выполнения работы. Резерв нужен для случая, когда
  // отметка не вернула строку.
  return { gitPreparedAt: prepared?.gitPreparedAt ?? preparedAt };
}

/**
 * Подготовка по HTTP: загружает проект + подключение, запускает алгоритм и
 * возвращает отметку времени подготовки. Бросает при любом сбое.
 */
// HTTP-путь: сначала находятся проект и подключение, и только потом запускается
// подготовка. Разделение даёт различимые коды ошибок для вызывающего.
export function prepareGitHubRepositoryForProject(projectId: string): { gitPreparedAt: string } {
  const project = findProjectById(projectId);
  if (!project) {
    throw new RepositoryPrepareError(
      "project_not_found",
      `Project ${projectId} not found`,
      projectId,
      "github",
    );
  }
  // Отдельная ошибка на отсутствующее подключение: клиент может предложить
  // подключить репозиторий, а не искать проблему в самом проекте.
  const connection = findGitHubRepository(projectId);
  if (!connection) {
    throw new RepositoryPrepareError(
      "connection_not_found",
      `No GitHub connection for project ${projectId}`,
      projectId,
      "github",
    );
  }
  return prepareGitHubRepository({ projectRoot: project.rootPath, connection });
}
