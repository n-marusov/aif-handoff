/**
 * Репозиторий проектов уровня API.
 *
 * Назначение: быть единственной точкой, через которую HTTP-слой создает,
 * изменяет и удаляет проекты. Прямой доступ к БД из пакета api запрещен
 * линтером, поэтому все операции записи делегируются в @aif/data, а здесь
 * остаются правила, которых в хранилище нет:
 *
 * 1. Проверка уникальности имени до записи. Без нее пользователь увидел бы
 *    ошибку уникального индекса вместо понятного nameError.
 * 2. Перевод пути из хост-пространства в контейнерное. API работает и на
 *    хосте, и внутри Docker, где PROJECTS_DIR и PROJECTS_MOUNT описывают
 *    один и тот же каталог разными строками.
 * 3. Инициализация рабочего каталога (initProject) с откатом уже созданной
 *    записи БД, если инициализация провалилась. Без отката в базе остался бы
 *    проект, указывающий на несуществующий каталог.
 *
 * Внимание: для проверок дублей и занятых путей список проектов читается
 * целиком (listProjects). Это осознанный компромисс: проектов мало, а
 * согласованность здесь важнее микрооптимизации.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { initProject } from "@aif/runtime";
import { slugify, validateProjectRootPath, logger } from "@aif/shared";
import type { UpdateProjectOrganizationInput } from "@aif/shared";
import { getApiRuntimeRegistry } from "../services/runtime.js";
import {
  createProject as createProjectRecord,
  deleteProject as deleteProjectRecord,
  findProjectById,
  listProjectTaskOverviews,
  listProjects,
  type ProjectRow,
  updateProject as updateProjectRecord,
  updateProjectOrganization as updateProjectOrganizationRecord,
} from "@aif/data";

const log = logger("projects-repo");

// Каталог, под которым проекты видны внутри контейнера. Значение осмысленно
// только когда API само запущено в контейнере: хостовый путь там бесполезен.
// Возврат /home/www - совместимость с историческим образом Angie.
function readContainerProjectsMount(): string {
  const configured = process.env.PROJECTS_MOUNT?.trim();
  return configured && posix.isAbsolute(configured) ? posix.resolve(configured) : "/home/www";
}

// Вложенность проверяется через relative, а не через startsWith: строковое
// сравнение считает "/srv/projects-old" лежащим внутри "/srv/projects".
function isWithinPath(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// win32.relative ведет себя предсказуемее на смешанных путях, если сначала
// привести все разделители к обратным слэшам.
function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\");
}

// Аналог isWithinPath для posix-путей: контейнерные пути, попавшие в API с
// Windows-хоста, нельзя разбирать платформенным relative.
function isWithinPosixPath(basePath: string, candidatePath: string): boolean {
  const rel = posix.relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel));
}

// PROJECTS_DIR бывает как абсолютным, так и относительным. Во втором случае
// его нужно раскрыть от PROJECTS_HOST_ROOT: process.cwd() контейнера не
// совпадает с каталогом на хосте, и resolve дал бы неверный путь.
function resolveHostProjectsDir(hostProjectsDir: string): string {
  if (isAbsolute(hostProjectsDir)) return resolve(hostProjectsDir);

  const hostRoot = process.env.PROJECTS_HOST_ROOT?.trim();
  return hostRoot && isAbsolute(hostRoot)
    ? resolve(hostRoot, hostProjectsDir)
    : resolve(hostProjectsDir);
}

// Единая точка перевода путей "хост -> контейнер". Вызывается и при
// создании, и при обновлении проекта, поэтому один и тот же путь,
// введенный в UI, всегда нормализуется одинаково.
function mapProjectPathToContainer(rootPath: string): string {
  // Если PROJECTS_DIR не задан, API работает на хосте и менять путь не нужно.
  const hostProjectsDir = process.env.PROJECTS_DIR?.trim();
  const containerProjectsMount = readContainerProjectsMount();

  if (hostProjectsDir) {
    const resolvedRootPath = resolve(rootPath);
    const resolvedHostProjectsDir = resolveHostProjectsDir(hostProjectsDir);

    // Основной случай: путь действительно лежит внутри PROJECTS_DIR.
    if (isWithinPath(resolvedHostProjectsDir, resolvedRootPath)) {
      const rel = relative(resolvedHostProjectsDir, resolvedRootPath);
      return rel
        ? posix.join(containerProjectsMount, rel.split(sep).join(posix.sep))
        : containerProjectsMount;
    }

    // Резервная ветка для Windows-хоста: node:path на Linux-раннере не
    // распознает "C:\\..." как абсолютный путь, поэтому проверяем win32-логикой.
    if (win32.isAbsolute(hostProjectsDir) && win32.isAbsolute(rootPath)) {
      const windowsHostProjectsDir = win32.resolve(normalizeWindowsPath(hostProjectsDir));
      const windowsRootPath = win32.resolve(normalizeWindowsPath(rootPath));
      // Проверка вложенности инлайновая, а не через isWithinPath: здесь
      // разделитель всегда "\\", тогда как sep зависит от платформы рантайма.
      const rel = win32.relative(windowsHostProjectsDir, windowsRootPath);
      if (rel === "" || (rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel))) {
        return rel
          ? posix.join(containerProjectsMount, rel.split("\\").join(posix.sep))
          : containerProjectsMount;
      }
    }
  }

  // Здесь читается сырой PROJECTS_MOUNT, а не readContainerProjectsMount:
  // нужно отличить "переменная не задана" от значения по умолчанию, иначе
  // хостовый путь был бы молча переписан под /home/www.
  const configuredProjectsMount = process.env.PROJECTS_MOUNT?.trim();
  if (
    !configuredProjectsMount ||
    !posix.isAbsolute(configuredProjectsMount) ||
    !posix.isAbsolute(rootPath)
  ) {
    return rootPath;
  }

  const normalizedRootPath = posix.resolve(rootPath);
  // Путь уже находится внутри точки монтирования - оставляем без изменений.
  if (isWithinPosixPath(containerProjectsMount, normalizedRootPath)) {
    return normalizedRootPath;
  }

  // Иначе абсолютный путь переносится под точку монтирования. Ведущий слэш
  // отбрасывается: с ним posix.join отбросил бы базовый каталог целиком.
  return posix.join(containerProjectsMount, normalizedRootPath.slice(1));
}

// Сравнение имен без учета регистра и формы Unicode: одна и та же строка,
// записанная в NFC и в NFD, должна распознаваться как дубль.
function normalizeProjectName(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

// Дубликат вычисляется в API, а не в @aif/data: решение принимается до
// записи, чтобы вернуть nameError вместо исключения драйвера БД.
// excludeId позволяет тому же проекту сохранить собственное имя.
function findDuplicateProjectName(name: string, excludeId: string | null): ProjectRow | undefined {
  const normalized = normalizeProjectName(name);
  if (!normalized) return undefined;
  return listProjects().find(
    (project) => project.id !== excludeId && normalizeProjectName(project.name) === normalized,
  );
}

// Когда путь не задан вручную, он выводится из имени: slug плюс числовой
// суффикс, пока значение не окажется свободным.
function resolveGeneratedProjectRootPath(name: string): string {
  const base = readContainerProjectsMount();
  const slug = slugify(name);
  const taken = new Set(listProjects().map((project) => project.rootPath.toLowerCase()));

  // Занятость берется из БД, а не из файловой системы: так два проекта не
  // укажут на один каталог даже до физического создания каталога.
  let candidate = posix.join(base, slug);
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = posix.join(base, `${slug}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

// Создание проекта: сначала проверки и запись в БД, затем инициализация
// каталога. Обратный порядок был бы хуже: при провале валидации на диске
// оставался бы мусорный каталог, который никто не убирает за API.
export async function createProject(input: {
  name: string;
  rootPath?: string;
  plannerMaxBudgetUsd?: number | null;
  planCheckerMaxBudgetUsd?: number | null;
  implementerMaxBudgetUsd?: number | null;
  reviewSidecarMaxBudgetUsd?: number | null;
  parallelEnabled?: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}): Promise<{ project?: ProjectRow; nameError?: string; pathError?: string; initError?: string }> {
  const duplicate = findDuplicateProjectName(input.name, null);
  if (duplicate) {
    return {
      project: undefined,
      nameError: `A project named "${input.name.trim()}" already exists`,
    };
  }

  const rootPath = input.rootPath
    ? mapProjectPathToContainer(input.rootPath)
    : resolveGeneratedProjectRootPath(input.name);

  const pathError = validateProjectRootPath(rootPath);
  if (pathError) return { project: undefined, pathError };

  // В хранилище уходит уже нормализованный путь, чтобы БД не содержала двух
  // форм записи одного и того же каталога.
  const normalizedInput = { ...input, rootPath };
  const project = createProjectRecord(normalizedInput);

  // initProject создает рабочий каталог и служебные файлы. Падение возможно
  // двумя способами - значением ok=false и исключением, - и обе ветки обязаны
  // привести к одному результату.
  try {
    const registry = await getApiRuntimeRegistry();
    const result = initProject({ projectRoot: normalizedInput.rootPath, registry });
    if (!result.ok) {
      log.error(
        { projectId: project?.id, rootPath: normalizedInput.rootPath, error: result.error },
        "Project init failed, rolling back project record",
      );
      // Откат обязателен: без него проект остался бы виден в UI, но был бы
      // неработоспособен, а повторное создание с тем же именем упало бы на
      // проверке дубля.
      if (project) {
        deleteProjectRecord(project.id);
      }
      return { project: undefined, initError: result.error };
    }
  } catch (err) {
    log.error(
      { projectId: project?.id, rootPath: normalizedInput.rootPath, err },
      "Project init failed, rolling back project record",
    );
    if (project) {
      deleteProjectRecord(project.id);
    }
    return {
      project: undefined,
      initError: `Project initialization failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { project };
}

// Обновление повторяет проверки создания, но с двумя отличиями: сам проект
// исключается из поиска дубля, а прежний rootPath сохраняется, если новый не
// передан, - иначе частичное обновление стерло бы путь к каталогу.
export function updateProject(
  id: string,
  input: {
    name: string;
    rootPath?: string;
    plannerMaxBudgetUsd?: number | null;
    planCheckerMaxBudgetUsd?: number | null;
    implementerMaxBudgetUsd?: number | null;
    reviewSidecarMaxBudgetUsd?: number | null;
    parallelEnabled?: boolean;
    defaultTaskRuntimeProfileId?: string | null;
    defaultPlanRuntimeProfileId?: string | null;
    defaultReviewRuntimeProfileId?: string | null;
    defaultChatRuntimeProfileId?: string | null;
  },
): { project?: ProjectRow; nameError?: string; pathError?: string } {
  const existing = findProjectById(id);
  if (!existing) return { project: undefined };

  const duplicate = findDuplicateProjectName(input.name, id);
  if (duplicate) {
    return {
      project: undefined,
      nameError: `A project named "${input.name.trim()}" already exists`,
    };
  }

  const rootPath = input.rootPath ? mapProjectPathToContainer(input.rootPath) : existing.rootPath;

  const pathError = validateProjectRootPath(rootPath);
  if (pathError) return { project: undefined, pathError };

  return { project: updateProjectRecord(id, { ...input, rootPath }) };
}

// Тонкая обертка намеренно оставлена: удаление задач и связанных записей
// выполняет слой @aif/data, а HTTP-слой не должен знать деталей каскада.
export function deleteProject(id: string): void {
  deleteProjectRecord(id);
}

// Организация проекта (GitHub/GitLab и прочие интеграции) меняется отдельной
// операцией: источник этих данных - внешние сервисы, а не форма проекта.
export function updateProjectOrganization(
  id: string,
  input: UpdateProjectOrganizationInput,
): ProjectRow | undefined {
  return updateProjectOrganizationRecord(id, input);
}

// MCP-серверы читаются из .mcp.json рабочего каталога проекта. Любая ошибка
// чтения или разбора не должна ломать выдачу настроек: наружу уходит пустой
// объект, а не исключение - файл принадлежит пользователю и может быть любым.
export function getProjectMcpServers(projectId: string): Record<string, unknown> {
  const project = findProjectById(projectId);
  if (!project) return {};

  const mcpPath = resolve(project.rootPath, ".mcp.json");
  if (!existsSync(mcpPath)) return {};

  try {
    const raw = readFileSync(mcpPath, "utf-8");
    const parsed = JSON.parse(raw);
    // Секция mcpServers необязательна: в файле могут быть только другие ключи.
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

// Реэкспорт чтения: маршруты получают проекты тем же импортом, что и функции
// записи, а дополнительные обертки для чтения не нужны - они ничего не
// добавляют к контракту @aif/data.
export { listProjects, listProjectTaskOverviews, findProjectById };
