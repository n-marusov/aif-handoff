/**
 * Классификатор ошибок стадии конвейера.
 *
 * Роль узла: получить произвольную ошибку подстадии и вернуть решение о судьбе задачи -
 * быстрый повтор, блокировку со сроком или откат статуса. Сам статус здесь не пишется:
 * это делает вызывающий код, поэтому функция остается предсказуемой и легко тестируемой.
 *
 * Почему так устроено:
 * - Ветвление идет ТОЛЬКО по структурным полям (category, adapterCode, httpStatus, kind),
 *   которые выставлены классификаторами в errorClassifier.ts. Текст сообщения об ошибке -
 *   это диагностика для логов, а не признак для логики: формулировки у провайдеров меняются
 *   от релиза к релизу, и разбор строк превратил бы поведение в лотерею.
 * - Порядок проверок и есть приоритет. Сначала узкие и опасные случаи (ручная блокировка,
 *   цикл, потеря изоляции ветки, ошибка конфигурации), затем внешние сбои с повтором и лишь
 *   в конце общий откат. Перестановка веток меняет смысл, поэтому новый случай ставят рядом
 *   с родственными, а не дописывают в конец списка.
 * - Все, что попадает к пользователю (blockedReason) или в activity-запись, очищено от
 *   текста провайдера. Сырой текст допустим только в логах.
 * - Ошибки рантайма приходят завернутыми, поэтому признак ищется по всей цепочке cause.
 *
 * Ловушка: попадание сбоя изоляции ветки или ошибки конфигурации в общий откат запускает
 * бесконечное перепланирование на сломанном дереве. Такие случаи обязаны завершаться
 * блокировкой, а не откатом.
 */

/**
 * Обработчик ошибок стадии — классифицирует ошибки конвейера и применяет
 * подходящую стратегию восстановления (быстрый повтор, задержка повтора или откат).
 * Выделен из coordinator.ts ради единственной ответственности.
 */

import type { RuntimeLimitSnapshot } from "@aif/runtime";
import {
  getEnv,
  listWorktrees,
  logger,
  mapSafeRuntimeErrorReason,
  redactProviderTextForLogs,
  type TaskStatus,
} from "@aif/shared";
import { logActivity } from "./hooks.js";
import { AiLoopDetectedError } from "./loopGuard.js";
import {
  findBranchIsolationError,
  findConfigurationError,
  findRuntimeExecutionError,
  isExternalFailure,
  isFastRetryableFailure,
  truncateReason,
} from "./errorClassifier.js";
import { getRandomBackoffMinutes } from "./taskWatchdog.js";

// Именованный логгер: имя попадает в каждую строку, поэтому сбои стадии отличимы от
// остального вывода координатора без разбора контекста вызова.
const log = logger("stage-error-handler");

// Источник срока хранится рядом с самим сроком: по нему видно, доверяем ли мы метаданным
// провайдера (resetAt, retryAfterSeconds) или считаем задержку вслепую.
type RetryAfterSource = "resetAt" | "retryAfterSeconds" | "random_backoff" | "none";

// Категории рантайма, при которых повтор бессмысленен: ключ неверен, модели нет, контекст
// не влезает, контент отфильтрован. Повтор вернет ту же ошибку, поэтому задача уходит в
// блокировку на ручное действие. Проверка идет по category, не по тексту сообщения.
const NON_RETRYABLE_RUNTIME_CATEGORIES = new Set([
  "auth",
  "model_not_found",
  "context_length",
  "content_filter",
]);

// Потолок на размер снимка деревьев: строка уходит в лог и в activity-запись, а проект с
// сотнями рабочих деревьев раздул бы запись до бесполезного объема.
const WORKTREE_SNAPSHOT_MAX = 2_000;

/**
 * Ограниченный человекочитаемый снимок регистраций git-рабочих деревьев
 * проекта. Прикладывается к сбоям изоляции веток, чтобы оператор видел,
 * какая папка держала ветку, без воспроизведения сбоя.
 */
