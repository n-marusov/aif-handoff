/**
 * Политика промптов: чем исполняется workflow на конкретном рантайме.
 *
 * Узловая точка абстракции @aif/runtime: один и тот же workflow (plan,
 * implement, review...) может выполняться четырьмя способами:
 * agent-определинием (системный промпт рантайма), нативными субагентами
 * Codex, изолированной skill-сессией или slash-командой как запасным
 * механизмом. Эта функция выбирает единственный применимый вариант и
 * перекраивает под него текст промпта.
 *
 * Ключевой инвариант: приоритет убывает слева направо - agent definition
 * всегда лучше fallback'ов, потому что даёт провайдеру нативный контекст.
 * Но если рантайм его не поддерживает, молчаливая деградация хуже явной:
 * каждое решение логируется с причиной, чтобы можно было отличить «так
 * задумано» от «что-то сломалось в конфиге».
 *
 * Функция чистая по отношению к внешнему миру: читает с диска только
 * SKILL.md в режиме API-транспорта, и то через защищённый резолв пути.
 */

// Чтение с диска нужно для подстановки инструкций скиллов в API-режиме,
// где slash-команды не исполняются рантаймом и их текст разворачивают вручную.
import { existsSync, readFileSync } from "node:fs";
// relative() здесь работает «детектором побега»: если путь после resolve()
// оказывается вне проекта, относительный путь начнётся с ".." - это
// дешёвый и надёжный способ поймать path traversal без перечисления плохих форм.
import { relative, resolve } from "node:path";
import {
  RuntimeTransport,
  type RuntimeCapabilities,
  type RuntimeSubagentStrategyPort,
} from "./types.js";
import type { RuntimeWorkflowSpec } from "./workflowSpec.js";

// Оба метода опциональны (?) и вызываются через `?.method?.()`: политика
// не требует логгера и не должна падать, если у переданного логгера нет
// нужного уровня. Это контракт на минимум, а не конкретный pino.
export interface RuntimePromptPolicyLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Вход резолвера политики. projectRoot передан как строка, а не как URL:
// путь будет читаться с диска, и вызывающий отвечает за его корректность.
// transport опционален: его передают не все вызывающие, и тогда ветка
// API-разворачивания скиллов просто не срабатывает.
export interface RuntimePromptPolicyInput {
  // Идентификатор рантайма используется как строковый ключ особых веток
  // (сравнения с "codex"); опечатка в нём не сломает тип, но выключит
  // проверки готовности - поэтому значение приходит из реестра, а не от
  // пользователя напрямую.
  runtimeId: string;
  // Корень целевого проекта или null: откуда читаются .agents/skills и
  // ассеты .codex. Отсутствие корня не ошибка - просто отключает файловые
  // расширения политики.
  projectRoot?: string | null;
  // Реестр возможностей адаптера: единственный источник правды о том, что
  // рантайм умеет; догадываться по имени рантайма политика не должна.
  capabilities: RuntimeCapabilities;
  // Произвольные опции профиля (Record<string, unknown>): их конкретный
  // смысл знает только адаптер, отсюда аккуратный разбор внутри.
  runtimeOptions?: Record<string, unknown>;
  workflow: RuntimeWorkflowSpec;
  // Явный флаг включения нативных субагентов Codex. Строгое сравнение
  // === true ниже означает: всё, что не true (undefined, null, строка
  // "true"), считается выключенным - safe-by-default.
  codexNativeSubagentsEnabled?: boolean;
  logger?: RuntimePromptPolicyLogger;
  /**
   * Порт стратегии нативных субагентов (объявляет адаптер Codex через
   * `adapter.subagentStrategy`). Без порта политика работает с не-Codex умолчанием
   * (non_codex) — ядро больше не импортирует `adapters/**` (Task 11).
   */
  adapterSubagentStrategy?: RuntimeSubagentStrategyPort;
  // Транспорт (SDK/CLI/API) важен: у API-режима нет ни slash-команд, ни
  // файлов проекта в привычном виде, и политика подбирает другой способ
  // донести инструкции.
  transport?: RuntimeTransport;
}

