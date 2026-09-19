/**
 * Адаптер рантайма OpenRouter: точка сборки между общим контрактом RuntimeAdapter и
 * HTTP-транспортом из ./api.ts.
 *
 * Адаптер намеренно "тонкий": он не знает деталей HTTP и SSE, а только объявляет
 * возможности, выбирает транспорт и переводит ошибки в структурный вид. Такое разделение
 * позволяет менять протокол общения с провайдером, не трогая регистрацию рантайма и UI.
 *
 * Ключевая особенность OpenRouter: единственный транспорт - HTTP API. Возобновление сессий,
 * определения агентов и workspace-инструменты недоступны, и это честно отражено в
 * capability-флагах: заявлять неподдерживаемое нельзя, иначе координатор начнёт строить
 * workflow на несуществующих возможностях и упадёт в рантайме.
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
} from "../../types.js";
import {
  listOpenRouterApiModels,
  runOpenRouterApi,
  runOpenRouterApiStreaming,
  validateOpenRouterApiConnection,
  type OpenRouterApiLogger,
} from "./api.js";
import { classifyOpenRouterRuntimeError } from "./errors.js";
import { RuntimeExecutionError } from "../../errors.js";
import { OPENROUTER_MODEL_EFFORT_LEVELS } from "../../modelEffort.js";
import { diagnoseRuntimeFailure, type AdapterDiagnosticMessages } from "../diagnostics.js";

// Логгер адаптера расширяет логгер API опциональным error: сам транспорт ошибки не логирует,
// а верхнему уровню полезно видеть их через тот же канал.
export type OpenRouterAdapterLogger = OpenRouterApiLogger & {
  error?(context: Record<string, unknown>, message: string): void;
};

// Опции создания позволяют зарегистрировать несколько профилей одного провайдера:
// идентификаторы подменяемы, а displayName показывается в UI. Все поля необязательные -
// значения по умолчанию совпадают с системными и подходят для типового развёртывания.
export interface CreateOpenRouterRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: OpenRouterAdapterLogger;
}

// Резервный список моделей. Нужен, когда discovery недоступен (нет сети, нет ключа):
// пустой список сломал бы выбор модели в UI, поэтому лучше показать заведомо рабочие модели
// и дать пользователю возможность ввести идентификатор вручную.
const DEFAULT_OPENROUTER_MODELS: RuntimeModel[] = [
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", supportsStreaming: true },
  { id: "openai/gpt-4o", label: "GPT-4o", supportsStreaming: true },
  { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash", supportsStreaming: true },
];

// Возможности API-транспорта заявлены по фактическому поведению провайдера:
// - сессии не переиспользуются и не форкаются: OpenRouter stateless, история передаётся целиком;
// - стриминг и tool calling поддержаны протоколом chat completions;
// - usageReporting = FULL, потому что провайдер возвращает токены и стоимость в поле usage,
//   и это часть контракта адаптера: RuntimeRunResult.usage должен быть RuntimeUsage либо null.
const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  supportsWorkspaceTools: false,
  supportsToolCalling: true,
  usageReporting: UsageReporting.FULL,
};

// Запасной логгер на случай, когда вызывающий не передал свой. Префикс помечает источник, а
// вывод идёт в stdout/stderr процесса: в Docker это ожидаемо видно в общем логе контейнера.
function createFallbackLogger(): OpenRouterAdapterLogger {
  return {
    debug(context, message) {
      console.debug("[runtime:openrouter]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:openrouter]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:openrouter]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:openrouter]", message, context);
    },
  };
}

// Приводит unknown к объекту-записи для обхода полей. Возвращает пустой объект для null,
// массивов и примитивов: вызывающий получает безопасный для чтения контейнер и не обязан
// проверять тип на каждом шаге. Функция не бросает - разбор недоверенного ввода не должен
// падать на неожиданной структуре.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Строка считается валидной, только если после trim она не пуста: пустое значение из
// переменной окружения эквивалентно отсутствию значения. Тип string | null объявлен
// осознанно - вызывающий обязан явно обработать случай "значения нет", а не получить
// молча пустую строку.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Формулировки диагностики OpenRouter вынесены в декларативную таблицу: сам каркас
// (category-развилка + строковый fallback) общий для всех адаптеров (см. diagnostics.ts),
// здесь только содержимое подсказок.
const OPENROUTER_DIAGNOSTIC_MESSAGES: AdapterDiagnosticMessages = {
  providerLabel: "OpenRouter",
  categoryMap: {
    auth: "OpenRouter API key is missing or invalid. Check OPENROUTER_API_KEY environment variable.",
    rate_limit:
      "OpenRouter rate limit or quota exceeded. Wait and retry, or check your plan limits at openrouter.ai.",
    model_not_found:
      "The requested model is not available on OpenRouter. Check the model ID format (provider/model).",
    context_length:
      "The prompt exceeds the model's maximum context length. Reduce the input or choose a model with a larger context window.",
    content_filter:
      "OpenRouter blocked the request due to content policy. Review the prompt content.",
    transport: "Cannot reach OpenRouter API. Check network connectivity and OPENROUTER_BASE_URL.",
  },
  rawTailCategories: {
    timeout: "OpenRouter request timed out.",
    permission: "OpenRouter permission denied.",
    stream: "OpenRouter stream interrupted.",
  },
  textRules: [
    {
      pattern: /unauthorized|invalid api key|401/,
      message:
        "OpenRouter API key is missing or invalid. Check OPENROUTER_API_KEY environment variable.",
    },
    {
      pattern: /rate limit|429|quota/,
      message:
        "OpenRouter rate limit or quota exceeded. Wait and retry, or check your plan limits at openrouter.ai.",
    },
    {
      pattern: /model not found|no endpoints found/,
      message:
        "The requested model is not available on OpenRouter. Check the model ID format (provider/model).",
    },
    {
      pattern: /context_length_exceeded/,
      message:
        "The prompt exceeds the model's maximum context length. Reduce the input or choose a model with a larger context window.",
    },
    {
      pattern: /connection refused|fetch failed/,
      message: "Cannot reach OpenRouter API. Check network connectivity and OPENROUTER_BASE_URL.",
    },
  ],
};

// Человекочитаемая диагностика: общий шаблон + таблица формулировок OpenRouter.
function diagnoseErrorMessage(input: RuntimeDiagnoseErrorInput): string {
  return diagnoseRuntimeFailure(input, OPENROUTER_DIAGNOSTIC_MESSAGES);
}

// Фабрика адаптера. Дефолты применяются один раз, на этапе создания: объект адаптера
// иммутабелен по смыслу, а значения нужны и дескриптору, и замыканиям методов ниже.
export function createOpenRouterRuntimeAdapter(
  options: CreateOpenRouterRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "openrouter";
  const providerId = options.providerId ?? "openrouter";
  const logger = options.logger ?? createFallbackLogger();

  return {
    // Дескриптор описывает рантайм для UI и координатора: lightModel = null означает, что у
    // адаптера нет отдельной "лёгкой" модели для служебных задач вроде авто-ревью, и вызывающий
    // обязан сам решить, чем её заменить. Имена переменных окружения - тоже часть контракта:
    // по ним строится форма настроек профиля и подсказки в UI.
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "OpenRouter",
      lightModel: null,
      defaultApiKeyEnvVar: "OPENROUTER_API_KEY",
      apiKeyEnvCandidates: ["OPENROUTER_API_KEY"],
      defaultBaseUrlEnvVar: "OPENROUTER_BASE_URL",
      // Публичный SaaS: адрес — часть контракта, а не секрет настройки.
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      defaultModelEnvVar: "OPENROUTER_MODEL",
      defaultModelPlaceholder: "anthropic/claude-sonnet-4",
      supportedTransports: [RuntimeTransport.API],
      defaultTransport: RuntimeTransport.API,
      effort: {
        optionKey: "effort",
        fallbackLevels: OPENROUTER_MODEL_EFFORT_LEVELS,
      },
      capabilities: API_CAPABILITIES,
    },

    // Запуск - единственный метод, который реально обращается к провайдеру.
    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      logger.info?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          model: input.model ?? null,
          streaming: Boolean(input.stream !== false && input.execution?.onEvent),
        },
        "OpenRouter adapter run invoked",
      );

      try {
        // Стриминг включается только если вызывающий его не запретил и передал onEvent: без
        // обработчика событий поток некому отдавать, а соединение всё равно будет потоковым.
        // Сравнение с false, а не проверка на true: отсутствие флага означает "по умолчанию да".
        const useStreaming = input.stream !== false && Boolean(input.execution?.onEvent);
        if (useStreaming) {
          return await runOpenRouterApiStreaming(input, logger);
        }
        return await runOpenRouterApi(input, logger);
      } catch (error) {
        // Наружу ошибка уходит уже классифицированной: верхние слои не должны видеть сырой
        // Error от fetch или JSON.parse.
        throw classifyOpenRouterRuntimeError(error);
      }
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      // Ключ читается из опций профиля, а при их отсутствии - из переменной окружения
      // процесса: один и тот же код работает и для явно настроенного профиля, и для локальной
      // разработки, где ничего настраивать не хочется.
      const options = asRecord(input.options);
      const apiKey = readString(options.apiKey) ?? readString(process.env.OPENROUTER_API_KEY);
      // Ранний выход с ok:false вместо исключения: отсутствие ключа - ожидаемый результат
      // валидации, а не сбой, и UI должен показать это как подсказку, а не как ошибку.
      if (!apiKey) {
        return {
          ok: false,
          message: "Missing API key (expected env var: OPENROUTER_API_KEY)",
        };
      }
      // Валидация делегируется транспорту: адаптер отвечает только за поиск ключа.
      return validateOpenRouterApiConnection(input);
    },

    // Discovery моделей не критичен для работоспособности, поэтому падение запроса
    // проглатывается с предупреждением: лучше показать встроенный список, чем не дать
    // пользователю сохранить профиль.
    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      try {
        const models = await listOpenRouterApiModels(input, logger);
        // Пустой ответ тоже считается неудачей: у реального OpenRouter список моделей не бывает
        // пустым, значит запрос вернул что-то не то.
        if (models.length > 0) {
          logger.debug?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
              modelCount: models.length,
            },
            "Fetched model list from OpenRouter API",
          );
          return models;
        }
      } catch {
        logger.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
          },
          "OpenRouter model discovery failed, falling back to built-in list",
        );
      }
      // Встроенный список отдаётся и при ошибке, и при пустом ответе: точка выхода одна, а
      // выше уже было залогировано, что именно пошло не так.
      logger.debug?.(
        { runtimeId: input.runtimeId, profileId: input.profileId ?? null },
        "Returning built-in OpenRouter model list",
      );
      return DEFAULT_OPENROUTER_MODELS;
    },

    // Маппинг ошибки в текст для UI: он не управляет поведением, поэтому может позволить себе
    // строковые эвристики (см. diagnoseErrorMessage).
    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      return diagnoseErrorMessage(input);
    },
  };
}