function buildWorktreeSnapshot(projectRoot: string): string | null {
  try {
    const entries = listWorktrees(projectRoot);
    if (entries.length === 0) return null;
    const rendered = entries
      .map((entry) => {
        const branch = entry.branch ? ` [${entry.branch}]` : entry.detached ? " [detached]" : "";
        const prunable = entry.prunable ? " (prunable)" : "";
        return `${entry.path}${branch}${prunable}`;
      })
      .join("\n");
    return rendered.length > WORKTREE_SNAPSHOT_MAX
      ? `${rendered.slice(0, WORKTREE_SNAPSHOT_MAX)}…[truncated]`
      : rendered;
  } catch {
    // Отсутствие снимка не должно превращать диагностику в новую ошибку: сбой самого
    // чтения дерева просто лишает лог подробностей.
    return null;
  }
}

// Отдельный тип вместо кода в тексте: подстадия сигнализирует "нужен человек", и это
// единственный способ отличить намеренную блокировку от случайного сбоя. Смысл тот же,
// что у категорий рантайма, но для внутренних подстадий, а не для провайдера.
export class StageManualBlockError extends Error {
  // Причина лежит отдельным полем, а не берется из message: message может быть заменен
  // при создании, а в blockedReason попадает ровно то, что показывают оператору.
  readonly blockedReason: string;

  constructor(blockedReason: string, message = blockedReason) {
    super(message);
    this.name = "StageManualBlockError";
    this.blockedReason = blockedReason;
  }
}

// Решение, а не действие: разбор и применение статуса разведены, чтобы вызывающий код мог
// отложить запись в БД или добавить свои проверки. Поле kind служит дискриминантом для
// исчерпывающего разбора на стороне координатора.
export type ErrorRecovery =
  | { kind: "fast_retry" }
  // Блокировка несет полный набор полей для сохранения состояния: срок повтора, его
  // источник, счетчик попыток и снимок лимитов провайдера.
  | {
      kind: "blocked_external";
      blockedReason: string;
      retryAfter: string | null;
      retryAfterSource: RetryAfterSource;
      retryCount: number;
      limitSnapshot: RuntimeLimitSnapshot | null;
    }
  // Откат означает "повторить стадию заново" и потому не несет данных: сам факт отката
  // и есть решение.
  | { kind: "revert" };

// err намеренно unknown: на вход приходит что угодно, включая строки и объекты от чужих
// SDK. Приведение к Error делается только там, где нужен текст для лога.
interface StageErrorInput {
  taskId: string;
  stageLabel: string;
  sourceStatus: TaskStatus;
  retryCount: number;
  err: unknown;
}

// Обертка над ошибкой не должна скрывать ее тип: рантаймы заворачивают исходную причину в
// свой Error с cause, поэтому признак ищется по всей цепочке.
function findStageManualBlockError(err: unknown): StageManualBlockError | null {
  if (err instanceof StageManualBlockError) return err;
  // Причина может быть вложена не на один уровень, поэтому обход рекурсивный.
  if (err instanceof Error && "cause" in err && err.cause) {
    return findStageManualBlockError(err.cause);
  }
  return null;
}

// Тот же обход цепочки cause, что и выше: детектор цикла бросает ошибку из глубины
// инструмента, и наружу она приходит завернутой.
function findLoopDetectedError(err: unknown): AiLoopDetectedError | null {
  if (err instanceof AiLoopDetectedError) return err;
  if (err instanceof Error && "cause" in err && err.cause) {
    return findLoopDetectedError(err.cause);
  }
  return null;
}

