/**
 * Оркестрация одного запуска Claude: version-guard -> попытка запроса -> до двух
 * ограниченных повторов -> всегда структурированная ошибка наружу.
 *
 * Функция намеренно тонкая: сам стрим и разбор событий живут в stream.js,
 * опции — в options.js, классификация — в errors.js. Здесь только политика
 * восстановления:
 * 1) перед любым эффектом проверяется совместимость бинарника (version.ts) —
 *    дешевле остановиться до создания сессии, чем разбираться с кодом 1 без stderr;
 * 2) сорванный resume (сессия CLI пропала/протухла) повторяется свежей сессией:
 *    промпт всё ещё валиден, потеряна лишь история, и тихий fresh-start лучше
 *    красной ошибки для пользователя таска;
 * 3) start-timeout (SDK не начал отвечать за отведённое окно) повторяется один раз:
 *    чаще всего это временная загрузка машины, а не ошибка задачи.
 *
 * Почему ретраи живут именно на этом уровне, а не в каждом транспорте отдельно:
 * политика «сломанный resume — перейти на свежую сессию», «долгий старт —
 * повторить один раз» одинакова для SDK и CLI транспортов, и её место — над ними.
 * Транспорт остаётся на один запуск, а ветвление сценариев — задача оркестратора.
 *
 * Инвариант «не зависнуть в ретраях»: каждый путь даёт максимум одно повторное
 * выполнение (attempt + retry), циклов нет — суммарно не больше двух стримов на
 * ран. Вторично упавшая попытка не повторяется: две одинаковые неудачи подряд —
 * сигнал, что проблема системная, и третий стрим её не решит.
 *
 * Инвариант ошибок (правило проекта): наружу из модуля выходят только экземпляры
 * ClaudeRuntimeAdapterError с category/adapterCode — потребители ветвятся по
 * структурированным полям. Исключение — чтение сообщений SDK для решений о
 * resume/таймауте: у этих сигналов структурированных полей просто нет, см.
 * исчерпывающие комментарии над isMissingResumeSessionError.
 */

// Импорты показывают слоёную структуру модуля: контракты — из общего runtime'а,
// тайм-аутные решения — из общей политики, а вся адаптерная специфика — из соседей
// по каталогу. Ничего из @aif/data или API здесь нет: транспорт не знает о БД.
import type { RuntimeRunInput, RuntimeRunResult } from "../../types.js";
import { isRetriableTimeoutError, resolveRetryDelay } from "../../timeouts.js";
import { classifyClaudeRuntimeError } from "./errors.js";
import { parseExecutionOptions } from "./options.js";
import { assertClaudeExecutableCompatible } from "./version.js";
import { runClaudeQueryAttempt } from "./stream.js";

// Реэкспорт типа опций: потребители адаптера (индекс пакета, тесты) импортируют
// всё, что касается запуска, из одного модуля и не обязаны знать, что разбор
// параметров живёт отдельно в options.ts.
export type { ClaudeRuntimeExecutionOptions } from "./options.js";

// Полный обязательный контракт логгера (в отличие от опционального в version.ts):
// этот модуль всегда вызывается из адаптера с pino-логгером, а информационные
// строки о ходе рана — часть наблюдаемости конвейера, не «пожелание» вызывающего.
// Контракт логгера описан своими руками, а не взят из pino: адаптер не должен
// зависеть от конкретного библиотечного типа, ему достаточно четырёх методов.
// Так транспорт остаётся тестируемым (в тестах — простой объект с noop'ами), а не
// привязанным к реализации логирования.
export interface ClaudeRuntimeRunLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

