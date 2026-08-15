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

function readContainerProjectsMount(): string {
  const configured = process.env.PROJECTS_MOUNT?.trim();
  return configured && posix.isAbsolute(configured) ? posix.resolve(configured) : "/home/www";
}

function isWithinPath(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\");
}

function isWithinPosixPath(basePath: string, candidatePath: string): boolean {
  const rel = posix.relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel));
}

function resolveHostProjectsDir(hostProjectsDir: string): string {
  if (isAbsolute(hostProjectsDir)) return resolve(hostProjectsDir);

  const hostRoot = process.env.PROJECTS_HOST_ROOT?.trim();
  return hostRoot && isAbsolute(hostRoot)
    ? resolve(hostRoot, hostProjectsDir)
    : resolve(hostProjectsDir);
}

function mapProjectPathToContainer(rootPath: string): string {
  const hostProjectsDir = process.env.PROJECTS_DIR?.trim();
  const containerProjectsMount = readContainerProjectsMount();

  if (hostProjectsDir) {
    const resolvedRootPath = resolve(rootPath);
    const resolvedHostProjectsDir = resolveHostProjectsDir(hostProjectsDir);

    if (isWithinPath(resolvedHostProjectsDir, resolvedRootPath)) {
      const rel = relative(resolvedHostProjectsDir, resolvedRootPath);
      return rel
        ? posix.join(containerProjectsMount, rel.split(sep).join(posix.sep))
        : containerProjectsMount;
    }

    if (win32.isAbsolute(hostProjectsDir) && win32.isAbsolute(rootPath)) {
      const windowsHostProjectsDir = win32.resolve(normalizeWindowsPath(hostProjectsDir));
      const windowsRootPath = win32.resolve(normalizeWindowsPath(rootPath));
      const rel = win32.relative(windowsHostProjectsDir, windowsRootPath);
      if (rel === "" || (rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel))) {
        return rel
          ? posix.join(containerProjectsMount, rel.split("\\").join(posix.sep))
          : containerProjectsMount;
      }
    }
  }

  const configuredProjectsMount = process.env.PROJECTS_MOUNT?.trim();
  if (
    !configuredProjectsMount ||
    !posix.isAbsolute(configuredProjectsMount) ||
    !posix.isAbsolute(rootPath)
  ) {
    return rootPath;
  }

  const normalizedRootPath = posix.resolve(rootPath);
  if (isWithinPosixPath(containerProjectsMount, normalizedRootPath)) {
    return normalizedRootPath;
  }

  return posix.join(containerProjectsMount, normalizedRootPath.slice(1));
}

function normalizeProjectName(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

function findDuplicateProjectName(name: string, excludeId: string | null): ProjectRow | undefined {
  const normalized = normalizeProjectName(name);
  if (!normalized) return undefined;
  return listProjects().find(
    (project) => project.id !== excludeId && normalizeProjectName(project.name) === normalized,
  );
}

function resolveGeneratedProjectRootPath(name: string): string {
  const base = readContainerProjectsMount();
  const slug = slugify(name);
  const taken = new Set(listProjects().map((project) => project.rootPath.toLowerCase()));

  let candidate = posix.join(base, slug);
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = posix.join(base, `${slug}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

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

  const normalizedInput = { ...input, rootPath };
  const project = createProjectRecord(normalizedInput);

  try {
    const registry = await getApiRuntimeRegistry();
    const result = initProject({ projectRoot: normalizedInput.rootPath, registry });
    if (!result.ok) {
      log.error(
        { projectId: project?.id, rootPath: normalizedInput.rootPath, error: result.error },
        "Project init failed, rolling back project record",
      );
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

export function deleteProject(id: string): void {
  deleteProjectRecord(id);
}

export function updateProjectOrganization(
  id: string,
  input: UpdateProjectOrganizationInput,
): ProjectRow | undefined {
  return updateProjectOrganizationRecord(id, input);
}

export function getProjectMcpServers(projectId: string): Record<string, unknown> {
  const project = findProjectById(projectId);
  if (!project) return {};

  const mcpPath = resolve(project.rootPath, ".mcp.json");
  if (!existsSync(mcpPath)) return {};

  try {
    const raw = readFileSync(mcpPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

export { listProjects, listProjectTaskOverviews, findProjectById };
