/**
 * Разбор плана на слои исполнения.
 *
 * Модуль читает Markdown-план, вытаскивает из него задачи с их зависимостями и объявленной
 * областью изменений, а затем раскладывает задачи по волнам (слоям), которые можно выполнять
 * параллельно. Слои нужны двумя стадиями сразу: планирование показывает их человеку, а стадия
 * improve решает по ним, что можно фан-аутить в один проход.
 *
 * Почему модуль устроен именно так:
 * - Разбор текстовый и заведомо эвристический: план пишет модель, формат гуляет между
 *   запусками. Поэтому регулярки терпимы (жирный и обычный чекбокс, английские и русские
 *   пули), а неверный разбор деградирует к "область не объявлена", а не к исключению.
 * - Граф зависимостей логический, а не файловый: две "независимые" задачи могут править один
 *   файл. Поэтому поверх слоев стоит отдельная проверка пересечений по файлам, и без явных
 *   областей изменений слой принудительно становится последовательным.
 * - Независимость от порядка входа обязательна: все коллекции сортируются по номеру задачи,
 *   иначе один и тот же план давал бы разные слои и ломал бы воспроизводимость прогонов.
 * - Неявный барьер фаз: задача без собственных зависимостей зависит от всех задач предыдущих
 *   фаз. Это единственное место, где слоистость берется из заголовков плана, а не из ссылок.
 * - Завершенные задачи не удаляются из графа молча: для pending-слоев они вырезаются вместе
 *   со ссылками на них, иначе уже сделанная работа блокировала бы остаток плана.
 */

export interface PlanTaskChangeScope {
  /** Объявленные целевые файлы (как в плане, в обратных кавычках). */
  files: string[];
  /** Объявил ли план разбираемую область изменений для этой задачи. */
  declared: boolean;
  /** Виды артефактов из блока `Change scope:` (например "code", "tests"). */
  artifactTypes: string[];
}

// Узел графа плана: одна задача вместе с местом в фазах и объявленной областью изменений.
// phase заполняется на этапе разбора и позже нормализуется до 0, если фаз в плане нет.
export interface PlanTaskNode {
  number: number;
  description: string;
  phase: number;
  explicitDependencies: number[];
  completed: boolean;
  changeScope: PlanTaskChangeScope;
}

// Общий пустой скоуп на все задачи без объявленной области. Один объект на всех - это
// осознанный компромисс: значение нигде не мутируется, а аллокаций на больших планах меньше.
// Важно: declared=false здесь не "нет файлов", а "мы не смогли разобрать область".
const EMPTY_CHANGE_SCOPE: PlanTaskChangeScope = { files: [], declared: false, artifactTypes: [] };

// Признак строки-файла: глагол действия плюс двоеточие. Альтернативы в двух языках, потому что
// планы приходят и на английском, и на русском, а "file/файл" после глагола опционально.
const FILE_BULLET =
  /^\s*-\s*(?:Modify|Create|Test|Delete|Изменить|Создать|Проверить|Удалить)(?:\s+file|\s+файл)?\s*:\s*(.+)$/i;
// Второй диалект объявления области: "New/Modified artifacts (code):" вместо Files-пулей.
// Отсюда берется только тип артефакта, сами файлы не перечисляются.
const EN_SCOPE_ARTIFACT_BULLET = /^\s*-\s*(?:New|Modified)\s+artifacts?\b([^:]*):/i;
// Тип артефакта сидит в скобках заголовка, например "artifacts (tests, docs):".
const ARTIFACT_TYPE = /\(([^)]+)\)/;

// Дешевая эвристика "это похоже на путь": либо разделитель каталогов, либо знакомое
// расширение. Строгая проверка существования файла здесь недопустима - план может объявлять
// новые файлы.
function looksLikePath(value: string): boolean {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\")) return true;
  return /\.(ts|tsx|js|jsx|json|md|yml|yaml|css|sql)$/i.test(value);
}