function sleep(ms: number): Promise<void> {
  // Короткий путь для ms <= 0: без него «нулевая задержка» всё равно сдвигала бы
  // продолжение на тик event loop'а, а Promise.resolve() возобновляет мгновенно.
  // В отличие от withTimeout.ts, таймер здесь НЕ помечается unref: на время паузы
  // процесс обязан оставаться живым — иначе повтор просто не состоялся бы.
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Сопоставление по строке здесь намеренное: Claude Agent SDK отдаёт
 * session-not-found как plain Error(message) без структурного класса ошибки,
 * HTTP-статуса или subtype. Это внутренние сигналы жизненного цикла сессии.
 */
// Русская справка к исключению из правила «никакого матчинга по строкам»: здесь
// сопоставление — не классификация для внешнего мира, а разбор служебных сигналов
// жизненного цикла сессий, у которых в SDK нет ни класса ошибки, ни subtype, ни
// HTTP-статуса. Результат функции влияет только на выбор «повторить fresh или
// нет»; ошибка наружу всё равно уйдёт через classifyClaudeRuntimeError.
function isMissingResumeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("no conversation found with session id") ||
    lowered.includes("no conversation found for session id") ||
    lowered.includes("session not found")
  );
}

/**
 * Сопоставление по строке здесь намеренное: Claude Agent SDK сообщает execution
 * failures и error results как plain Error(message). Для этих внутренних
 * сигналов нет структурного класса ошибки и HTTP-статуса.
 */
// Нижним регистром и через includes: формулировки меняются между сборками CLI, и
// точное совпадение/регистр ломали бы восстановление на каждом релизе Anthropic.
// Набор сигналов шире, чем «сессии нет»: execution-сбой и error-result тоже часто
// проходят на свежей сессии, поэтому они делят одну retry-ветку.
function isRetryableResumeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    isMissingResumeSessionError(error) ||
    lowered.includes("error_during_execution") ||
    lowered.includes("claude code returned an error result")
  );
}

// Проекция внутреннего объекта попытки в публичный RuntimeRunResult: поля
// совпадают, но разделение осознанное — завтра у attempt появятся внутренние
// счётчики/диагностика, и они не протечут в контракт адаптера сами по себе.
// events и usage передаются без преобразований: их форму определяет стрим, и
// повторная валидация здесь только создала бы второе место правды.
function toResult(attempt: {
  outputText: string;
  // sessionId nullable: SDK возвращает null, когда сессию не удалось завести
  // (например, упало до ответа); это не ошибка сама по себе — контракт результата
  // допускает ран без сессии.
  sessionId: string | null;
  events: import("../../types.js").RuntimeEvent[];
  usage: import("../../types.js").RuntimeUsage | null;
}): RuntimeRunResult {
  return {
    outputText: attempt.outputText,
    sessionId: attempt.sessionId,
    events: attempt.events,
    usage: attempt.usage,
  };
}

/**
 * Выполняет запрос через Claude Agent SDK с поддержкой:
 * - детекта query_start_timeout и одной повторной попытки;
 * - детекта ошибки resume и перехода на новую сессию;
 * - структурированной классификации ошибок.
 */
