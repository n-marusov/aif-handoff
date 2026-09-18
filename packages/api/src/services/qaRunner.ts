/**
 * Fire-and-forget запуск /aif-qa через runtime: прогоняет QA-пайплайн, читает три
 * артефакта и фиксирует терминальный qaStatus на задаче.
 *
 * Почему файл устроен именно так:
 *  - "никогда не бросает": это фоновый воркер, которого никто не ждёт через await,
 *    поэтому единственный контракт с вызывающим - структурированный RunQaQueryResult,
 *    а любой сбой превращается в qaStatus:"error" плюс broadcast;
 *  - слот "running" захватывает вызывающий (tryStartQaRun) ДО вызова воркера, а не сам
 *    воркер: только так два конкурентных старта остаются взаимоисключающими;
 *  - пути артефактов считаются заранее и запекаются в промпт текстом: CLI-транспорт
 *    сам разворачивает /aif-qa в свой slug-каталог, а API-транспорты исполняют ровно
 *    то, что написано в промпте - иначе они писали бы в разные места;
 *  - slug повторяет алгоритм skill'а побайтово (включая завершающий перевод строки
 *    в git hash-object), поэтому расхождение с SKILL.md ломает чтение артефактов.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getProjectConfig, logger } from "@aif/shared";
import { findTaskById, updateTask } from "@aif/data";
import { RuntimeExecutionError, UsageSource } from "@aif/runtime";
import { runApiRuntimeOneShot } from "./runtime.js";
import { toTaskBroadcastPayload } from "../repositories/tasks.js";
import { broadcast } from "../ws.js";

const log = logger("qa-runner");

/**
 * Результат намеренно бедный: воркер не возвращает тексты артефактов, потому что
 * источник истины для UI - поля задачи в БД, а не ответ этого вызова.
 */
export interface RunQaQueryResult {
  ok: boolean;
  error?: string;
  code?: "ai_handoff_required";
}

export interface RunQaQueryInput {
  projectId: string;
  taskId: string;
  /** Корень с учётом worktree (task.worktreePath ?? project.rootPath). */
  executionRoot: string;
}

/**
 * Детерминированный, безопасный для файловой системы, устойчивый к коллизиям
 * slug для QA-артефактов.
 *
 * ЖЁСТКИЙ КОНТРАКТ с `.claude/skills/aif-qa/SKILL.md` (шаги 84-93). Если скилл
 * сменит алгоритм slug, эту функцию и соответствующий тест в `qaRunner.test.ts`
 * НУЖНО обновлять синхронно — иначе раннер читает не тот каталог, куда скилл
 * пишет, и получает `null` артефакты.
 *
 * Алгоритм:
 *  1. safe_slug — заменить каждый символ вне [A-Za-z0-9._-] на `-`, схлопнуть
 *     повторяющиеся `-`, обрезать ведущие/замыкающие `-`, при пустоте взять
 *     "branch", обрезать до 40 символов.
 *  2. hash8 — первые 8 hex-символов `git hash-object --stdin` по ИСХОДНОМУ
 *     имени ветки (с завершающим переводом строки, как в here-string `<<<` у скилла).
 *  3. combine — `<safe_slug>-<hash8>`.
 */
export function computeQaBranchSlug(branch: string, executionRoot: string): string {
  const safeSlug =
    branch
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "branch";

  // `<<< "<branch>"` дописывает завершающий перевод строки; повторяем это, чтобы
  // хеш совпадал со скиллом точно (напр. feature/foo -> a72ccce7).
  // Хеш считается от ИСХОДНОГО имени ветки, а не от уже очищенного slug: skill
  // хеширует строку до санитайза, и любая перестановка шагов даст другой каталог.
  const hashOutput = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: executionRoot,
    input: `${branch}\n`,
    encoding: "utf-8",
  });
  // slice(0, 8), а не полный хеш: восемь hex-символов дают достаточное разнообразие
  // для каталогов и keep путь короче лимитов файловых систем.
  const hash8 = hashOutput.trim().slice(0, 8);

  return `${safeSlug}-${hash8}`;
}

/**
 * Разрешает ветку, под которой ключуются QA-артефакты. Повторяет разрешение
 * шага 0.2 скилла aif-qa: приоритет у сохранённой ветки задачи, иначе — ветка,
 * на которой сейчас checkout в `executionRoot` (`git branch
 * --show-current`). Задачи быстрого режима никогда не сохраняют branchName — по
 * замыслу (planner.ts) они идут на текущей ветке проекта — поэтому без этого
 * резерва QA для них был бы молчаливым no-op. Возвращает "" при detached HEAD /
 * не-git корнях; `computeQaBranchSlug` нормализует это в slug "branch", как скилл.
 */