// Формирует текст, который увидит пользователь. Сюда не попадает ничего из ответа
// провайдера: только фиксированные фразы на категорию, чтобы в UI и в activity-записи не
// утекли имена моделей, ключи и фрагменты промпта.
function buildUserSafeExternalReason(err: unknown): string {
  const runtimeError = findRuntimeExecutionError(err);
  // Ошибка не распознана как ошибка рантайма - значит, сорвалась проверка возможностей.
  if (!runtimeError) {
    return "Runtime capability check failed. Check the configured runtime profile for this stage.";
  }

  // Ветвление по категории, а не по тексту: категория проставлена классификатором и
  // переживает смену формулировок в сообщениях провайдера.
  switch (runtimeError.category) {
    case "rate_limit":
      return "Runtime usage limit reached. Task auto-paused until the retry window.";
    case "auth":
      return "Runtime authentication failed. Check the configured runtime profile.";
    case "permission":
      return "Runtime permissions blocked this task. Check the configured runtime profile or approval mode.";
    case "timeout":
      return "Runtime request timed out. Task will retry automatically.";
    case "stream":
      return "Runtime stream failed. Task will retry automatically.";
    case "transport":
    default:
      return "Runtime request failed. Task will retry automatically.";
  }
}

function resolveRetryAfter(err: unknown): {
  retryAfter: string;
  retryAfterSource: RetryAfterSource;
  backoffMinutes: number | null;
  limitSnapshot: RuntimeLimitSnapshot | null;
} {
  // Приоритет источников срока: явная дата сброса, затем относительная задержка от
  // провайдера, и только потом случайный откат. Чем конкретнее метаданные, тем точнее момент
  // возобновления; случайный диапазон - признак того, что метаданных не было.
  const runtimeError = findRuntimeExecutionError(err);
  // Когда фича usage-limits выключена, не сохраняем снапшот лимитов на задаче.
  // Повтор/backoff продолжают применяться — просто пропускаем слой,
  // питающий (тоже гейтируемый) UI.
  const limitSnapshot = getEnv().AIF_USAGE_LIMITS_ENABLED
    ? (runtimeError?.limitSnapshot ?? null)
    : null;

  // Основной источник - дата сброса лимита от провайдера. Неразбираемая строка отбрасывается:
  // тогда сработают следующие ветки, а не запись мусора в состояние задачи.
  if (runtimeError?.resetAt) {
    const resetAtMs = Date.parse(runtimeError.resetAt);
    if (Number.isFinite(resetAtMs)) {
      return {
        retryAfter: new Date(Math.max(resetAtMs, Date.now())).toISOString(),
        retryAfterSource: "resetAt",
        backoffMinutes: null,
        limitSnapshot,
      };
    }
  }

  // Запасной источник - относительная задержка в секундах. Значение проверяется на
  // конечность и неотрицательность: ноль допустим (повтор сразу), минус и NaN - нет.
  if (
    typeof runtimeError?.retryAfterSeconds === "number" &&
    Number.isFinite(runtimeError.retryAfterSeconds) &&
    runtimeError.retryAfterSeconds >= 0
  ) {
    return {
      retryAfter: new Date(Date.now() + runtimeError.retryAfterSeconds * 1000).toISOString(),
      retryAfterSource: "retryAfterSeconds",
      backoffMinutes: null,
      limitSnapshot,
    };
  }

  // Метаданных о сроке нет: берем случайную задержку, чтобы одновременные задачи не ударили
  // в провайдер синхронной волной.
  const backoffMinutes = getRandomBackoffMinutes();
  return {
    retryAfter: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
    retryAfterSource: "random_backoff",
    backoffMinutes,
    limitSnapshot,
  };
}

/**
 * Классифицирует ошибку стадии и возвращает стратегию восстановления + поля статуса.
 * Применение обновления статуса — ответственность вызывающего кода.
 */