export async function runClaudeRuntime(
  input: RuntimeRunInput,
  logger: ClaudeRuntimeRunLogger,
  // Дефолты адаптера, а не задачи: путь к бинарнику из конфигурации рантайма.
  // Приоритет у input — вызывающий код (проектный/задачный профиль) всегда
  // сильнее глобальной настройки адаптера.
  adapterDefaults?: {
    pathToClaudeCodeExecutable?: string;
  },
): Promise<RuntimeRunResult> {
  const execution = parseExecutionOptions(input, adapterDefaults);

  // Проверяем минимальную версию Claude Code до старта выполнения. Старые
  // сборки отвергают пустые attribution-строки (подавление Co-Authored-By)
  // и завершаются с кодом 1; guard выдаёт более полезную причину заранее.
  // Проверяется именно бинарник, который запустит `query()`:
  // `pathToClaudeCodeExecutable`, если задан, иначе bundled-бинарник SDK.
  // Проверка не использует случайный `claude` из PATH, чтобы не валидировать
  // другой артефакт и не получить ложную совместимость.
  // Guard до первого байта общения с SDK: он не создаёт сессий и не тратит бюджет,
  // а несовместимый бинарник отсекается ещё до побочных эффектов. Контекст
  // (runtimeId/providerId/profileId) передаётся ради привязки warn-лога к профилю.
  await assertClaudeExecutableCompatible(execution.pathToClaudeCodeExecutable, logger, {
    runtimeId: input.runtimeId,
    providerId: input.providerId ?? "anthropic",
    profileId: input.profileId ?? null,
  });

  // Задержка повторов вычисляется один раз на ран, а не на каждую retry-ветку:
  // обе попытки должны ждать одинаково, иначе логика тестов таймингов двоится.
  const retryDelayMs = resolveRetryDelay({
    startRetryDelayMs: execution.queryStartRetryDelayMs,
  });

  // Снимок входных параметров до стрима: если ран подвесится/упадёт внутри SDK,
  // в логах останется ровно та конфигурация, с которой его запустили.
  logger.info(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      workflowKind: input.workflowKind ?? null,
      profileId: input.profileId ?? null,
      model: input.model ?? null,
      // Boolean, а не сам sessionId: в логе важно само «продолжаем или нет»,
      // а идентификатор сессии — уже техническая подробность конкретного рана.
      resume: Boolean(input.resume && input.sessionId),
      // Во всех полях контекста null, а не undefined: undefined-ключи исчезают при
      // JSON-сериализации лога, и поле «пропало бы» из записи.
      hasAgentDefinitionName: Boolean(execution.agentDefinitionName),
      // Бюджет и оба тайм-аута попадают в ту же строку намеренно: при разборе
      // «почему оборвалось» эти три числа — первое, что нужно сопоставить с
      // реальными timestamps событий.
      maxBudgetUsd: execution.maxBudgetUsd ?? null,
      // Разделение двух таймаутов важно при чтении логов: queryStartTimeoutMs —
      // потолок на «SDK вообще заговорил», runTimeoutMs — на «говорит, но не
      // заканчивает». Без этих чисел один и тот же текст ошибки не отличил бы
      // одно от другого.
      startTimeoutMs: execution.queryStartTimeoutMs ?? null,
      runTimeoutMs: execution.runTimeoutMs ?? null,
    },
    "Starting Claude runtime run",
  );

  try {
    const attempt = await runClaudeQueryAttempt(input, execution, logger);
    // Успех логируется отдельной строкой с признаком сессии: следующая попытка
    // (уже в другом ране) сможет resume именно эту сессию — то есть строка несёт
    // не только «ok», но и точку продолжения.
    logger.info(
      {
        runtimeId: input.runtimeId,
        // runtimeId + workflowKind повторяются во всех трёх логах рана (старт,
        // успех, ошибка) — по ним записи одного запуска склеиваются в истории,
        // даже если ран шёл параллельно с другими задачами.
        workflowKind: input.workflowKind ?? null,
        hasSessionId: Boolean(attempt.sessionId),
      },
      "Claude runtime run completed",
    );
    return toResult(attempt);
  } catch (error) {
    // Путь повтора 1: resume не удался (сессия отсутствует / execution error)
    // -> новая сессия.
    // Ветки проверяются по порядку и взаимоисключающе: resume-повтор имеет смысл
    // только при активном resume, а таймаут-повтор — при ошибке старта; попасть в
    // обе сразу нельзя, поэтому второй повтор поверх первого не выполняется.
    // Условие guard'ится и resume-флагом, и наличием sessionId: повторять «вслепую»
    // нельзя — без идентификатора не было бы что терять. Внутри — точечная
    // пересборка input ({ resume: false, sessionId: null }) вместо мутации
    // оригинала: контекст вызова остаётся чистым для логов и вложенных обработок.
    if (input.resume && input.sessionId && isRetryableResumeFailure(error)) {
      logger.warn(
        {
          runtimeId: input.runtimeId,
          workflowKind: input.workflowKind ?? null,
          resumeSessionId: input.sessionId,
          // Текст ошибки в warn'е — для человека; управление решается не по нему
          // (isRetryableResumeFailure отработал раньше), поэтому свободный формат
          // здесь безопасен.
          error: error instanceof Error ? error.message : String(error),
        },
        // Текст сообщения называет ветку («without resume»): в логах этот warn
        // должен отличаться от повтора по таймауту, иначе по одной строке не
        // понять, какой из двух сценариев восстановления сработал.
        "Claude runtime resume attempt failed, retrying without resume",
      );
      await sleep(retryDelayMs);
      try {
        // Успех fresh-сессии возвращается как есть: новый sessionId придёт из
        // ответа SDK, и следующая попытка resume продолжит уже новую историю.
        return toResult(
          await runClaudeQueryAttempt(
            { ...input, resume: false, sessionId: null },
            execution,
            logger,
          ),
        );
      } catch (resumeRetryError) {
        // Вторая неудача — терминальная: квота «одна повторная попытка» на этом
        // пути исчерпана, ошибка классифицируется на выход без дальнейших повторов.
        const classified = classifyClaudeRuntimeError(resumeRetryError);
        logger.error(
          {
            runtimeId: input.runtimeId,
            workflowKind: input.workflowKind ?? null,
            code: classified.adapterCode,
            error: classified.message,
          },
          // Формулировка фиксирует, что повтор уже был: по ней можно отличить
          // «упало сразу» от «упало после восстановления» — это разные диагнозы.
          "Claude runtime run failed after missing-session resume retry",
        );
        throw classified;
      }
    }

    // Путь повтора 2: таймаут старта (retriable) -> одна повторная попытка.
    // Решает структурированный флаг isRetriableTimeoutError (timeouts.js), а не
    // разбор текста: start-timeout — наш собственный класс ошибки с категорией.
    // Вход повторяется без изменений: в отличие от resume-ветки здесь терять
    // нечего — сессия либо не завелась, либо заведётся так же, как в прошлый раз.
    // Предикат «можно ли повторить» живёт в общей политике тайм-аутов, а не здесь:
    // изменения правил не должны ходить вручную по каждому адаптеру.
    if (isRetriableTimeoutError(error)) {
      logger.warn(
        {
          runtimeId: input.runtimeId,
          workflowKind: input.workflowKind ?? null,
          startTimeoutMs: execution.queryStartTimeoutMs ?? null,
        },
        "Claude runtime start timeout detected, retrying once",
      );
      await sleep(retryDelayMs);
      try {
        // Один и тот же execution переиспользуется в повторе: опции парсуются
        // один раз на ран, и повтор не может незаметно уехать на других лимитах,
        // чем первая попытка.
        return toResult(await runClaudeQueryAttempt(input, execution, logger));
      } catch (retryError) {
        const classified = classifyClaudeRuntimeError(retryError);
        logger.error(
          {
            runtimeId: input.runtimeId,
            workflowKind: input.workflowKind ?? null,
            // Код кладётся в отдельное поле, а не только в текст: по нему потом
            // можно агрегировать инциденты, не разбирая свободный текст.
            code: classified.adapterCode,
            error: classified.message,
          },
          "Claude runtime run failed after retry",
        );
        throw classified;
      }
    }

    // Финальный отказ.
    // Финальная нормализация любого исхода: сырая ошибка SDK, Error из стрима или
    // собственный throw — всё проходит через classify и покидает модуль в виде
    // ClaudeRuntimeAdapterError с category/adapterCode для ветвления наверху.
    // Решение «повторять ли ещё» здесь не принимается: у координатора свои правила
    // (лимиты, бюджет, состояние задачи), и адаптер не должен их дублировать.
    const classified = classifyClaudeRuntimeError(error);
    logger.error(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        code: classified.adapterCode,
        error: classified.message,
      },
      "Claude runtime run failed",
    );
    throw classified;
  }
}