// Результат - не только текст, но и полный набор флагов «что выбрано».
// Вызывающий обязан использовать эти флаги, а не переразбирать prompt:
// дублирование решения о выборе механизма = два источника правды.
export interface RuntimePromptPolicyResult {
  prompt: string;
  systemPromptAppend: string;
  // Имя agent-определения присутствует только в native-режиме; адаптеры
  // других рантаймов обязаны игнорировать поле, если его нет.
  agentDefinitionName?: string;
  usedFallbackSlashCommand: boolean;
  usedIsolatedSkillCommand: boolean;
  usedNativeSubagentWorkflow: boolean;
  usedApiSkillExpansion: boolean;
  nativeSubagentFallbackReason?: string;
}

// Префикс slash-команд по умолчанию. Разные рантаймы объявляют команды
// по-своему (например, без косой черты), поэтому текст промптов пишется
// под универсальный "/", а подменяется префикс уже здесь.
const DEFAULT_SKILL_PREFIX = "/";

/**
 * Паттерн вызовов skill-команд в промптах.
 * Ловит "/aif-<name>" на границах слов (начало строки или после пробела).
 * Захватывает префикс "/", чтобы заменить его на префикс конкретного runtime.
 */
// Lookbehind `(?<=^|\s)` без захвата гарантирует, что замена не тронет
// дефисы внутри слов: под pattern попадает только слэш в начале строки
// или после пробела, за которым следует "aif-". Флаг m делает "^"
// привязанным к каждой строке, а не только к первой.
const SKILL_COMMAND_PATTERN = /(?<=^|\s)\/(?=aif-)/gm;

/**
 * Заменяет в тексте префикс skill-команд с дефолтного "/" на префикс runtime.
 * Преобразует, только если целевой префикс отличается от дефолтного.
 */
export function transformSkillCommandPrefix(text: string, prefix: string): string {
  // Ранний выход по идентичности префиксов: без него каждая вставка
  // прогоняла бы регулярку по всему тексту впустую.
  if (!prefix || prefix === DEFAULT_SKILL_PREFIX) return text;
  // Заменяется только сам слэш: lookahead `(?=aif-)` не потребляет имя
  // команды, поэтому "aif-plan" остаётся на месте.
  return text.replace(SKILL_COMMAND_PATTERN, prefix);
}

// Вставляет slash-команду в начало промпта. Используется для режимов,
// где команда - единственный способ «запустить» скилл внутри сессии.
function prependSlashFallbackPrompt(prompt: string, fallbackSlashCommand: string): string {
  const trimmedCommand = fallbackSlashCommand.trim();
  if (!trimmedCommand) return prompt;

  const trimmedPrompt = prompt.trim();
  // Идемпотентность: повторное применение функции не должно удваивать
  // команду - важный защитный механизм при ретраях и пересборке промптов.
  if (trimmedPrompt.startsWith(trimmedCommand)) return prompt;
  // Абзацный разрыв \n\n: одинарный перевод строки слил бы команду с
  // первым словом задачи в одну строку, и парсер рантайма мог бы её не распознать.
  return `${trimmedCommand}\n\n${prompt}`;
}

// Распознаёт начало вида "/aif-<имя>" в trimmed-строке команды. Якоря ^
// и (?:\s|$) не дают схватить подстроку в середине фразы: только команда.
const API_SKILL_COMMAND_PATTERN = /^\/(aif-[a-z0-9-]+)(?:\s|$)/i;

