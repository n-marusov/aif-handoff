export interface PlanTaskChangeScope {
  /** Declared target files (as written in the plan, backticked). */
  files: string[];
  /** Whether the plan declared a parsable change scope for this task. */
  declared: boolean;
  /** Artifact kinds seen in the `Change scope:` block (e.g. "code", "tests"). */
  artifactTypes: string[];
}

export interface PlanTaskNode {
  number: number;
  description: string;
  phase: number;
  explicitDependencies: number[];
  completed: boolean;
  changeScope: PlanTaskChangeScope;
}

const EMPTY_CHANGE_SCOPE: PlanTaskChangeScope = { files: [], declared: false, artifactTypes: [] };

const FILE_BULLET = /^\s*-\s*(?:Modify|Create|Test|Delete)\s*:\s*(.+)$/i;
const SCOPE_ARTIFACT_BULLET = /^\s*-\s*(?:New|Modified)\s+artifacts?\b([^:]*):/i;
const ARTIFACT_TYPE = /\(([^)]+)\)/;

function looksLikePath(value: string): boolean {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\")) return true;
  return /\.(ts|tsx|js|jsx|json|md|yml|yaml|css|sql)$/i.test(value);
}

/** Extract candidate file paths from a `Files:` bullet line. */
function extractDeclaredPaths(line: string): string[] {
  const backticked = Array.from(line.matchAll(/`([^`]+)`/g))
    .map((match) => match[1].trim())
    .filter(looksLikePath);
  if (backticked.length > 0) return backticked;
  const firstToken = line.trim().split(/\s+/)[0] ?? "";
  return looksLikePath(firstToken) ? [firstToken] : [];
}

/**
 * Parse the change scope declared inside a task block: the `Files:` bullet
 * list (authoritative target files) plus the `Change scope:` artifact kinds.
 */
export function parseTaskChangeScope(blockLines: string[]): PlanTaskChangeScope {
  const files = new Set<string>();
  const artifactTypes = new Set<string>();

  for (const line of blockLines) {
    const fileMatch = FILE_BULLET.exec(line);
    if (fileMatch) {
      for (const file of extractDeclaredPaths(fileMatch[1])) files.add(file);
      continue;
    }
    const artifactMatch = SCOPE_ARTIFACT_BULLET.exec(line);
    if (artifactMatch) {
      const typeMatch = ARTIFACT_TYPE.exec(artifactMatch[1] ?? "");
      const label = typeMatch?.[1]?.trim().toLowerCase();
      if (label) artifactTypes.add(label);
    }
  }

  return {
    files: Array.from(files).sort(),
    declared: files.size > 0,
    artifactTypes: Array.from(artifactTypes).sort(),
  };
}

function normalizeFileKey(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "").trim().toLowerCase();
}

export interface PlanLayerComputation {
  tasks: PlanTaskNode[];
  layers: number[][];
}

function extractDependencyNumbers(raw: string): number[] {
  const nums = raw.match(/\d+/g) ?? [];
  const unique = Array.from(new Set(nums.map((value) => Number(value)).filter(Number.isFinite)));
  return unique.sort((a, b) => a - b);
}

function parseInlineTask(
  line: string,
): { number: number; description: string; inlineDeps: number[]; completed: boolean } | null {
  const normalizedLine = line.replace(/^\s*#{1,6}\s*/, "").trim();

  const boldCheckboxTaskMatch = normalizedLine.match(
    /^(?:[-*]\s*)?\[([ x~!])\]\s+\*\*Task\s+(\d+)\s*:\s*(.+?)\*\*\s*(?:\(([^)]*)\))?\s*$/i,
  );
  if (boldCheckboxTaskMatch) {
    const [, statusRaw, numberRaw, descRaw, depsRaw = ""] = boldCheckboxTaskMatch;
    return {
      number: Number(numberRaw),
      description: descRaw.trim(),
      inlineDeps: extractDependencyNumbers(depsRaw),
      completed: statusRaw.toLowerCase() === "x",
    };
  }

  const plainCheckboxTaskMatch = normalizedLine.match(
    /^(?:[-*]\s*)?\[([ x~!])\]\s+Task\s+(\d+)\s*:\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/i,
  );
  if (plainCheckboxTaskMatch) {
    const [, statusRaw, numberRaw, descRaw, depsRaw = ""] = plainCheckboxTaskMatch;
    return {
      number: Number(numberRaw),
      description: descRaw.trim(),
      inlineDeps: extractDependencyNumbers(depsRaw),
      completed: statusRaw.toLowerCase() === "x",
    };
  }

  return null;
}

export function parsePlanTasks(planText: string): PlanTaskNode[] {
  const lines = planText.split("\n");
  const tasksByNumber = new Map<number, PlanTaskNode>();
  const blockLinesByTask = new Map<number, string[]>();
  const phaseOrder: number[] = [];
  let currentPhase = 0;
  let currentTaskNumber: number | null = null;

  for (const line of lines) {
    if (/^\s*###\s+Phase\b/i.test(line) || /^\s*##\s+Phase\b/i.test(line)) {
      currentPhase += 1;
      continue;
    }

    const taskMatch = parseInlineTask(line);
    if (taskMatch) {
      const phase = currentPhase;
      const existing = tasksByNumber.get(taskMatch.number);
      const explicitDependencies = new Set(taskMatch.inlineDeps);

      if (existing) {
        for (const dep of existing.explicitDependencies) explicitDependencies.add(dep);
      }

      tasksByNumber.set(taskMatch.number, {
        number: taskMatch.number,
        description: taskMatch.description,
        phase,
        explicitDependencies: Array.from(explicitDependencies).sort((a, b) => a - b),
        completed: taskMatch.completed,
        changeScope: EMPTY_CHANGE_SCOPE,
      });
      if (!blockLinesByTask.has(taskMatch.number)) blockLinesByTask.set(taskMatch.number, []);
      currentTaskNumber = taskMatch.number;
      phaseOrder.push(phase);
      continue;
    }

    if (currentTaskNumber == null) continue;

    blockLinesByTask.get(currentTaskNumber)?.push(line);

    const normalizedLine = line.replace(/\*/g, "");
    const depLine = normalizedLine.match(/depends on\s*:?\s*(.+)$/i);
    if (!depLine) continue;

    const deps = extractDependencyNumbers(depLine[1]);
    if (deps.length === 0) continue;
    const node = tasksByNumber.get(currentTaskNumber);
    if (!node) continue;
    const merged = Array.from(new Set([...node.explicitDependencies, ...deps])).sort(
      (a, b) => a - b,
    );
    tasksByNumber.set(currentTaskNumber, { ...node, explicitDependencies: merged });
  }

  if (tasksByNumber.size === 0) return [];

  const tasks = Array.from(tasksByNumber.values()).sort((a, b) => a.number - b.number);
  const knownNumbers = new Set(tasks.map((task) => task.number));

  // If plan has no explicit "Phase" headings, keep implicit phase 0 for all tasks.
  const hasPhases = phaseOrder.some((phase) => phase > 0);
  const phaseByTask = new Map<number, number>();
  for (const task of tasks) {
    phaseByTask.set(task.number, hasPhases ? task.phase : 0);
  }

  const normalized: PlanTaskNode[] = tasks.map((task) => {
    const explicitDependencies = task.explicitDependencies.filter(
      (dep) => dep !== task.number && knownNumbers.has(dep),
    );
    return {
      ...task,
      phase: phaseByTask.get(task.number) ?? 0,
      explicitDependencies,
      completed: task.completed,
      changeScope: parseTaskChangeScope(blockLinesByTask.get(task.number) ?? []),
    };
  });

  return normalized;
}

function buildResolvedDependencies(tasks: PlanTaskNode[]): Map<number, Set<number>> {
  const byPhase = new Map<number, number[]>();
  for (const task of tasks) {
    const list = byPhase.get(task.phase) ?? [];
    list.push(task.number);
    byPhase.set(task.phase, list);
  }

  const sortedPhases = Array.from(byPhase.keys()).sort((a, b) => a - b);
  const depsByTask = new Map<number, Set<number>>();
  const priorPhasesTasks: number[] = [];

  for (const phase of sortedPhases) {
    const taskNumbers = byPhase.get(phase) ?? [];
    for (const taskNumber of taskNumbers) {
      const task = tasks.find((item) => item.number === taskNumber);
      if (!task) continue;
      if (task.explicitDependencies.length > 0) {
        depsByTask.set(task.number, new Set(task.explicitDependencies));
      } else {
        depsByTask.set(task.number, new Set(priorPhasesTasks));
      }
    }
    priorPhasesTasks.push(...taskNumbers);
  }

  return depsByTask;
}

export function computeExecutionLayers(tasks: PlanTaskNode[]): number[][] {
  if (tasks.length === 0) return [];
  const depsByTask = buildResolvedDependencies(tasks);
  const remaining = new Set(tasks.map((task) => task.number));
  const layers: number[][] = [];

  while (remaining.size > 0) {
    const ready: number[] = [];
    for (const taskNumber of remaining) {
      const deps = depsByTask.get(taskNumber) ?? new Set<number>();
      const isReady = Array.from(deps).every((dep) => !remaining.has(dep));
      if (isReady) ready.push(taskNumber);
    }

    if (ready.length === 0) {
      // Cyclic/invalid dependencies: fallback to deterministic single-task drain.
      const fallback = Array.from(remaining).sort((a, b) => a - b)[0];
      layers.push([fallback]);
      remaining.delete(fallback);
      continue;
    }

    ready.sort((a, b) => a - b);
    layers.push(ready);
    for (const taskNumber of ready) remaining.delete(taskNumber);
  }

  return layers;
}

export function computePlanLayers(planText: string): PlanLayerComputation {
  const tasks = parsePlanTasks(planText);
  const layers = computeExecutionLayers(tasks);
  return { tasks, layers };
}

export function computePendingPlanLayers(planText: string): PlanLayerComputation {
  const allTasks = parsePlanTasks(planText);
  const completedNumbers = new Set(
    allTasks.filter((task) => task.completed).map((task) => task.number),
  );
  const pendingTasks = allTasks
    .filter((task) => !task.completed)
    .map((task) => ({
      ...task,
      explicitDependencies: task.explicitDependencies.filter((dep) => !completedNumbers.has(dep)),
    }));
  const layers = computeExecutionLayers(pendingTasks);
  return { tasks: pendingTasks, layers };
}

export function formatLayerSummary(layers: number[][]): string {
  if (layers.length === 0) return "No parsed execution layers were detected.";
  return layers
    .map((layer, index) => {
      const mode = layer.length > 1 ? "parallel" : "sequential";
      return `Layer ${index + 1} (${mode}): tasks ${layer.join(", ")}`;
    })
    .join("\n");
}

export interface PlanLayerAnalysis {
  layerIndex: number;
  tasks: number[];
  decision: "parallel" | "sequential";
  /** Files declared by more than one task in the layer. */
  overlappingFiles: string[];
  /** Tasks without a parsable change scope (treated as overlapping). */
  undeclaredTasks: number[];
}

/**
 * Validate that the tasks in each layer touch disjoint file sets.
 *
 * The dependency DAG is logical, not file-based: two "independent" tasks can
 * still edit the same file and silently overwrite each other. A layer is only
 * eligible for fan-out when every task declares a parsable change scope and no
 * two tasks declare the same file. Anything else is downgraded to sequential.
 */
export function analyzeLayerDisjointness(
  layers: number[][],
  tasks: PlanTaskNode[],
): PlanLayerAnalysis[] {
  const byNumber = new Map(tasks.map((task) => [task.number, task]));

  return layers.map((layer, layerIndex) => {
    const undeclaredTasks = layer
      .filter((taskNumber) => !byNumber.get(taskNumber)?.changeScope.declared)
      .sort((a, b) => a - b);

    const ownersByFile = new Map<string, number[]>();
    for (const taskNumber of layer) {
      const scope = byNumber.get(taskNumber)?.changeScope;
      if (!scope) continue;
      for (const file of scope.files) {
        const key = normalizeFileKey(file);
        const owners = ownersByFile.get(key) ?? [];
        owners.push(taskNumber);
        ownersByFile.set(key, owners);
      }
    }

    const overlappingFiles = Array.from(ownersByFile.entries())
      .filter(([, owners]) => owners.length > 1)
      .map(([file]) => file)
      .sort();

    const decision: PlanLayerAnalysis["decision"] =
      layer.length > 1 && undeclaredTasks.length === 0 && overlappingFiles.length === 0
        ? "parallel"
        : "sequential";

    return { layerIndex, tasks: layer, decision, overlappingFiles, undeclaredTasks };
  });
}

/** Human-readable, prompt-ready rendering of the per-layer decisions. */
export function formatLayerDecisions(analyses: PlanLayerAnalysis[]): string {
  if (analyses.length === 0) return "No parsed execution layers were detected.";
  return analyses
    .map((analysis) => {
      const label = `Layer ${analysis.layerIndex + 1} (${analysis.decision}): tasks ${analysis.tasks.join(
        ", ",
      )}`;
      const reasons: string[] = [];
      if (analysis.undeclaredTasks.length > 0) {
        reasons.push(
          `tasks without a parsable change scope: ${analysis.undeclaredTasks.join(", ")}`,
        );
      }
      if (analysis.overlappingFiles.length > 0) {
        reasons.push(`overlapping files: ${analysis.overlappingFiles.join(", ")}`);
      }
      return reasons.length > 0 ? `${label} — sequential because ${reasons.join("; ")}` : label;
    })
    .join("\n");
}

/** Union of every declared target file across the given tasks. */
export function collectDeclaredFiles(tasks: PlanTaskNode[]): string[] {
  const files = new Set<string>();
  for (const task of tasks) {
    for (const file of task.changeScope.files) files.add(file);
  }
  return Array.from(files).sort();
}

/** True when the path is outside the declared scope (case/separator-insensitive). */
export function isOutsideDeclaredScope(path: string, declaredFiles: Iterable<string>): boolean {
  const needle = normalizeFileKey(path);
  for (const declared of declaredFiles) {
    if (normalizeFileKey(declared) === needle) return false;
  }
  return true;
}
