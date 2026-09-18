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

// Человекочитаемая диагностика по ошибке: сначала по структурной категории, и только затем -
// по тексту. Строковый fallback существует для чужих и неклассифицированных ошибок
// (например, обычный Error из сети) и никогда не влияет на управляющую логику.
function diagnoseErrorMessage(input: RuntimeDiagnoseErrorInput): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);

  // Основной путь: развилка по структурной category, когда она доступна
  // Категория unknown означает, что классификатор не смог ничего определить: switch всё равно
  // нечего было бы показать, поэтому сразу переходим к текстовому разбору ниже.
  if (input.error instanceof RuntimeExecutionError && input.error.category !== "unknown") {
    // Формулировки объясняют, что делать пользователю: диагностика - это подсказка по починке,
    // а не пересказ кода ошибки.
    switch (input.error.category) {
      case "auth":
        return "OpenRouter API key is missing or invalid. Check OPENROUTER_API_KEY environment variable.";
      case "rate_limit":
        return "OpenRouter rate limit or quota exceeded. Wait and retry, or check your plan limits at openrouter.ai.";
      case "model_not_found":
        return "The requested model is not available on OpenRouter. Check the model ID format (provider/model).";
      case "context_length":
        return "The prompt exceeds the model's maximum context length. Reduce the input or choose a model with a larger context window.";
      case "content_filter":
        return "OpenRouter blocked the request due to content policy. Review the prompt content.";
      case "transport":
        return "Cannot reach OpenRouter API. Check network connectivity and OPENROUTER_BASE_URL.";
      case "timeout":
        return `OpenRouter request timed out. ${message}`;
      case "permission":
        return `OpenRouter permission denied. ${message}`;
      case "stream":
        return `OpenRouter stream interrupted. ${message}`;
    }
  }

  // Резерв: сопоставление строк для неклассифицированных ошибок или plain Error
  // stderrTail добавляется к сообщению: полезная часть причины иногда остаётся только в выводе
  // процесса. Регистр приводится к нижнему, потому что провайдеры нестабильны в написании.
  const combined = `${message} ${input.stderrTail ?? ""}`.toLowerCase();

  if (
    combined.includes("unauthorized") ||
    combined.includes("invalid api key") ||
    combined.includes("401")
  ) {
    return "OpenRouter API key is missing or invalid. Check OPENROUTER_API_KEY environment variable.";
  }
  if (combined.includes("rate limit") || combined.includes("429") || combined.includes("quota")) {
    return "OpenRouter rate limit or quota exceeded. Wait and retry, or check your plan limits at openrouter.ai.";
  }
  if (combined.includes("model not found") || combined.includes("no endpoints found")) {
    return "The requested model is not available on OpenRouter. Check the model ID format (provider/model).";
  }
  if (combined.includes("context_length_exceeded")) {
    return "The prompt exceeds the model's maximum context length. Reduce the input or choose a model with a larger context window.";
  }
  if (combined.includes("connection refused") || combined.includes("fetch failed")) {
    return "Cannot reach OpenRouter API. Check network connectivity and OPENROUTER_BASE_URL.";
  }

  return `OpenRouter error: ${message}`;
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
      defaultBaseUrlEnvVar: "OPENROUTER_BASE_URL",
      defaultModelPlaceholder: "anthropic/claude-sonnet-4",
      supportedTransports: [RuntimeTransport.API],
      defaultTransport: RuntimeTransport.API,
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