/** Извлекает пути-кандидаты файлов из строки-пули `Files:`. */
function extractDeclaredPaths(line: string): string[] {
  // Обратные кавычки - основной формат, поэтому они приоритетнее: свободный текст вокруг
  // может содержать слова, похожие на пути, и утащить их в область изменений.
  const backticked = Array.from(line.matchAll(/`([^`]+)`/g))
    .map((match) => match[1].trim())
    .filter(looksLikePath);
  if (backticked.length > 0) return backticked;
  // Запасной вариант для строк без разметки: берем первый токен, но только если он выглядит
  // как путь. Иначе пустой массив - лучше пропустить файл, чем записать в скоуп мусор.
  const firstToken = line.trim().split(/\s+/)[0] ?? "";
  return looksLikePath(firstToken) ? [firstToken] : [];
}

/**
 * Разбирает область изменений внутри блока задачи: список пуль `Files:`
 * (авторитетные целевые файлы) плюс виды артефактов из `Change scope:`.
 */
export function parseTaskChangeScope(blockLines: string[]): PlanTaskChangeScope {
  // Множества, а не массивы: одна и та же пуля может встретиться дважды (дубль задачи или
  // копипаста в плане), а повторный файл в области изменений завышает ложные пересечения.
  const files = new Set<string>();
  const artifactTypes = new Set<string>();

  for (const line of blockLines) {
    const fileMatch = FILE_BULLET.exec(line);
    if (fileMatch) {
      for (const file of extractDeclaredPaths(fileMatch[1])) files.add(file);
      continue;
    }
    // Ветка артефактов проверяется только если строка не оказалась файловой: порядок экономит
    // лишний прогон регулярки для самого частого типа строк.
    const artifactMatch = EN_SCOPE_ARTIFACT_BULLET.exec(line);
    if (artifactMatch) {
      const typeMatch = ARTIFACT_TYPE.exec(artifactMatch[1] ?? "");
      const label = typeMatch?.[1]?.trim().toLowerCase();
      if (label) artifactTypes.add(label);
    }
  }

  return {
    files: Array.from(files).sort(),
    declared: files.size > 0,
    // Сортировка типов артефактов - ради стабильности промптов: при одинаковом плане текст
    // валидации не должен меняться от запуска к запуску.
    artifactTypes: Array.from(artifactTypes).sort(),
  };
}

function normalizeFileKey(file: string): string {
  // Ключ сравнения путей: разделители приводятся к прямому слешу, убирается ведущее "./",
  // а регистр сбрасывается. Планы пишутся руками, поэтому "Src/A.ts" и "src\\a.ts" -
  // это один и тот же файл, и без нормализации пересечение не было бы замечено.
  return file.replaceAll("\\", "/").replace(/^\.\//, "").trim().toLowerCase();
}

// Результат разбора одним куском: задачи и уже посчитанные для них слои. Держать их вместе
// важно, потому что слои нумеруются номерами задач, а отдавать их врозь - приглашение
// к рассинхрону.
export interface PlanLayerComputation {
  tasks: PlanTaskNode[];
  layers: number[][];
}

// Номера зависимостей приводятся к уникальному отсортированному виду: "depends on 3, 3 and 1"
// и "depends on 1, 3" должны дать одинаковый набор, иначе граф станет нестабильным.
function extractDependencyNumbers(raw: string): number[] {
  const nums = raw.match(/\d+/g) ?? [];
  const unique = Array.from(new Set(nums.map((value) => Number(value)).filter(Number.isFinite)));
  return unique.sort((a, b) => a - b);
}

// Разбор одной строки-заголовка задачи. Два диалекта: жирный "**Task 3: ...**" и обычный
// "Task 3: ..."; в обоих чекбокс опционален, а хвост в скобках считается зависимостями.
// Возврат null означает "строка не похожа на задачу", а не ошибку - это норма для плана.
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
  // Счетчики и аккумуляторы живут в одном проходе по строкам: план читается один раз, потому
  // что он может быть длинным, а разбор строки зависит от того, в какой задаче мы находимся.
  const lines = planText.split("\n");
  const tasksByNumber = new Map<number, PlanTaskNode>();
  const blockLinesByTask = new Map<number, string[]>();
  const phaseOrder: number[] = [];
  let currentPhase = 0;
  let currentTaskNumber: number | null = null;

  for (const line of lines) {
    // Фаза увеличивается на любом заголовке Phase, и ### и ##. Нумерация сквозная от
    // единицы, поэтому фаза 0 означает "задач до первого заголовка" и позже трактуется
    // как отсутствие фаз.
    if (/^\s*###\s+Phase\b/i.test(line) || /^\s*##\s+Phase\b/i.test(line)) {
      currentPhase += 1;
      continue;
    }

    const taskMatch = parseInlineTask(line);
    if (taskMatch) {
      // Дубль номера задачи не перезаписывает узел, а сливается с ним: в плане бывает и
      // повторный заголовок, и ссылка на ту же задачу в другом разделе. Ссылки объединяются,
      // иначе второй проход потерял бы часть зависимостей.
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
      // Строки задачи считаются от заголовка до следующего заголовка: это сырье для разбора
      // области изменений, который выполняется позже, когда блок уже собран целиком.
      if (!blockLinesByTask.has(taskMatch.number)) blockLinesByTask.set(taskMatch.number, []);
      currentTaskNumber = taskMatch.number;
      phaseOrder.push(phase);
      continue;
    }

    if (currentTaskNumber == null) continue;

    // Все прочие строки - это тело текущей задачи. Они копятся как есть, включая пустые:
    // разбору скоупа важна структура блока, а не отдельные строки.
    blockLinesByTask.get(currentTaskNumber)?.push(line);

    // Дополнительный диалект зависимости: отдельная строка "Depends on: 1, 2". Звездочки
    // вырезаются, потому что в плане это обычно часть жирного выделения.
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

  // Сортировка по номеру задачи - не косметика: от нее зависит и порядок слоев, и порядок
  // перечисления задач внутри слоя, а значит и текст промпта для исполнителя.
  const tasks = Array.from(tasksByNumber.values()).sort((a, b) => a.number - b.number);
  const knownNumbers = new Set(tasks.map((task) => task.number));

  // Если в плане нет явных заголовков "Phase", всем задачам остаётся неявная фаза 0.
  // Отсутствие заголовков Phase - это не ошибка формата, а плоский план: все задачи живут в
  // фазе 0 и блокируют друг друга только явными ссылками, а не порядком объявления.
  const hasPhases = phaseOrder.some((phase) => phase > 0);
  const phaseByTask = new Map<number, number>();
  for (const task of tasks) {
    phaseByTask.set(task.number, hasPhases ? task.phase : 0);
  }

  const normalized: PlanTaskNode[] = tasks.map((task) => {
    // Ссылка задачи на саму себя - бессмысленный цикл, а ссылка на номер, которого нет
    // в плане, обычно опечатка. И то и другое вырезается здесь, чтобы граф вообще можно
    // было обойти.
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
  // Задачи группируются по фазам, а не по номеру: правила зависимостей заданы на уровне фазы,
  // и внутри одной фазы порядок не важен - такие задачи как раз и предназначены для параллели.
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
      // Явные зависимости перебивают правило фаз полностью: если автор плана перечислил
      // ссылки, догадки про "все задачи предыдущих фаз" не применяются.
      if (task.explicitDependencies.length > 0) {
        depsByTask.set(task.number, new Set(task.explicitDependencies));
      } else {
        // Неявный барьер фазы: задача без ссылок ждет все задачи, объявленные выше по фазам.
        depsByTask.set(task.number, new Set(priorPhasesTasks));
      }
    }
    // Накопление после обработки фазы - именно так и получается правило "только предыдущие
    // фазы": задачи текущей фазы в свой же барьер не попадают и друг друга не блокируют.
    priorPhasesTasks.push(...taskNumbers);
  }

  return depsByTask;
}

export function computeExecutionLayers(tasks: PlanTaskNode[]): number[][] {
  if (tasks.length === 0) return [];
  const depsByTask = buildResolvedDependencies(tasks);
  // remaining - это фронт работ: задача готова, когда все ее зависимости уже вынуты из
  // множества. Проверка по множеству, а не по слоям, устойчива к сквозным ссылкам через фазы.
  const remaining = new Set(tasks.map((task) => task.number));
  const layers: number[][] = [];

  while (remaining.size > 0) {
    const ready: number[] = [];
    for (const taskNumber of remaining) {
      const deps = depsByTask.get(taskNumber) ?? new Set<number>();
      // Готовность считается по всем зависимостям сразу: сеть, а не булев флаг, чтобы задача
      // с частично выполненными зависимостями не проскочила в слой раньше времени.
      const isReady = Array.from(deps).every((dep) => !remaining.has(dep));
      if (isReady) ready.push(taskNumber);
    }

    // Пустой ready означает цикл или ссылку на уже удаленную задачу. Падать нельзя: план
    // пришел от модели, и вместо исключения мы детерминированно вынимаем по одной задаче,
    // чтобы прогресс был гарантирован, а результат оставался воспроизводимым.
    if (ready.length === 0) {
      // Циклические/некорректные зависимости: откат — детерминированный дренаж по одной задаче.
      const fallback = Array.from(remaining).sort((a, b) => a - b)[0];
      layers.push([fallback]);
      remaining.delete(fallback);
      continue;
    }

    // Порядок номеров внутри слоя фиксируется сортировкой: от него зависит порядок запуска
    // исполнителей и текст промпта, а Map/Set порядок вставки тут не гарантируют стабильности.
    ready.sort((a, b) => a - b);
    layers.push(ready);
    for (const taskNumber of ready) remaining.delete(taskNumber);
  }

  return layers;
}

// Тонкая обертка с единственным смыслом: раз план и его слои нужны вместе, парсить текст
// дважды нельзя, иначе стороны могут разойтись на планах с нестабильным форматом.
export function computePlanLayers(planText: string): PlanLayerComputation {
  const tasks = parsePlanTasks(planText);
  const layers = computeExecutionLayers(tasks);
  return { tasks, layers };
}

export function computePendingPlanLayers(planText: string): PlanLayerComputation {
  // Отсечка сделанного здесь обязательна, иначе первая же закрытая задача останется в графе
  // и заблокирует все, что на нее ссылалось, хотя зависимости фактически удовлетворены.
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
  // Одиночная задача в слое - это "sequential": параллелить нечего, и пометка нужна, чтобы
  // человек не искал в плане отсутствующую возможность фан-аута.
  if (layers.length === 0) return "No parsed execution layers were detected.";
  return layers
    .map((layer, index) => {
      const mode = layer.length > 1 ? "parallel" : "sequential";
      return `Layer ${index + 1} (${mode}): tasks ${layer.join(", ")}`;
    })
    .join("\n");
}

export interface PlanLayerAnalysis {
  // Индекс слоя с нуля: он же используется для порядка вывода, а нумерация для человека
  // добавляет единицу уже при форматировании.
  layerIndex: number;
  tasks: number[];
  decision: "parallel" | "sequential";
  /** Файлы, объявленные более чем одной задачей слоя. */
  overlappingFiles: string[];
  /** Задачи без разбираемой области изменений (считаются пересекающимися). */
  undeclaredTasks: number[];
}

/**
 * Проверяет, что задачи каждого слоя затрагивают непересекающиеся наборы файлов.
 *
 * Граф зависимостей логический, а не файловый: две «независимые» задачи могут
 * править один файл и молча затирать друг друга. Слой допускается к фан-ауту,
 * только если каждая задача объявляет разбираемую область изменений и никакие
 * две не объявляют один файл. Иначе слой понижается до последовательного.
 */
export function analyzeLayerDisjointness(
  layers: number[][],
  tasks: PlanTaskNode[],
): PlanLayerAnalysis[] {
  const byNumber = new Map(tasks.map((task) => [task.number, task]));

  return layers.map((layer, layerIndex) => {
    // Задачи без разобранного скоупа считаются потенциально конфликтными: неизвестность
    // трактуется в пользу последовательного исполнения, а не в пользу параллели.
    const undeclaredTasks = layer
      .filter((taskNumber) => !byNumber.get(taskNumber)?.changeScope.declared)
      .sort((a, b) => a - b);

    // Карта "файл -> задачи слоя": владельцы собираются по нормализованному ключу, поэтому
    // разные написания одного пути встречаются в одной записи и пересечение видно.
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

    // Решение принимается только при полной ясности: больше одной задачи, все объявили скоуп
    // и файлы не пересекаются. Любое сомнение - sequential, потому что цена гонки выше цены
    // потерянного параллелизма.
    const decision: PlanLayerAnalysis["decision"] =
      layer.length > 1 && undeclaredTasks.length === 0 && overlappingFiles.length === 0
        ? "parallel"
        : "sequential";

    return { layerIndex, tasks: layer, decision, overlappingFiles, undeclaredTasks };
  });
}

/** Человекочитаемая, готовая к вставке в промпт отрисовка решений по слоям. */
export function formatLayerDecisions(analyses: PlanLayerAnalysis[]): string {
  if (analyses.length === 0) return "No parsed execution layers were detected.";
  return analyses
    .map((analysis) => {
      const label = `Layer ${analysis.layerIndex + 1} (${analysis.decision}): tasks ${analysis.tasks.join(
        ", ",
      )}`;
      const reasons: string[] = [];
      // Причины важнее самого вердикта: без них последовательность слоя выглядит как
      // потерянный параллелизм, и человек начинает искать баг там, где сработало защитное
      // правило.
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

/** Объединение всех объявленных целевых файлов среди данных задач. */
export function collectDeclaredFiles(tasks: PlanTaskNode[]): string[] {
  // Множество нужно для слияния скоупов разных задач: один и тот же файл может быть объявлен
  // дважды, а потребители ждут плоский список без повторов.
  const files = new Set<string>();
  for (const task of tasks) {
    for (const file of task.changeScope.files) files.add(file);
  }
  return Array.from(files).sort();
}

/**
 * Извлечение объявленных файлов из полного текста плана по максимуму.
 *
 * Некоторые выводы plan-checker используют простые локализованные строки
 * чек-листа вроде `- [ ] Создать файл: test.md` вместо строгой структуры
 * `Task N` для планирования слоёв. Этот помощник питает промпты
 * валидации/повтора, не меняя более строгий парсер зависимостей.
 */
export function collectDeclaredFilesFromPlanText(planText: string | null | undefined): string[] {
  // Пустой план - это штатная ситуация (плана еще нет), а не ошибка: возвращаем пустой список
  // вместо исключения, чтобы вызывающий код не разветвлялся на два случая.
  if (!planText) return [];
  const files = new Set<string>();
  for (const rawLine of planText.split("\n")) {
    // Чекбокс приводится к обычной пуле: разбору файлов важен только хвост строки, но
    // префикс "- [ ] " мешает якорю регулярки, поэтому он отрезается здесь, а не в паттерне.
    const line = rawLine.replace(/^\s*[-*]\s+\[(?: |x|X|~|!)\]\s+/, "- ");
    const fileMatch = FILE_BULLET.exec(line);
    if (!fileMatch) continue;
    for (const file of extractDeclaredPaths(fileMatch[1])) files.add(file);
  }
  return Array.from(files).sort();
}

export function hasPendingChecklistItems(planText: string | null | undefined): boolean {
  // Из класса статусов в паттерне намеренно исключен "x": закрытые пункты не должны
  // считаться ожидающей работой, иначе план никогда не выглядит завершенным.
  return Boolean(planText && /^\s*[-*]\s+\[(?: |~|!)\]\s+\S/m.test(planText));
}

/** True, если путь вне объявленной области (без учёта регистра/разделителей). */
export function isOutsideDeclaredScope(path: string, declaredFiles: Iterable<string>): boolean {
  // Сравнение идет по нормализованному ключу, а не по сырым строкам: иначе различие в слешах
  // или регистре на Windows-чекауте выдало бы ложное "вне области".
  const needle = normalizeFileKey(path);
  for (const declared of declaredFiles) {
    if (normalizeFileKey(declared) === needle) return false;
  }
  return true;
}
