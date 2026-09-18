/**
 * CLI-утилита нормализации позиций задач в статусе backlog.
 *
 * Позиция - числовой ключ сортировки на канбан-доске. После множества ручных
 * перетаскиваний значения становятся дробными и теряют запас между соседями, из-за
 * чего новой вставке может не хватить места. Нормализация переразмещает задачи с
 * шагом 100, восстанавливая запас.
 *
 * Работа разделена на две фазы: чистый расчёт плана (в базу ничего не пишется) и
 * применение плана в одной транзакции. По умолчанию включён режим просмотра, потому
 * что перезапись позиций уничтожает ручной порядок, выставленный людьми.
 */
import { pathToFileURL } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { logger as createLogger, tasks } from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = createLogger("normalize-backlog-positions");
// Шаг между соседними позициями. Достаточно большой, чтобы между двумя задачами
// поместилось много вставок, и при этом безопасный для целочисленной сортировки.
const NORMALIZED_POSITION_STEP = 100;

// Выбираем только поля, нужные для расчёта плана: узкий срез защищает от
// случайного использования в логике колонок, которые утилита не должна трогать.
type BacklogTaskSnapshot = Pick<
  typeof tasks.$inferSelect,
  "id" | "projectId" | "title" | "position" | "createdAt"
>;

// Описание изменения одной задачи. Поле changed позволяет отделить задачи,
// которые уже стоят на нормализованной позиции, от тех, что действительно
// требуют перезаписи: в режиме просмотра видно эффект до применения.
export interface BacklogPositionChange {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  currentPosition: number;
  normalizedPosition: number;
  changed: boolean;
}

// План по одному проекту: список задач с новыми позициями и агрегаты для
// быстрой оценки объёма правок без обхода вложенных массивов.
export interface ProjectBacklogNormalizationPlan {
  projectId: string;
  taskCount: number;
  changedTaskCount: number;
  tasks: BacklogPositionChange[];
}

// Сводный план по всем затронутым проектам. projectId равен null, когда
// ограничение по проекту не задавалось и обрабатывается весь backlog.
export interface BacklogNormalizationPlan {
  projectId: string | null;
  projectCount: number;
  taskCount: number;
  changedTaskCount: number;
  projects: ProjectBacklogNormalizationPlan[];
}

// Опции вызова. apply выключен по умолчанию: случайный запуск без флага должен
// показывать план, а не переписывать данные.
export interface NormalizeBacklogPositionsOptions {
  projectId?: string;
  apply?: boolean;
}

// Результат применения: updatedTaskCount может быть меньше changedTaskCount,
// если часть задач изменили статус или проект между расчётом плана и записью.
export interface BacklogNormalizationResult extends BacklogNormalizationPlan {
  applied: boolean;
  updatedTaskCount: number;
}

// Разобранные аргументы командной строки. help обрабатывается отдельно от
// остальных опций: при его наличии никакие обращения к БД не выполняются.
export interface NormalizeBacklogCliOptions extends NormalizeBacklogPositionsOptions {
  help: boolean;
}

// Единая точка построения условия отбора: и список задач, и последующая запись
// должны использовать одну и ту же семантику "backlog" + опциональный проект,
// иначе план и его применение разойдутся.
function backlogWhereClause(projectId?: string) {
  if (projectId) {
    return and(eq(tasks.status, "backlog"), eq(tasks.projectId, projectId));
  }
  return eq(tasks.status, "backlog");
}

// Чтение задач backlog в детерминированном порядке. Сортировка идёт от проекта
// к времени создания и затем к id: id служит разрешением ничьей, когда несколько
// задач созданы в одну миллисекунду, поэтому один и тот же набор данных всегда
// даёт один и тот же план.
// Числовое приведение позиции делается здесь: в SQLite числовые колонки могут
// вернуться строкой, а арифметика и сравнения ниже ожидают number.
function listBacklogTasks(projectId?: string): BacklogTaskSnapshot[] {
  return getDb()
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      position: tasks.position,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(backlogWhereClause(projectId))
    .orderBy(asc(tasks.projectId), asc(tasks.createdAt), asc(tasks.id))
    .all()
    .map((task) => ({
      ...task,
      position: Number(task.position),
    }));
}