// Встроенные короткие инструкции на случай, когда SKILL.md недоступен
// (чистый API-транспорт без файлов проекта). Это не копии скиллов, а
// минимум смысла: режим чтения/записи и формат результата. Держать их
// здесь - осознанный компромисс: короткий промпт лучше падения всей цепочки.
//
// Каждая строка подчёркивает read-only режим там, где это важно: модель
// без инструментов не должна *притворяться*, что что-то изменила.
// Ключи — литеральные имена команд; опечатка в ключе не ловится типом,
// поэтому имена сверяются с каталогом .agents/skills вручную.
//
// Каждый текст описывает только рамку (режим чтения/записи, ожидаемый
// формат), а не методологию скилла: методология живёт в SKILL.md, и
// дублировать её здесь - означало бы иметь два расходящихся источника.
const API_SKILL_FALLBACKS: Record<string, string> = {
  "aif-plan":
    "Create or refine an implementation-ready markdown checklist plan. Planning is read-only: do not create, modify, or delete project files and do not execute implementation steps. Return actionable unchecked items using '- [ ]'.",
  "aif-improve":
    "Improve the existing implementation plan only. Do not implement code or modify product files. Preserve the plan structure and return actionable unchecked checklist items.",
  "aif-implement":
    "Implement the requested plan in the current workspace. Make only task-scoped changes, run relevant tests, and report the files changed and validation performed.",
  "aif-review":
    "Review the current task diff for correctness, security, regressions, and missing tests. Do not modify files. Return concrete findings with severity and file references.",
  "aif-security-checklist":
    "Perform a read-only OWASP-oriented security review of the current task diff. Do not modify files. Return concrete findings with severity, evidence, and remediation.",
  "aif-verify":
    "Verify the requested implementation and its tests. Do not modify files. Report blockers, missing work, and validation results in a structured verification summary.",
  "aif-fix":
    "Analyze the reported bug and produce a fix plan only unless the command explicitly requests implementation. For plan-first mode, do not modify files and return an unchecked actionable checklist.",
};

// Читает инструкции скилла с диска проекта или отдаёт встроенный fallback.
//
// Порядок защитных слоёв важен: сначала тривиальный случай (нет projectRoot),
// затем проверка выхода за пределы проекта, и только потом диск. Любая
// незадача (нет файла, пустой, EACCES) откатывается к fallback - политика
// промптов не может уронить workflow из-за отсутствия markdown.
function readApiSkillInstructions(
  projectRoot: string | null | undefined,
  skillName: string,
): { content: string; source: "project" | "fallback" } {
  // Lookup по литеральному ключу может дать undefined - ?? подставляет
  // универсальную инструкцию для неперечисленных команд.
  const fallback =
    API_SKILL_FALLBACKS[skillName] ??
    "Follow the requested workflow as a read-only planning or review task unless the prompt explicitly grants implementation permission. Do not claim to have used tools or changed files when no workspace tool is available.";
  if (!projectRoot) return { content: fallback, source: "fallback" };

  // Ожидаемая структура: <projectRoot>/.agents/skills/<skillName>/SKILL.md -
  // то же соглашение о расположении скиллов, что и у других агентов-рантаймов.
  const skillPath = resolve(projectRoot, ".agents", "skills", skillName, "SKILL.md");
  const relativeSkillPath = relative(resolve(projectRoot), skillPath);
  // Классическая защита от path traversal: skillName мог прийти из разобранной
  // команды и содержать "../". Нормализованный относительный путь с ".."
  // наружу означает выход за границы проекта - такой файл не читаем.
  if (relativeSkillPath.startsWith("..") || relativeSkillPath.includes("..")) {
    return { content: fallback, source: "fallback" };
  }
  // Проверка существования и чтение не атомарны (TOCTOU-гонка: файл могут
  // удалить между existsSync и readFileSync). Здесь это допустимо: исключение
  // гонки перехватывает catch ниже и честно откатывает к fallback.
  try {
    if (!existsSync(skillPath)) return { content: fallback, source: "fallback" };
    const content = readFileSync(skillPath, "utf8").trim();
    // Пустой или состоящий только из пробелов файл - это тоже «нет
    // инструкций», а не «пустые инструкции»: иначе в системный промпт
    // уехала бы пустышка с source "project", маскируя проблему конфигурации.
    return content.length > 0
      ? { content, source: "project" }
      : { content: fallback, source: "fallback" };
  } catch {
    // Любой сбой чтения (права, висящий диск, битая симлинка) трактуется
    // как «инструкций нет»: политика промптов не может уронить workflow.
    return { content: fallback, source: "fallback" };
  }
}

