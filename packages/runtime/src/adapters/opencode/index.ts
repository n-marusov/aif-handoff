/**
 * Точка входа OpenCode-адаптера рантайма.
 *
 * В отличие от Claude и Codex, у OpenCode единственный транспорт - HTTP API к
 * локально поднятому `opencode serve` (см. ./api.ts). Поэтому адаптер не раздаёт
 * работу по транспортам, а целиком строится поверх одного API-клиента.
 *
 * Здесь собраны три вещи: capabilities-контракт, который workflow-узлы проверяют до
 * запуска; рантайм-нейтральные обёртки, добавляющие логирование и классификацию
 * ошибок; и диагностика сбоев для UI. Ошибки всегда проходят через
 * classifyOpenCodeRuntimeError, поэтому наружу отдаются структурные категории, а не
 * сырой текст, который потребителю пришлось бы разбирать.
 */

import {
  RuntimeTransport,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeDiagnoseErrorInput,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
  type RuntimeEvent,
} from "../../types.js";
import {
  getOpenCodeSession,
  listOpenCodeApiModels,
  listOpenCodeSessionEvents,
  listOpenCodeSessions,
  runOpenCodeApi,
  validateOpenCodeApiConnection,
  type OpenCodeApiLogger,
} from "./api.js";
import { classifyOpenCodeRuntimeError } from "./errors.js";
import { RuntimeExecutionError } from "../../errors.js";
import { OPENCODE_MODEL_EFFORT_LEVELS } from "../../modelEffort.js";

// Адаптер принимает ровно тот же структурный интерфейс логгера, что и api.ts:
// отдельный тип нужен лишь как точка расширения, а не как прослойка-адаптер.
// Любой совместимый по форме логгер (например pino) подойдёт без обёрток.
export type OpenCodeRuntimeAdapterLogger = OpenCodeApiLogger;

// Всё опционально: реестр создаёт built-in адаптеры без аргументов, а незаданное
// доопределяется дефолтами ниже (id, fallback-логгер, отображаемое имя). Оставленные
// параметры нужны прежде всего тестам и конфигурации с собственным runtimeId.
export interface CreateOpenCodeRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: OpenCodeRuntimeAdapterLogger;
}

// Контракт возможностей - это не описание "что умеет библиотека вообще", а обещание
// "на что можно положиться при любой конфигурации". capabilities.ts ассертит их до
// старта workflow, поэтому лучше заявить false и явно упасть, чем пообещать
// поддержку и сломаться в середине прогона.
const API_CAPABILITIES: RuntimeCapabilities = {
  // Продолжение сессии идёт обычным POST в ту же сессию - сервер хранит историю сам.
  supportsResume: true,
  // Форк отдельной ветки сессии сервером не предусмотрен - заявлять его нельзя.
  supportsSessionFork: false,
  // GET /session отдаёт список, его хватает для UI истории запусков.
  supportsSessionList: true,
  // Агентские определения (.claude/agents) через этот транспорт не передаются.
  supportsAgentDefinitions: false,
  // Ответ возвращается целиком, но экранное событие отдаётся по мере готовности.
  supportsStreaming: true,
  // Модели читаются из /config/providers - discovery опирается на живые данные.
  supportsModelDiscovery: true,
  // Интерактивный диалог одобрений реализован только у транспортов с approvals.
  supportsApprovals: false,
  // baseUrl профиля подставляется в запросы - кастомный endpoint поддержан.
  supportsCustomEndpoint: true,
  // Системный промпт и промпт инструментов - только на уровне текста запроса.
  supportsWorkspaceTools: true,
  // OpenCode server возвращает сообщения, но не отдаёт счётчики токенов в
  // message payload. Путь run() никогда не заполняет RuntimeRunResult.usage,
  // поэтому контракт честно объявлен как NONE — дашборды покажут этот
  // провайдер как отказавшийся от учёта, а не с фантомными нулями.
  // usageReporting: NONE согласуется с честным usage: null в результате запуска -
  // счётчики токенов не эмулируются нулями, и дашборды видят явный отказ, а не фантомные цифры.
  usageReporting: UsageReporting.NONE,
};

// Список-fallback на случай недоступного сервера. Он нужен не для работы агента, а
// чтобы UI не оставался с пустым селектом моделей; как только discovery отвечает,
// живой список полностью вытесняет этот.
const DEFAULT_OPENCODE_MODELS: RuntimeModel[] = [
  {
    id: "anthropic/claude-sonnet-4",
    label: "anthropic/claude-sonnet-4",
    supportsStreaming: true,
  },
  {
    id: "openai/gpt-5.4",
    label: "openai/gpt-5.4",
    supportsStreaming: true,
  },
];