// Группировка задач по проектам и назначение новых позиций. Порядок внутри
// группы сохраняется таким, каким его вернула выборка, поэтому нумерация
// (index + 1) * STEP воспроизводима между запусками.
// Map выбран вместо объекта: projectId - произвольная строка, и Map исключает
// конфликты с полями прототипа объекта.
function buildProjectPlans(backlogTasks: BacklogTaskSnapshot[]): ProjectBacklogNormalizationPlan[] {
  const byProject = new Map<string, BacklogTaskSnapshot[]>();
  for (const task of backlogTasks) {
    const tasksForProject = byProject.get(task.projectId);
    // Мутируем уже существующий массив на месте: копирование на каждой задаче
    // сделало бы группировку квадратичной по размеру проекта.
    if (tasksForProject) {
      tasksForProject.push(task);
      continue;
    }
    byProject.set(task.projectId, [task]);
  }

  return [...byProject.entries()].map(([projectId, projectTasks]) => {
    const tasks = projectTasks.map((task, index) => {
      // Позиции начинаются с шага, а не с нуля или единицы: так между первой
      // задачей и началом списка остаётся место для вставки в начало.
      const normalizedPosition = (index + 1) * NORMALIZED_POSITION_STEP;
      return {
        id: task.id,
        projectId,
        title: task.title,
        createdAt: task.createdAt,
        currentPosition: task.position,
        normalizedPosition,
        // Сравнение строгое: даже совпадение значений по числу считается
        // отсутствием изменений, чтобы не делать лишних UPDATE.
        changed: task.position !== normalizedPosition,
      };
    });

    return {
      projectId,
      taskCount: tasks.length,
      changedTaskCount: tasks.filter((task) => task.changed).length,
      tasks,
    };
  });
}

// Чистая функция планирования: только читает данные и не совершает записей.
// Разделение плана и применения позволяет показать пользователю последствия до
// необратимого шага и повторно использовать один и тот же план.
export function planBacklogPositionNormalization(
  options: NormalizeBacklogPositionsOptions = {},
): BacklogNormalizationPlan {
  const projectId = options.projectId ?? null;
  const projects = buildProjectPlans(listBacklogTasks(options.projectId));
  const taskCount = projects.reduce((total, project) => total + project.taskCount, 0);
  const changedTaskCount = projects.reduce((total, project) => total + project.changedTaskCount, 0);

  return {
    projectId,
    projectCount: projects.length,
    taskCount,
    changedTaskCount,
    projects,
  };
}

// Применение нормализации. План всегда пересчитывается заново перед записью,
// поэтому между просмотром и применением данные могли измениться - итоговые
// счётчики берутся из факта обновления, а не из исходного плана.
export function normalizeBacklogPositions(
  options: NormalizeBacklogPositionsOptions = {},
): BacklogNormalizationResult {
  const plan = planBacklogPositionNormalization(options);
  const changedTasks = plan.projects.flatMap((project) => project.tasks.filter((task) => task.changed));

  // Ранний выход без записи: либо режим просмотра, либо все позиции уже
  // нормализованы. В обоих случаях applied = false честно отражает, что БД
  // не менялась.
  if (!options.apply || changedTasks.length === 0) {
    return {
      ...plan,
      applied: false,
      updatedTaskCount: 0,
    };
  }

  // Предупреждение на уровне warn, а не info: операция необратимо меняет
  // пользовательский порядок карточек и должна быть заметна в логах.
  log.warn(
    {
      projectId: plan.projectId,
      changedTaskCount: changedTasks.length,
    },
    "Applying backlog normalization will overwrite any manual backlog order",
  );

  // Все обновления идут в одной транзакции: набор позиций имеет смысл только
  // целиком, и частично применённая нормализация оставила бы доску в состоянии,
  // где часть задач пронумерована по-новому, а часть - по-старому.
  const updatedTaskCount = getDb().transaction((tx) => {
    let updatedTaskCount = 0;

    for (const task of changedTasks) {
      // Обновление по составному условию (id + projectId + status) - это
      // оптимистичная проверка: если задача успела покинуть backlog или сменить
      // проект, условие не совпадёт, changes будет 0, и чужая параллельная
      // правка не будет затёрта. Именно поэтому счётчик суммируется по факту,
      // а не по длине списка задач.
      const result = tx
        .update(tasks)
        .set({ position: task.normalizedPosition })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.projectId, task.projectId),
            eq(tasks.status, "backlog"),
          ),
        )
        .run();
      updatedTaskCount += result.changes;
    }

    return updatedTaskCount;
  });

  return {
    ...plan,
    applied: true,
    updatedTaskCount,
  };
}