// Собирает промпт для режима нативных субагентов Codex.
//
// Здесь команда не подставляется в текст, а наоборот - формулируется
// императивная инструкция делегировать: нативный субагент - не строка
// промпта, а отдельная сущность рантайма, и модель должна явно понять,
// что ей пора порождать потомка, а не работать самой.
function prependNativeSubagentPrompt(
  workflow: RuntimeWorkflowSpec,
  prompt: string,
  agentDefinitionName: string,
  getGuidance: (workflowKind: string) => string,
): string {
  // Имя agent-определения подставляется в текст: именно так модель Codex
  // находит кастомного агента, описанного в .codex/assets.
  const agentReference = `Spawn the custom Codex agent "${agentDefinitionName}" and delegate this workflow to it.`;
  // Хвостовая подсказка по типу workflow: планирование, имплементация и
  // ревью имеют разную постановку задачи для субагента.
  const workflowSpecificGuidance = getGuidance(workflow.workflowKind);

  // Пустая строка перед prompt - визуальный разделитель: служебная рамка
  // не должна сливаться с телом задачи при join("\n").
  return [
    "Use Codex native subagents for this workflow.",
    agentReference,
    "Wait for delegated work to complete before producing the final answer.",
    "Do not use slash or skill commands as the primary execution mechanism when native subagents are available.",
    workflowSpecificGuidance,
    "",
    prompt,
  ].join("\n");
}