export function resolveQaBranch(persistedBranch: string | null, executionRoot: string): string {
  // Persisted-ветка приоритетнее текущей: работа может идти в worktree задачи,
  // где HEAD другой, и QA обязан попасть в каталог именно своей ветки.
  if (persistedBranch) return persistedBranch;
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: executionRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/** Строит явный промпт конвейера aif-qa с запечёнными абсолютными путями артефактов. */
export function buildQaPrompt(artifactDir: string): string {
  return [
    "You are running the aif-qa workflow in --all mode. Run the full QA pipeline for the",
    "current working branch and write THREE markdown artifacts to these EXACT absolute paths:",
    "",
    `  1. ${join(artifactDir, "change-summary.md")}`,
    `  2. ${join(artifactDir, "test-plan.md")}`,
    `  3. ${join(artifactDir, "test-cases.md")}`,
    "",
    "Pipeline stages (run all three in order, feeding each into the next):",
    "1. change-summary — analyze what changed on this branch vs the base, assess risk areas,",
    "   and produce a concise change summary. Write it to the change-summary.md path above.",
    "2. test-plan — derive a structured test plan from the change summary. Write it to the",
    "   test-plan.md path above.",
    "3. test-cases — expand the test plan into concrete, runnable test cases. Write it to the",
    "   test-cases.md path above.",
    "",
    "Hard rules:",
    "- Create the artifact directory if it does not exist before writing.",
    "- Write to the EXACT absolute paths listed above — do not invent your own directory.",
    "- Work strictly inside the current project root. Do not modify source code or run tests;",
    "  this is an analysis/planning pass that only writes the three markdown artifacts.",
  ].join("\n");
}

/**
 * Чтение артефакта не бросает исключение: отсутствие файла - ожидаемый результат
 * (runtime мог отработать без записи), и вызывающий сам решает, как это трактовать.
 */
function readArtifact(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Единый аварийный выход runQaQuery: сохранить qaStatus:"error", разослать
 * обновление и вернуть структурированный результат { ok:false }. Общий для
 * ветки отсутствующих артефактов и catch-all, чтобы не дублировать обработку
 * ошибок — и чтобы runQaQuery возвращал ok:false напрямую, а не бросал в
 * собственный catch. Запись защищена: сбой БД здесь не должен затмить исходную ошибку.
 */
function persistQaError(taskId: string, error: string): RunQaQueryResult {
  try {
    updateTask(taskId, { qaStatus: "error" });
    const errorTask = findTaskById(taskId);
    if (errorTask) {
      broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(errorTask) });
    }
  } catch (persistErr) {
    log.error({ persistErr, taskId }, "[QA] Failed to persist error status");
  }
  return { ok: false, error };
}

/**
 * Fire-and-forget воркер: выполняет конвейер aif-qa через общий runtime и
 * сохраняет три артефакта + терминальный qaStatus на задаче. Зеркалирует
 * `runCommitQuery` (services/commitGeneration.ts) — возвращает структурированный
 * результат и НИКОГДА не бросает. По завершении рассылает `task:updated`, чтобы
 * UI забрал qaStatus/артефакты без гонки с событиями qa_*.
 *
 * ПРЕДУСЛОВИЕ: вызывающий уже захватил прогон, переведя qaStatus в "running"
 * (routes/tasks `startQaRun` → `tryStartQaRun`). Этот воркер сам НЕ выставляет
 * "running" — только завершает в "done" / "error", чтобы атомарный захват
 * оставался единственной точкой сериализации конкурентных прогонов.
 */
