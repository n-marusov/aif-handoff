/**
 * Подготовка локального git-репозитория под подключение GitLab.
 *
 * Назначение: довести каталог проекта до рабочего состояния (origin, помощник
 * учётных данных, safe.directory, определение ветки по умолчанию, каркас AI Factory)
 * одним синхронным вызовом.
 *
 * Почему так:
 * - Файл - зеркало githubPrepare.ts: общий алгоритм вынесен в repositoryPrepare.ts, а
 *   здесь остаётся только специфика провайдера. Правки в одной половине почти всегда
 *   нужно повторять в другой, иначе провайдеры разойдутся в поведении.
 * - Отличий от GitHub ровно два: URL берётся из webUrl как есть, а имя пользователя
 *   для токена - oauth2. Всё остальное обязано совпадать.
 * - Псевдонимы GitLabPrepareError сохраняют исторические имена: вызывающий код ловит
 *   их по старому названию, хотя тип общий.
 * - Ошибки не подавляются: первый сбой становится типизированным
 *   RepositoryPrepareError, потому что частично подготовленный репозиторий опаснее
 *   явного отказа.
 */

import { findGitLabRepository, findProjectById, markGitLabRepositoryPrepared } from "@aif/data";
import { logger } from "@aif/shared";
import type { GitLabRepositoryConnection } from "@aif/shared";
import {
  prepareRepository,
  RepositoryPrepareError,
  RepositoryPrepareErrorKind,
} from "./repositoryPrepare.js";

const log = logger("gitlab-prepare");

// Реэкспорт, а не отдельный класс: два похожих типа ошибок разошлись бы в
// поведении, а различает пути поле provider внутри общей ошибки.
/**
 * GitLab-псевдоним общей ошибки подготовки. Общий
 * {@link RepositoryPrepareError} несёт `provider: "gitlab"` на этом пути,
 * поэтому вызывающие могут продолжать ловить историческое имя.
 */
export { RepositoryPrepareError as GitLabPrepareError };
export type { RepositoryPrepareErrorKind as GitLabPrepareErrorKind };

export interface PrepareGitLabInput {
  projectRoot: string;
  connection: GitLabRepositoryConnection;
}

/**
 * Авто-подготовка локального git-репозитория для подключения GitLab (только
 * стандартный git): origin, credential helper, safe.directory, определение
 * ветки по умолчанию и init скаффолдинга AI Factory (с коммитом). Выполняется
 * синхронно; при первом сбое бросает типизированную ошибку (без молчаливых
 * повторов).
 */
export function prepareGitLabRepository(input: PrepareGitLabInput): { gitPreparedAt: string } {
  const { projectRoot, connection } = input;
  // webUrl уже пригоден для git: в отличие от GitHub, суффикс .git не добавляется,
  // потому что ссылка GitLab на репозиторий совпадает с clone URL.
  // credentialUsername фиксирован: oauth2 - соглашение GitLab для доступа по токену
  // через стандартный git credential helper. Симметричное место в GitHub использует
  // x-access-token.
  const { preparedAt } = prepareRepository({
    projectId: connection.projectId,
    projectRoot,
    provider: "gitlab",
    remoteUrl: connection.webUrl.trim(),
    tokenEnvVar: connection.tokenEnvVar,
    credentialUsername: "oauth2",
    defaultBranch: connection.defaultBranch,
  });

  // Отметка ставится только после успешной подготовки: при исключении выше она не
  // выставляется, поэтому частичный результат не выглядит завершённым.
  const prepared = markGitLabRepositoryPrepared(connection.projectId);
  log.info({ projectId: connection.projectId }, "GitLab repository prepared");
  // Значение из базы приоритетнее: оно фиксирует фактическую запись, а preparedAt из
  // алгоритма - только момент выполнения работы. Резерв нужен для случая, когда
  // отметка не вернула строку.
  return { gitPreparedAt: prepared?.gitPreparedAt ?? preparedAt };
}

/**
 * Подготовка по HTTP: загружает проект + подключение, запускает алгоритм и
 * возвращает отметку времени подготовки. Бросает при любом сбое.
 */
// HTTP-путь: сначала проект и подключение, затем подготовка. Разделение даёт
// различимые коды ошибок project_not_found и connection_not_found.
export function prepareGitLabRepositoryForProject(projectId: string): { gitPreparedAt: string } {
  const project = findProjectById(projectId);
  if (!project) {
    throw new RepositoryPrepareError(
      "project_not_found",
      `Project ${projectId} not found`,
      projectId,
      "gitlab",
    );
  }
  // Отдельная ошибка на отсутствующее подключение: клиент может предложить
  // подключить репозиторий, а не искать проблему в самом проекте.
  const connection = findGitLabRepository(projectId);
  if (!connection) {
    throw new RepositoryPrepareError(
      "connection_not_found",
      `No GitLab connection for project ${projectId}`,
      projectId,
      "gitlab",
    );
  }
  return prepareGitLabRepository({ projectRoot: project.rootPath, connection });
}