// Реестр строит адаптер без аргументов, поэтому логгер обязан иметь дефолт. Здесь
// намеренно console, а не pino: библиотека рантайма не тянет зависимость логгера, а
// вызывающий код всё равно передаёт свой при сборке через options.logger.
function createFallbackLogger(): OpenCodeRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("[runtime:opencode]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:opencode]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:opencode]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:opencode]", message, context);
    },
  };
}

// Диагностика - единственное место модуля, где текст ошибки превращается в текст
// подсказки: этот результат идёт в UI человеку, а не в ветвления логики, поэтому
// здесь допустимо и сопоставление по строкам. Начинаем со структурной категории, а
// строковый разбор оставляем только для сбоев, не прошедших классификатор.
function diagnoseErrorMessage(input: RuntimeDiagnoseErrorInput): string {
  // Текст исходной ошибки нужен только как хвост подсказки (category permission и
  // stream передают его дальше); решений по нему не принимается.
  const message = input.error instanceof Error ? input.error.message : String(input.error);

  // Основной путь: развилка по структурной category, когда доступна
  // Ветвление идёт по category, а не по тексту: формулировки сервера меняются от
  // релиза к релизу, а категория - стабильный контракт. unknown исключён намеренно:
  // он означает, что структуры нет и надо пробовать текстовый fallback ниже.
  if (input.error instanceof RuntimeExecutionError && input.error.category !== "unknown") {
    switch (input.error.category) {
      case "auth":
        return "OpenCode server authentication failed. Verify OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if customized).";
      case "rate_limit":
        return "OpenCode request was rate-limited. Retry with backoff or reduce request frequency.";
      case "timeout":
        return "OpenCode request timed out. Increase timeoutMs or check server responsiveness.";
      case "transport":
        return "Cannot reach OpenCode server. Start opencode serve and verify baseUrl/port.";
      case "model_not_found":
        return "OpenCode provider/model is not available. Check GET /config/providers and use an exact providerID/modelID pair from that response.";
      case "permission":
        return `OpenCode permission denied. ${message}`;
      case "stream":
        return `OpenCode stream interrupted. ${message}`;
    }
  }

  // Резерв: сопоставление строк для неклассифицированных ошибок или plain Error
  // Здесь остаются только ошибки без распознанной категории, поэтому строки - не
  // замена структуре, а единственный доступный сигнал. Хвост stderr добавляется,
  // потому что при падении соединения полезная причина часто остаётся именно там.
  const combined = `${message} ${input.stderrTail ?? ""}`.toLowerCase();

  if (
    combined.includes("unauthorized") ||
    combined.includes("invalid password") ||
    combined.includes("401") ||
    combined.includes("403")
  ) {
    return "OpenCode server authentication failed. Verify OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if customized).";
  }
  if (combined.includes("rate") || combined.includes("429") || combined.includes("quota")) {
    return "OpenCode request was rate-limited. Retry with backoff or reduce request frequency.";
  }
  if (
    combined.includes("connection refused") ||
    combined.includes("econnrefused") ||
    combined.includes("fetch failed") ||
    combined.includes("network")
  ) {
    return "Cannot reach OpenCode server. Start opencode serve and verify baseUrl/port.";
  }
  if (combined.includes("session") && combined.includes("not found")) {
    return "OpenCode session not found. Create a new session or provide a valid sessionId.";
  }
  if (
    combined.includes("providermodelnotfounderror") ||
    combined.includes("modelnotfounderror") ||
    combined.includes("provider not found") ||
    combined.includes("model not found")
  ) {
    return "OpenCode provider/model is not available. Check GET /config/providers and use an exact providerID/modelID pair from that response.";
  }

  return `OpenCode error: ${message}`;
}

/**
 * Фабрика, а не класс: реестр и bootstrap работают с обычным объектом-значением
 * RuntimeAdapter, поэтому замыкание на options удобнее наследования - все зависимости
 * (logger, id) фиксируются один раз при создании.
 */