export async function runQaQuery(input: RunQaQueryInput): Promise<RunQaQueryResult> {
  // Переменные сразу разворачиваются: воркер работает в фоне, и обращаться к
  // объекту input после await было бы рискованно при переиспользовании аргумента.
  const { projectId, taskId, executionRoot } = input;

  const task = findTaskById(taskId);
  // Задача могла быть удалена между постановкой в очередь и запуском воркера.
  if (!task) {
    const msg = `Task not found: ${taskId}`;
    log.error({ taskId, projectId }, msg);
    return { ok: false, error: msg };
  }
  // QA тратит токены и меняет состояние задачи, поэтому для human-owned задачи
  // воркер отвечает структурным кодом, а не просто отказом без причины.
  if (task.executionOwner === "human") {
    log.warn(
      { taskId, projectId, executionOwner: task.executionOwner },
      "[QA] Runtime rejected for human-owned task",
    );
    return {
      ok: false,
      code: "ai_handoff_required",
      error: "The task must be handed to AI before QA can run",
    };
  }

  // Разрешение ветки/конфига/slug живёт ВНУТРИ try вместе с вызовом runtime,
  // чтобы runQaQuery соблюдал контракт "NEVER throws". computeQaBranchSlug
  // запускает `git hash-object` в executionRoot; устаревший/отсутствующий корень
  // (например, удалённый worktree) заставляет execFileSync бросить синхронно.
  // Без этой защиты бросок вылетел бы из fire-and-forget рассылки маршрута без
  // события task:qa_failed и без сохранённого qaStatus:"error".
  try {
    // Разрешаем QA-ветку так же, как скилл aif-qa (шаг 0.2): сохранённая ветка
    // задачи, иначе — текущая git-ветка как резерв. Это держит slug раннера
    // синхронно со скиллом, чтобы CLI/API транспорты сходились в каталоге
    // артефактов даже для безветочных (быстрых) задач.
    const resolvedBranch = resolveQaBranch(task.branchName, executionRoot);

    // Пути артефактов вычисляются детерминированно ДО запуска runtime, чтобы
    // точные пути можно было запечь в промпт (CLI разрешает /aif-qa --all в свой
    // slug-каталог, а Codex-API/OpenRouter исполняют ровно расписанный промпт).
    // Корень проекта вычисляется из executionRoot, а не из полей проекта напрямую:
    // для worktree-задач конфиг и каталог QA должны лежать в дереве задачи.
    const cfg = getProjectConfig(executionRoot);
    const qaRoot = join(executionRoot, cfg.paths.qa);
    // Slug является ключом каталога, поэтому он вычисляется до промпта: те же самые
    // строки попадают и в текст промпта, и в последующее чтение артефактов.
    const branchSlug = computeQaBranchSlug(resolvedBranch, executionRoot);
    const artifactDir = join(qaRoot, branchSlug);

    log.info(
      { taskId, branch: resolvedBranch, branchSource: task.branchName ? "task" : "git" },
      "[QA] Starting QA run",
    );
    log.debug(
      { taskId, executionRoot, qaRoot, branchSlug, artifactDir },
      "[QA] Resolved artifact dir",
    );

    // qaStatus уже "running": вызывающий (routes/tasks startQaRun) атомарно
    // захватывает слот через tryStartQaRun ДО запуска этого воркера, поэтому
    // конкурентные старты взаимоисключающи. Воркер лишь завершает прогон в
    // "done" / "error".
    const prompt = buildQaPrompt(artifactDir);

    // Повторное чтение задачи перед прогоном: между стартом воркера и этим шагом
    // мог пройти handoff, поэтому проверка владельца повторяется у самой границы
    // выполнения, где отменить уже ничего нельзя.
    const executionBoundaryTask = findTaskById(taskId);
    if (!executionBoundaryTask || executionBoundaryTask.executionOwner === "human") {
      return {
        ok: false,
        code: "ai_handoff_required",
        error: "The task must be handed to AI before QA can run",
      };
    }
    // workflowKind и fallbackSlashCommand задают две разные стратегии исполнения:
    // первый путь - нативный workflow рантайма, второй - слэш-команда для транспортов,
    // которые умеют только её.
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: executionRoot,
      taskId,
      prompt,
      workflowKind: "qa",
      fallbackSlashCommand: "/aif-qa --all",
      usageContext: { source: UsageSource.QA },
    });

    log.info(
      { taskId, artifactDir, outputPreview: result.outputText?.slice(0, 200) ?? "" },
      "[QA] Reading artifacts from artifact dir",
    );

    // Три артефакта читаются всегда, даже если первый уже null: иначе сообщение об
    // ошибке не показало бы полный список пропавших файлов.
    const qaChangeSummary = readArtifact(join(artifactDir, "change-summary.md"));
    const qaTestPlan = readArtifact(join(artifactDir, "test-plan.md"));
    const qaTestCases = readArtifact(join(artifactDir, "test-cases.md"));

    // Успешный QA-прогон = созданы ВСЕ ТРИ артефакта. Если runtime завершился,
    // но один или несколько файлов отсутствуют (null), прогон считается упавшим,
    // а не сохраняется вводящий в заблуждение qaStatus:"done" с пробелами. Это
    // сбой валидации (не исключение runtime), поэтому возвращаем ok:false
    // напрямую с полезным сообщением — без броска в собственный catch.
    // Фильтр идёт по null, а не по пустой строке: пустой файл - это осознанно
    // записанный артефакт, а null значит, что рантайм его вовсе не создал.
    const missingArtifacts = (
      [
        ["change-summary.md", qaChangeSummary],
        ["test-plan.md", qaTestPlan],
        ["test-cases.md", qaTestCases],
      ] as const
    )
      .filter(([, content]) => content === null)
      .map(([name]) => name);
    // persistQaError вместо локального возврата: терминальное состояние и broadcast
    // должны проходить через одну точку, иначе UI останется на qaStatus:"running".
    if (missingArtifacts.length > 0) {
      const msg = `QA run did not produce required artifact(s): ${missingArtifacts.join(", ")}`;
      log.error({ taskId, artifactDir, missingArtifacts }, `[QA] ${msg}`);
      return persistQaError(taskId, msg);
    }

    // Статус и артефакты пишутся одним вызовом: раздельные записи дали бы окно, в
    // котором задача уже "done", но тексты ещё пустые.
    updateTask(taskId, {
      qaStatus: "done",
      qaChangeSummary,
      qaTestPlan,
      qaTestCases,
    });
    const doneTask = findTaskById(taskId);
    if (doneTask) {
      broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(doneTask) });
    }

    log.info({ taskId }, "[QA] QA completed");
    return { ok: true };
  } catch (err) {
    // Категория берётся из структурированного поля ошибки, а не из текста: тексты
    // локализуются и меняются, а поле остаётся стабильным для логов и метрик.
    const category = err instanceof RuntimeExecutionError ? err.category : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, taskId, projectId, category }, "[QA] QA failed");
    return persistQaError(taskId, message);
  }
}