// Главный резолвер политики. Логика решения построена по схеме
// «запрос х возможности»:
//
//   wants*  - что хочет workflow (его executionMode и fallbackStrategy),
//   supports* - что может рантайм (capabilities + внешняя готовность),
//   use*    - пересечение запроса и возможности с учётом приоритета.
//
// Приоритет механизмов строгий: agent definition > native subagents >
// isolated skill session > slash fallback. Флаг canUseAgentDefinition входит
// отрицанием во все use*: нативная поддержка агент-определений рантаймом
// делает любые текстовые костыли ненужными.
export function resolveRuntimePromptPolicy(
  input: RuntimePromptPolicyInput,
): RuntimePromptPolicyResult {
  // Первый и главнейший тест: есть ли у workflow имя agent-определения
  // И поддерживает ли их рантайм. Достаточно отсутствия любого из двух,
  // и вся нижняя каскадная машина приходит в движение.
  const canUseAgentDefinition = Boolean(
    input.workflow.agentDefinitionName && input.capabilities.supportsAgentDefinitions,
  );
  // wants*-флаги: декларация намерений workflow. Это «что запрошено», ещё
  // не факт что исполнимо.
  const wantsNativeSubagentWorkflow = input.workflow.executionMode === "native_subagents";
  const wantsIsolatedSkillCommand = input.workflow.executionMode === "isolated_skill_session";
  const wantsSlashFallback = input.workflow.fallbackStrategy === "slash_command";
  // Стратегия Codex резолвится отдельно от capabilities: у одного и того же
  // рантайма она может переключаться runtime-опциями и env-флагами. Логика
  // живёт в адаптере (порт subagentStrategy), ядро её не знает (Task 11).
  const strategyPort = input.adapterSubagentStrategy;
  const codexSubagentStrategy = strategyPort
    ? strategyPort.resolveStrategy(input.runtimeId, input.runtimeOptions, {
        nativeSubagentsEnabled: input.codexNativeSubagentsEnabled === true,
      })
    : { strategy: null, reason: "non_codex", nativeSubagentsEnabled: false };
  // Готовность нативных субагентов спрашивается только у Codex: другой
  // рантайм с таким именем - чужие внутренности, лезть в которые не стоит.
  const codexNativeReadiness = strategyPort
    ? input.runtimeId === "codex"
      ? strategyPort.resolveReadiness(input.projectRoot)
      : null
    : null;
  // supports*-флаг изолированных сессий читается прямо из capabilities:
  // это чисто декларативная возможность адаптера, внешних проверок не требует.
  const supportsIsolatedSkillCommand = Boolean(
    input.capabilities.supportsIsolatedSubagentWorkflows,
  );
  // Готовность нативных субагентов - конъюнкция трёх независимых условий:
  // стратегия выбрана native, адаптер это умеет, и (только для Codex)
  // проектные ассеты на месте. Любое «нет» роняет всю ветку в fallback.
  const supportsNativeSubagentWorkflow =
    codexSubagentStrategy.strategy === strategyPort?.nativeStrategy &&
    Boolean(input.capabilities.supportsNativeSubagentWorkflows) &&
    (input.runtimeId !== "codex" || codexNativeReadiness?.ready === true);
  // has*-флаги проверяют наличие «топлива»: без fallback-команды нечего
  // вставлять в промпт, без имени агента некого спавнить. trim() здесь не
  // косметика: строка из одних пробелов технически непустая, но бесполезная.
  const hasFallbackCommand = Boolean(input.workflow.promptInput.fallbackSlashCommand?.trim());
  const hasNativeAgentName = Boolean(input.workflow.agentDefinitionName?.trim());
  // Решения use* - это wants AND supports AND has, плюс взаимная
  // исключительность механизмов. Порядок вычисления важен: useNative
  // считается раньше useIsolated, потому что изолированная сессия может
  // быть запасным вариантом именно для ненавистившейся native-ветки.
  const useNativeSubagentWorkflow =
    !canUseAgentDefinition &&
    wantsNativeSubagentWorkflow &&
    supportsNativeSubagentWorkflow &&
    hasNativeAgentName;
  // Ветвистое условие с намерением: isolated-режим включается и когда его
  // запросили напрямую, и когда native-режим был запасным планом для
  // slash-fallback, но native не состоялся. Дочерняя скобка (wantsNative &&
  // !useNative && wantsSlash) читается как «native провалился, спасает fallback».
  const useIsolatedSkillCommand =
    !canUseAgentDefinition &&
    (wantsIsolatedSkillCommand ||
      (wantsNativeSubagentWorkflow && !useNativeSubagentWorkflow && wantsSlashFallback)) &&
    supportsIsolatedSkillCommand &&
    hasFallbackCommand;
  // Простейший механизм включается только если ни один из более богатых
  // не состоялся: последние два условия обеспечивают взаимоисключение.
  const useSlashFallback =
    !canUseAgentDefinition &&
    wantsSlashFallback &&
    hasFallbackCommand &&
    !useNativeSubagentWorkflow &&
    !useIsolatedSkillCommand;

  // Блок журналирования деградаций. Философия: каждый отказ от запрошенного
  // механизма обязан оставить след с причиной. Молчаливая деградация - худший
  // вид бага в этой системе: workflow «успешно» выполняется не тем способом,
  // и разобраться в этом можно только по логам.
  //
  // Порядок логов повторяет порядок принятия решений; часть условий
  // взаимоисключающи и не дублируют сообщения друг друга на одном запуске.
  //
  // Каждое событие несёт runtimeId и workflowKind: записи разных профилей
  // перемешиваются в общем потоке логов, и без этих ключей событие
  // невозможно атрибутировать.
  // Все вызовы логгера ниже записаны как `input.logger?.debug?.()`: цепочка
  // из двух optional chaining покрывает и отсутствие логгера, и отсутствие
  // у него конкретного метода. Так интерфейс может оставаться минимальным.
  if (!canUseAgentDefinition && input.workflow.agentDefinitionName) {
    // debug, а не warn: для рантаймов без agent-определений (тот же чистый
    // API) это штатный путь; тревожить warn'ом на каждую задачу нельзя -
    // тревога должна оставаться за настоящими отклонениями.
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        agentDefinitionName: input.workflow.agentDefinitionName,
        hasFallbackCommand,
      },
      "Runtime does not support agent definitions, checking workflow fallback strategy",
    );
  }
  // Нативный режим запрошен, но имени агента нет: делегировать нечего -
  // это ошибка конфигурации workflow, а не рантайма.
  if (wantsNativeSubagentWorkflow && !hasNativeAgentName) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution but no agentDefinitionName was provided",
    );
  }
  // Три разнотипные причины отключения native-режима логируются раздельно,
  // потому что у них разные адресаты: invalid_fallback - опечатка в
  // runtimeOptions, explicit_isolated - осознанный выбор оператора,
  // disabled_by_env - feature flag на уровне всего процесса.
  if (codexSubagentStrategy.reason === "invalid_fallback") {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        // Значение из конфига попадает в лог как есть: так опечатка в
        // runtimeOptions видна сразу, без перечитывания настроек.
        invalidValue: codexSubagentStrategy.configuredValue,
      },
      "Ignoring invalid Codex subagent strategy override; falling back to isolated skill-session execution",
    );
  }
  if (
    wantsNativeSubagentWorkflow &&
    codexSubagentStrategy.reason === "explicit_isolated" &&
    input.runtimeId === "codex"
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Native Codex subagents disabled via runtime option; falling back to isolated skill-session execution",
    );
  }
  if (
    wantsNativeSubagentWorkflow &&
    codexSubagentStrategy.reason === "disabled_by_env" &&
    input.runtimeId === "codex"
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        // Имя env-переменной прямо в событии: оператору не нужно искать,
        // что именно переключить, чтобы вернуть native-режим.
        featureFlag: "AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED",
      },
      "Native Codex subagents disabled by feature flag; falling back to isolated skill-session execution",
    );
  }
  // Отдельный случай: стратегия native выбрана, но проект не готов - нет
  // обязательных ассетов .codex. missingPaths в логе прямо говорит, что создать.
  if (
    wantsNativeSubagentWorkflow &&
    input.runtimeId === "codex" &&
    codexSubagentStrategy.strategy === strategyPort?.nativeStrategy &&
    codexNativeReadiness &&
    !codexNativeReadiness.ready
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        // Список недостающих путей превращает предупреждение в инструкцию:
        // не «что-то не так», а «создайте вот эти файлы».
        missingPaths: codexNativeReadiness.missingPaths,
      },
      "Native Codex subagents requested but project is missing required AI Factory-managed .codex assets; falling back to isolated skill-session execution",
    );
  }

  // Симметричный предупредительный лог для slash-режима: запрошен, но
  // команды нет — промпт уйдёт «голым», и это стоит видеть.
  if (wantsSlashFallback && !hasFallbackCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested slash fallback but no fallback slash command was provided",
    );
  }
  // Длинное условное отрицание ниже — учебный пример «не шуметь дважды»:
  // если для этой же ситуации уже предупреждали выше (неготовность ассетов,
  // невалидная стратегия, env-флаг), повторный warn был бы ложью — причина
  // уже названа точнее, чем «рантайм не поддерживает».
  if (
    wantsNativeSubagentWorkflow &&
    !supportsNativeSubagentWorkflow &&
    !(
      input.runtimeId === "codex" &&
      codexSubagentStrategy.strategy === strategyPort?.nativeStrategy &&
      codexNativeReadiness &&
      !codexNativeReadiness.ready
    ) &&
    codexSubagentStrategy.reason !== "invalid_fallback" &&
    codexSubagentStrategy.reason !== "disabled_by_env"
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution but runtime does not support it",
    );
  }
  // Худший из сценариев: native не состоялся И подстраховки нет. Вовремя
  // не перехваченный workflow просто пойдёт обычным промптом — отсюда warn.
  if (wantsNativeSubagentWorkflow && !supportsNativeSubagentWorkflow && !hasFallbackCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution without any fallback command; prompt will remain non-delegated",
    );
  }
  // Единственный лог про isolated-режим: отказ поддержки самого рантайма.
  if (wantsIsolatedSkillCommand && !supportsIsolatedSkillCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested isolated skill-command execution but runtime does not support it",
    );
  }

  // API-транспорт не понимает slash-команд: их некому интерпретировать.
  // Поэтому для transport === API включается «расщепление» — четвёртый,
  // отдельный модификатор, надстраивающийся над slash-fallback.
  const useApiSkillExpansion = input.transport === RuntimeTransport.API && useSlashFallback;

  // Готовит инструкции скиллов в system prompt при API-раскрытии skill-команд.
  // Текст скилла попадает в systemPromptAppend (системное сообщение) как
  // поведенческий контекст, а не в пользовательский промпт.
  let apiSkillInstructions = "";
  if (useApiSkillExpansion) {
    // Команда извлекается из trimmed-строки: pattern заякорен на ^, поэтому
    // мусор после первой команды игнорируется, а «/aif-plan …» внутри
    // пользовательского текста не будет распознан вовсе.
    const commandMatch = (input.workflow.promptInput.fallbackSlashCommand ?? "")
      .trim()
      .match(API_SKILL_COMMAND_PATTERN);
    // Если команда не похожа на /aif-* (обычная slash-команда или пустая
    // строка), раскрытие не происходит: текст остаётся в промпте как есть.
    // API-модель прочитает её как буквы, и это ожидаемое поведение - политика
    // не выдумывает инструкции для чужих команд.
    if (commandMatch) {
      // Захват группы в регулярке даёт голое имя скилла: без скобок match
      // вернул бы всю строку команды, а не только "aif-plan"-подобный фрагмент.
      // Индекс 1 — первая захваченная группа; toLowerCase() нормализует
      // регистр, поскольку сам pattern допускает "AIF-Plan".
      const skillName = commandMatch[1].toLowerCase();
      const skill = readApiSkillInstructions(input.projectRoot, skillName);
      const command = (input.workflow.promptInput.fallbackSlashCommand ?? "").trim();
      // debug с пометкой [FIX] и указанием источника: по этим логам можно
      // проверить, откуда реально взялись инструкции — из проекта или из
      // встроенного fallback. Причём это не шум: сообщения различаются.
      input.logger?.debug?.(
        { skillName, source: skill.source, projectRoot: input.projectRoot ?? null },
        skill.source === "project"
          ? "[FIX] Skill instructions resolved from project and placed into system prompt"
          : "[FIX] Skill file unavailable; inline fallback placed into system prompt",
      );
      // Заголовок-рамка перед телом скилла объясняет модели необычность
      // ситуации: команда запрошена, но исполняется не рантаймом.
      apiSkillInstructions = [
        "API transport workflow — skill instructions:",
        `Requested workflow command: ${command}`,
        "",
        skill.content,
      ].join("\n");
    }
  }

  // Вложенные тернарники — зеркало приоритетов из шапки функции: сверху
  // самый богатый механизм, снизу «голый» промпт как конечная точка.
  // Порядок веток должен точно соответствовать use*-зависимостям, иначе
  // два флага могут запросить противоречивую обработку.
  const prompt = useNativeSubagentWorkflow
    ? // native: обрамляем задачу инструкцией делегирования.
      prependNativeSubagentPrompt(
        input.workflow,
        input.workflow.promptInput.prompt,
        input.workflow.agentDefinitionName ?? "",
        strategyPort?.getGuidance ??
          ((_workflowKind: string) =>
            "Delegate work to the named custom agent and keep the final response in the parent thread."),
      )
    : useApiSkillExpansion
      ? input.workflow.promptInput.prompt // clean prompt; skill content is in systemPromptAppend
      : useIsolatedSkillCommand
        ? prependSlashFallbackPrompt(
            input.workflow.promptInput.prompt,
            input.workflow.promptInput.fallbackSlashCommand ?? "",
          )
        : useSlashFallback
          ? // slash/ isolated: команда - единственный переносчик смысла,
            // вставляем её в самое начало промпта.
            prependSlashFallbackPrompt(
              input.workflow.promptInput.prompt,
              input.workflow.promptInput.fallbackSlashCommand ?? "",
            )
          : input.workflow.promptInput.prompt;
  // Заметьте: isolated и ordinary slash-ветки текстово идентичны - команда
  // вставляется одинаково. Разница между ними не в промпте, а в том, в какой
  // сессии он исполняется; отдельный флаг нужен именно для этого различия.
  //
  // systemPromptAppend собирается массивом с filter(Boolean): стандартный
  // JS-приём склейки необязательных блоков без лишних пустых абзацев.
  // Spread-выражение `...(cond ? [x] : [])` условно добавляет ноль или один
  // элемент - альтернатива if внутри литерала массива.
  const systemPromptAppend = [
    input.workflow.promptInput.systemPromptAppend ?? "",
    ...(apiSkillInstructions ? [apiSkillInstructions] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
  // Имя агента возвращается только когда рантайм реально его использует;
  // undefined (не null!) означает «поля нет в вызове» - адаптеры опущают
  // undefined при сериализации, и провайдер не получает пустой параметр.
  const agentDefinitionName = canUseAgentDefinition
    ? input.workflow.agentDefinitionName
    : undefined;

  // Итоговый debug-лог - снимок всего решения: все четыре флага механизма,
  // причина откатa native-режима и длина системного дополнения. По одному
  // этому событию восстанавливается весь путь принятия решений без отладчика.
  // Длина systemPromptAppend вместо содержимого: промпты огромны, логировать
  // их целиком - раздувать вывод; наличие и размер достаточны для диагностики.
  input.logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      workflowKind: input.workflow.workflowKind,
      usedFallbackSlashCommand: useSlashFallback,
      usedIsolatedSkillCommand: useIsolatedSkillCommand,
      usedNativeSubagentWorkflow: useNativeSubagentWorkflow,
      usedApiSkillExpansion: useApiSkillExpansion,
      // Тот же каскад причин, что и в возвращаемом объекте: сначала
      // неготовность ассетов (её видел адаптер), затем любая иная причина
      // от Codex-стратегии. Сравнение !== "non_codex" отсекает не-Codex
      // рантаймы, где стратегия всегда «не про неё».
      nativeSubagentFallbackReason:
        input.runtimeId === "codex" &&
        wantsNativeSubagentWorkflow &&
        !useNativeSubagentWorkflow &&
        codexNativeReadiness &&
        !codexNativeReadiness.ready
          ? "missing_native_assets"
          : input.runtimeId === "codex" &&
              wantsNativeSubagentWorkflow &&
              !useNativeSubagentWorkflow &&
              codexSubagentStrategy.reason !== "non_codex"
            ? codexSubagentStrategy.reason
            : null,
      agentDefinitionName: agentDefinitionName ?? null,
      systemPromptAppendLength: systemPromptAppend.length,
    },
    "Resolved runtime workflow prompt policy",
  );

  // Возвращается и текст, и метаданные выбора: текст идёт в рантайм, флаги -
  // в логи, UI и решения вызывающего (например, можно ли кэшировать сессию).
  // Формула nativeSubagentFallbackReason ниже дублирует выражение из
  // debug-лога: осознанная жертва DRY ради того, чтобы лог и результат не
  // могли разойтись; при изменении каскада править нужно оба места.
  return {
    prompt,
    systemPromptAppend,
    agentDefinitionName,
    usedFallbackSlashCommand: useSlashFallback,
    usedIsolatedSkillCommand: useIsolatedSkillCommand,
    usedNativeSubagentWorkflow: useNativeSubagentWorkflow,
    usedApiSkillExpansion: useApiSkillExpansion,
    // В возвращаемом объекте «нет причины» кодируется undefined, а в логе -
    // null: лог читает человек (null однозначен), а объект уходит в JSON,
    // где undefined корректно роняет поле.
    nativeSubagentFallbackReason:
      input.runtimeId === "codex" &&
      wantsNativeSubagentWorkflow &&
      !useNativeSubagentWorkflow &&
      codexNativeReadiness &&
      !codexNativeReadiness.ready
        ? "missing_native_assets"
        : input.runtimeId === "codex" &&
            wantsNativeSubagentWorkflow &&
            !useNativeSubagentWorkflow &&
            codexSubagentStrategy.reason !== "non_codex"
          ? codexSubagentStrategy.reason
          : undefined,
  };
}