// Порядок веток ниже - это приоритет, а не произвольная последовательность:
// 1) ручная блокировка от подстадии, 2) детектор цикла, 3) потеря изоляции ветки,
// 4) ошибка конфигурации рантайма, 5) неповторяемые категории рантайма, 6) быстрый повтор,
// 7) внешний сбой с блокировкой и задержкой, 8) откат как крайняя мера. Проверки идут от
// самого конкретного признака к самому общему, и перестановка меняет смысл.
export function classifyStageError(input: StageErrorInput): ErrorRecovery {
  const { taskId, stageLabel, sourceStatus, err } = input;

  // Самый сильный сигнал: подстадия сама попросила остановить задачу, поэтому он проверяется
  // первым и никакая внешняя классификация его не перекрывает.
  const manualBlockErr = findStageManualBlockError(err);
  if (manualBlockErr) {
    // Формат записи единый для всех блокировок: его читают люди и grep, поэтому поля и
    // разделители одинаковы во всех ветках, меняются только значения.
    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(manualBlockErr.blockedReason)}`,
    );

    log.warn(
      {
        taskId,
        stage: stageLabel,
        errorName: manualBlockErr.name,
      },
      "Subagent stage requested manual block",
    );

    return {
      kind: "blocked_external",
      blockedReason: manualBlockErr.blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot: null,
    };
  }

  // Зацикливание на вызовах инструментов не лечится повтором: модель повторит ту же
  // последовательность. Нужен человек, поэтому блокировка без срока.
  const loopErr = findLoopDetectedError(err);
  if (loopErr) {
    const blockedReason = `possible_loop: ${loopErr.reason} (${loopErr.count}/${loopErr.limit})`;
    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        loopReason: loopErr.reason,
        count: loopErr.count,
        limit: loopErr.limit,
        retryAfter: null,
      },
      "Subagent stage aborted due to detected tool-call loop, task requires manual action",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot: null,
    };
  }

  // Сбои изоляции веток/рабочих деревьев НИКОГДА не должны попадать в общий
  // путь отката — откат провоцирует бесконечное перепланирование на сломанном
  // рабочем дереве. Помещаем задачу в blocked_external без повтора, чтобы
  // оператор осмотрел грязные изменения, пропавшие ветки или дрейф.
  // Снимок деревьев собирается только здесь и только для диагностики: он показывает, какое
  // именно дерево держит ветку, и снимает необходимость воспроизводить сбой.
  const branchErr = findBranchIsolationError(err);
  if (branchErr) {
    const blockedReason = `Branch isolation failure (${branchErr.kind}): ${branchErr.message}`;
    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );
    log.error(
      {
        taskId,
        stage: stageLabel,
        branchKind: branchErr.kind,
        branchName: branchErr.branchName,
        projectRoot: branchErr.projectRoot,
        // Git stderr безопасен для логов (текста провайдера нет); именно снимок
        // рабочего дерева делает диагностируемым "branch already checked out
        // elsewhere" вместо голого кода kind.
        errorMessage: branchErr.message,
        worktreeSnapshot: buildWorktreeSnapshot(branchErr.projectRoot),
      },
      "Subagent stage aborted due to branch isolation failure",
    );
    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot: null,
    };
  }

  // Ошибка конфигурации или нехватка возможностей рантайма: повтор не поможет, пока оператор
  // не поправит профиль рантайма или режим подтверждений.
  const configurationError = findConfigurationError(err);
  if (configurationError) {
    // Текст фиксированный: детали конфигурации пользователю не показываем, они уходят в лог
    // ниже вместе с кодом ошибки.
    const blockedReason = "Runtime configuration or capability requires manual action.";
    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );
    log.warn(
      {
        taskId,
        stage: stageLabel,
        errorName: configurationError.name,
        code: configurationError.code,
      },
      "Subagent failed with non-retryable runtime configuration error",
    );
    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot: null,
    };
  }

  // Проверка по категории из классификатора, без разбора текста. Здесь же готовится снимок
  // лимитов: он кладется в состояние задачи, поэтому подчиняется тому же переключателю, что и
  // в resolveRetryAfter, - при выключенной функции лимитов не сохраняется.
  const runtimeError = findRuntimeExecutionError(err);
  if (runtimeError && NON_RETRYABLE_RUNTIME_CATEGORIES.has(runtimeError.category)) {
    const safeReason = mapSafeRuntimeErrorReason(runtimeError);
    const blockedReason = `${safeReason.reason} Manual action required before retry.`;
    const limitSnapshot = getEnv().AIF_USAGE_LIMITS_ENABLED
      ? (runtimeError.limitSnapshot ?? null)
      : null;

    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        retryAfter: null,
        retryAfterSource: "none",
        // Категория пишется отдельным полем: по нему строятся алерты, и он снимает
        // необходимость разбирать текст ошибки глазами.
        runtimeCategory: runtimeError.category,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage:
          err instanceof Error
            ? redactProviderTextForLogs(err.message)
            : redactProviderTextForLogs(String(err)),
      },
      "Subagent failed with non-retryable runtime error, task requires manual action",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot,
    };
  }

  // Транзиентный обрыв потока: соединение рвется само по себе, и повтор почти всегда
  // проходит. Поэтому это единственный исход без блокировки и без задержки.
  if (isFastRetryableFailure(err)) {
    // Строка нужна только для лога ниже; решение уже принято классификатором.
    const reason = err instanceof Error ? err.message : String(err);

    log.warn(
      { taskId, stage: stageLabel, reason },
      "Subagent hit transient stream interruption, scheduling fast retry",
    );

    return { kind: "fast_retry" };
  }

  // Внешний сбой: провайдер или транспорт. Задача не теряется - она блокируется с
  // вычисленным сроком повтора, а счетчик попыток растет.
  if (isExternalFailure(err)) {
    const { retryAfter, retryAfterSource, backoffMinutes, limitSnapshot } = resolveRetryAfter(err);
    // Сырой текст сохраняется только для сравнения с безопасной формулировкой ниже и для
    // лога; в состояние задачи он не попадает.
    const reason = err instanceof Error ? err.message : String(err);
    const blockedReason = buildUserSafeExternalReason(err);
    const runtimeError = findRuntimeExecutionError(err);

    // Пишем подробности в лог лишь тогда, когда провайдер добавил что-то сверх стандартной
    // фразы: иначе лог засорялся бы одинаковыми записями.
    if (reason.trim() && reason.trim() !== blockedReason) {
      log.debug(
        {
          taskId,
          stage: stageLabel,
          safeReason: blockedReason,
          rawReason: redactProviderTextForLogs(reason),
        },
        "Redacted runtime error details before persisting blocked task state",
      );
    }

    // Случайный откат означает, что провайдер не дал ни даты сброса, ни задержки. Это повод
    // для предупреждения: частые такие записи говорят о проблеме в профиле рантайма.
    if (retryAfterSource === "random_backoff") {
      log.warn(
        {
          taskId,
          stage: stageLabel,
          retryAfter,
          backoffMinutes,
          runtimeId: limitSnapshot?.runtimeId ?? null,
          providerId: limitSnapshot?.providerId ?? null,
          profileId: limitSnapshot?.profileId ?? null,
        },
        "Structured reset metadata missing for external error, falling back to random backoff",
      );
    }

    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=${retryAfter}; source=${retryAfterSource}; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        retryAfter,
        retryAfterSource,
        backoffMinutes,
        runtimeId: limitSnapshot?.runtimeId ?? null,
        providerId: limitSnapshot?.providerId ?? null,
        profileId: limitSnapshot?.profileId ?? null,
        resetAt: runtimeError?.resetAt ?? null,
        retryAfterSeconds: runtimeError?.retryAfterSeconds ?? null,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: redactProviderTextForLogs(reason),
      },
      "Subagent failed with external error, task blocked with backoff",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter,
      retryAfterSource,
      // Счетчик растет только у внешних сбоев: именно они расходуют попытки, тогда как
      // быстрый повтор и блокировка счетчик не трогают.
      retryCount: (input.retryCount ?? 0) + 1,
      limitSnapshot,
    };
  }

  log.error(
    {
      taskId,
      stage: stageLabel,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage:
        err instanceof Error
          ? redactProviderTextForLogs(err.message)
          : redactProviderTextForLogs(String(err)),
    },
    "Subagent failed, reverting status",
  );

  // Последняя ветка: сбой не опознан ни одним классификатором. Откат возвращает стадию в
  // начало, что дешевле молчаливого зависания задачи; если такие случаи часты, значит
  // классификатору не хватает нового структурного признака.
  return { kind: "revert" };
}