export function parseNormalizeBacklogPositionsArgs(
  args: string[],
): NormalizeBacklogCliOptions {
  const options: NormalizeBacklogCliOptions = {
    // Основной режим - безопасный просмотр: запись включается только явным флагом.
    apply: false,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    // Явный --dry-run имеет приоритет, если идёт последним: позволяет не
    // переписывать команду при переключении между режимами.
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }

    if (arg === "--project") {
      const projectId = args[index + 1];
      // Значение - следующий аргумент, поэтому пустое значение считается ошибкой,
      // а не молчаливым переходом к обработке всех проектов.
      if (!projectId) {
        throw new Error("Missing value for --project");
      }
      options.projectId = projectId;
      // Пропускаем поглощённое значение, чтобы оно не разбиралось как флаг.
      index++;
      continue;
    }

    // Неизвестный аргумент - жёсткая ошибка: опечатка в флаге не должна
    // привести к неожиданной записи в базу.
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

// Справка пишется напрямую в stdout, минуя логгер: это пользовательский вывод,
// а не диагностика, и он не должен смешиваться с логами или портиться ими.
function printHelp(): void {
  process.stdout.write(`Usage: node --import tsx packages/data/src/normalizeBacklogPositions.ts [options]

Options:
  --project <id>  Limit normalization to one project
  --apply         Rewrite backlog positions in place
  --dry-run       Preview only (default)
  --help          Show this message
`);
}

// Вывод результата в лог. Пустой результат выделен отдельным сообщением, чтобы
// отсутствие задач не выглядело как успешно проделанная работа.
function logNormalizationResult(result: BacklogNormalizationResult): void {
  if (result.projectCount === 0) {
    log.info(
      {
        projectId: result.projectId,
        applied: result.applied,
      },
      "No backlog tasks matched the normalization scope",
    );
    return;
  }

  for (const project of result.projects) {
    // В лог попадают только реально изменённые задачи: при большом backlog
    // полный список раздул бы запись и затруднил чтение.
    log.info(
      {
        projectId: project.projectId,
        taskCount: project.taskCount,
        changedTaskCount: project.changedTaskCount,
        changes: project.tasks
          .filter((task) => task.changed)
          .map((task) => ({
            id: task.id,
            title: task.title,
            currentPosition: task.currentPosition,
            normalizedPosition: task.normalizedPosition,
            createdAt: task.createdAt,
          })),
      },
      result.applied ? "Project backlog positions normalized" : "Project backlog normalization preview",
    );
  }

  // Итоговая строка агрегирует план и факт: mode фиксирует, была ли это
  // только симуляция или реальная запись, а updatedTaskCount может отличаться
  // от changedTaskCount (см. оптимистичные проверки выше).
  log.info(
    {
      projectId: result.projectId,
      projectCount: result.projectCount,
      taskCount: result.taskCount,
      changedTaskCount: result.changedTaskCount,
      updatedTaskCount: result.updatedTaskCount,
      mode: result.applied ? "apply" : "dry-run",
    },
    result.applied ? "Backlog normalization complete" : "Backlog normalization preview ready",
  );
}

// Обёртка для CLI: возвращает код выхода вместо прямого process.exit, чтобы
// функцию можно было вызывать из тестов и не убивать процесс приложения.
export async function runNormalizeBacklogPositionsCli(args: string[]): Promise<number> {
  try {
    const options = parseNormalizeBacklogPositionsArgs(args);
    // При запросе справки к базе данных не обращаемся вообще.
    if (options.help) {
      printHelp();
      return 0;
    }

    const result = normalizeBacklogPositions(options);
    logNormalizationResult(result);
    return 0;
  } catch (error) {
    // Любая ошибка (разбор аргументов, БД, транзакция) превращается в код 1:
    // CLI не должен падать стектрейсом в консоль пользователя.
    log.error({ err: error }, "Backlog normalization failed");
    return 1;
  }
}

const entryScript = process.argv[1];

// Автозапуск только при прямом вызове файла. Сравнение import.meta.url с URL
// из argv отсекает случай, когда модуль импортировали из теста или из другого
// кода: иначе импорт запускал бы CLI как побочный эффект.
// pathToFileURL нужен для корректного приведения пути к file://-ссылке
// (особенно на Windows, где различаются разделители и регистр диска).
if (entryScript && import.meta.url === pathToFileURL(entryScript).href) {
  const exitCode = await runNormalizeBacklogPositionsCli(process.argv.slice(2));
  // process.exitCode вместо process.exit: процесс завершится сам, когда
  // освободятся все ресурсы, что даёт буферам логов шанс дописаться.
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