export function createOpenCodeRuntimeAdapter(
  options: CreateOpenCodeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  // Дефолты вместо обязательных параметров: адаптер должен собираться и без настройки
  // (например, в тестах или в докере с переменными окружения).
  const runtimeId = options.runtimeId ?? "opencode";
  const providerId = options.providerId ?? "opencode";
  // Логгер разрешается на этапе создания, чтобы внутри методов не проверять его на null.
  const logger = options.logger ?? createFallbackLogger();

  return {
    // descriptor - то, как адаптер видится реестру и UI: идентификаторы, транспорт,
    // окружение по умолчанию и тот же capabilities, по которому идут ассерты.
    descriptor: {
      id: runtimeId,
      providerId,
      // displayName отделён от id: пользователь может завести профиль с другим id,
      // но в интерфейсе всё равно должно быть видно имя технологии.
      displayName: options.displayName ?? "OpenCode",
      // Проект инициализируется служебным агентом opencode (см. projectInit).
      supportsProjectInit: true,
      projectInitAgentName: "opencode",
      // lightModel не заявлен: дешёвой модели для автопроверок у этого рантайма нет,
      // и подставлять произвольную было бы нечестно - reviewGate получит явный null.
      lightModel: null,
      defaultApiKeyEnvVar: "OPENCODE_API_KEY",
      apiKeyEnvCandidates: ["OPENCODE_API_KEY"],
      // UI подсказывает эти значения в форме профиля, чтобы не запоминать их вручную.
      defaultBaseUrlEnvVar: "OPENCODE_BASE_URL",
      defaultBaseUrl: "http://localhost:4096",
      defaultModelEnvVar: "OPENCODE_MODEL",
      defaultModelPlaceholder: "anthropic/claude-sonnet-4",
      // Список из одного элемента - не ограничение, а фиксация единственного
      // реализованного транспорта: HTTP API к opencode serve.
      supportedTransports: [RuntimeTransport.API],
      defaultTransport: RuntimeTransport.API,
      effort: {
        optionKey: "reasoningEffort",
        fallbackLevels: OPENCODE_MODEL_EFFORT_LEVELS,
      },
      capabilities: API_CAPABILITIES,
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      // Логируем вход до вызова: при падении будет видно, с какими параметрами
      // пришли. Секреты не попадают в лог - api.ts сам чистит options.
      logger.info?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.API,
          sessionId: input.sessionId ?? null,
          model: input.model ?? null,
          stream: input.stream ?? null,
        },
        "OpenCode adapter run invoked",
      );

      try {
        // transport проставляется принудительно: у адаптера один путь, и даже если
        // выше передали другой транспорт, запуск всё равно идёт через API.
        return await runOpenCodeApi({ ...input, transport: RuntimeTransport.API }, logger);
      } catch (error) {
        // Логируем и только затем классифицируем: текст исключения нужен в логе,
        // а наружу уходит уже структурированная ошибка с category/adapterCode.
        logger.error?.(
          {
            runtimeId,
            profileId: input.profileId ?? null,
            error: error instanceof Error ? error.message : String(error),
          },
          "OpenCode adapter run failed",
        );
        throw classifyOpenCodeRuntimeError(error);
      }
    },

    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      // resume - та же отправка сообщения, но с флагом resume: true: имя метода
      // говорит о намерении, а не о другом HTTP-эндпоинте.
      logger.info?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          sessionId: input.sessionId,
        },
        "OpenCode adapter resume invoked",
      );

      try {
        return await runOpenCodeApi(
          { ...input, transport: RuntimeTransport.API, resume: true },
          logger,
        );
      } catch (error) {
        // Классификация без логирования: run() уже пишет свой контекст, дублировать
        // его на каждом уровне не нужно.
        throw classifyOpenCodeRuntimeError(error);
      }
    },

    // Тонкие прокси: вся работа с HTTP - в api.ts, здесь только привязка логгера,
    // чтобы каждый запрос адаптера был виден в общем логе рантайма.
    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      return listOpenCodeSessions(input, logger);
    },

    // Возвращает null вместо исключения, когда сессии нет: отсутствие записи -
    // нормальная ситуация (сессию могли удалить), и превращать её в падение незачем.
    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      return getOpenCodeSession(input, logger);
    },

    async listSessionEvents(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]> {
      return listOpenCodeSessionEvents(input, logger);
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      // transport задаётся явно по той же причине, что и в run(): валидация идёт
      // только через API-транспорт, независимо от того, что пришло в input.
      return validateOpenCodeApiConnection({ ...input, transport: RuntimeTransport.API });
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      try {
        const models = await listOpenCodeApiModels(input);
        // Пустой ответ считается неудачей: сервер ответил, но моделей не отдал,
        // поэтому используется тот же fallback, что и при ошибке - иначе UI
        // получил бы пустой селект без объяснения.
        if (models.length > 0) {
          logger.debug?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
              modelCount: models.length,
            },
            "Fetched model list from OpenCode API",
          );
          return models;
        }
      } catch {
        // Ошибка discovery не должна валить весь адаптер: список моделей -
        // вспомогательная возможность, поэтому деградируем до встроенного набора
        // и сообщаем об этом в лог уровнем warn.
        logger.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
          },
          "OpenCode model discovery failed, falling back to built-in list",
        );
      }

      // Сюда попадаем и при исключении, и при пустом ответе - оба случая
      // равнозначны для UI.
      return DEFAULT_OPENCODE_MODELS;
    },

    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      // Диагностика синхронна: shared-слой ждёт Promise, поэтому метод помечен
      // async, но никакой работы с сетью здесь нет.
      return diagnoseErrorMessage(input);
    },
  };
}
