/**
 * Оркестратор одного запуска Codex поверх app-server-транспорта.
 *
 * В отличие от CLI-транспорта, здесь нет однократного процесса на запрос: раннер поднимает
 * долгоживущий дочерний процесс `codex app-server` и общается с ним по JSON-RPC (см.
 * JsonlRpcClient). Один запуск - это последовательность: initialize, создание/resume/fork
 * thread, startTurn, затем ожидание уведомлений до завершения хода.
 *
 * Ключевая асимметрия протокола, которая объясняет структуру файла: запросы (thread/start,
 * turn/start, turn/interrupt) - это вызовы с корреляцией id/ответ, а прогресс приходит
 * отдельным потоком уведомлений, у которых нет своего места в порядке ответов. Поэтому
 * раннер не «возвращает» результат из turn/start, а ждёт отдельный DeferredCompletion,
 * который поднимает mapper, когда придёт turn/completed или turn/failed. Ранний выход
 * процесса, ошибка протокола и истечение таймаута - это три независимых источника
 * досрочного отклонения того же промиса.
 *
 * Второй важный момент - безопасность: любой сбой хода Codex любит прятать в состоянии
 * thread, а не в самом ответе на запрос. Поэтому перед тем как отдать ошибку наружу,
 * раннер пытается обогатить её деталями (enrichAppServerFailureFromThread), но только
 * как best-effort: неудача чтения thread не должна подменять исходную ошибку.
 */

import type { RuntimeRunInput, RuntimeRunResult, RuntimeSessionForkInput } from "../../../types.js";
import { CODEX_MODEL_EFFORT_LEVELS, resolveModelEffortOption } from "../../../modelEffort.js";
import {
  isRetriableTimeoutError,
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../../timeouts.js";
import { RuntimeTransport } from "../../../types.js";
import { CodexAppServerClient } from "./client.js";
import { CodexAppServerEventMapper, type CodexAppServerEventMapperLogger } from "./eventMapper.js";
import { classifyCodexAppServerError } from "./errors.js";
import { JsonlRpcClient } from "./jsonlRpcClient.js";
import type { CodexAppServerRequestMap } from "./protocol.js";
import { spawnCodexAppServerProcess, terminateCodexAppServerProcess } from "./process.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { ReasoningEffort } from "./generated/ReasoningEffort.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js";
import type { SandboxMode } from "./generated/v2/SandboxMode.js";
import {
  normalizeCodexApprovalPolicy,
  normalizeCodexSandboxMode,
  warnOnInvalidCodexPermissionOverride,
} from "../permissions.js";

export type CodexAppServerRunLogger = CodexAppServerEventMapperLogger;

// Потолок ожидания ответа на один RPC-запрос. Он заметно меньше общего run-таймаута,
// потому что зависший одиночный запрос нельзя лечить тем же сроком, что и всю работу:
// иначе отвал раннера выглядел бы как бесконечное ожидание без диагностики.
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

type CodexAppServerJsonObject = { [key: string]: JsonValue };

// Промис, которым можно управлять снаружи: в момент создания ещё неизвестно, кто и когда
// его завершит (уведомление от сервера, exit процесса, ошибка протокола). Флаг settled и
// проверка внутри resolve/reject нужны, чтобы первое событие выигрывало, а последующие -
// включая неизбежные гонки - молча игнорировались. Без этого повторный reject уже
// отклонённого промиса провалился бы в unhandled rejection.
interface DeferredCompletion<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  isSettled: () => boolean;
}

// Fork-режим приходит расширенным полем sourceSessionId, которого нет в базовом
// RuntimeRunInput. Приведение к Partial<RuntimeSessionForkInput> - это способ заглянуть в
// необязательную часть контракта, не расширяя сам тип входа. Возвращается null, а не
// пустая строка: дальше по коду ветвление идёт по «есть источник или нет», и пустое
// значение просачиваться не должно.
function readForkSourceSessionId(input: RuntimeRunInput): string | null {
  const sourceSessionId = (input as Partial<RuntimeSessionForkInput>).sourceSessionId;
  return typeof sourceSessionId === "string" && sourceSessionId.trim().length > 0
    ? sourceSessionId.trim()
    : null;
}

// Для логов показывается только хвост идентификатора: полный thread id длинный и шумный,
// а последних 8 символов достаточно, чтобы сопоставить записи в пределах одной сессии.
function sessionIdSuffix(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

// Публичная точка входа. Отделена от runCodexAppServerAttempt именно ради повтора:
// повторяется не какой-то шаг, а вся попытка целиком, потому что после падения процесса
// app-server состояние сессии уже не восстановить - нужен новый процесс и новый thread.
// Повтор допускается ровно один и только для ошибок старта: classifyBy* даёт структурный
// признак (isRetriableTimeoutError), а не разбор текста сообщения.
// Логгер везде передаётся опциональным (logger?.info?.) - рантайм обязан работать и без
// логгера, поэтому отсутствие логирования не должно быть особым случаем.
export async function runCodexAppServer(
  input: RuntimeRunInput,
  logger?: CodexAppServerRunLogger,
): Promise<RuntimeRunResult> {
  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      profileId: input.profileId ?? null,
      transport: "app-server",
      resume: Boolean(input.resume && input.sessionId),
      fork: Boolean(readForkSourceSessionId(input)),
      model: input.model ?? null,
      startTimeoutMs: input.execution?.startTimeoutMs ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? null,
    },
    "INFO [runtime:codex] Starting Codex app-server run",
  );

  try {
    const result = await runCodexAppServerAttempt(input, logger);
    logger?.info?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: "app-server",
        sessionId: result.sessionId ?? null,
        outputLength: result.outputText?.length ?? 0,
        eventCount: result.events?.length ?? 0,
        hasUsage: Boolean(result.usage),
      },
      "INFO [runtime:codex] Codex app-server run completed",
    );
    return result;
  } catch (error) {
    // Ветвление только по структурному признаку ошибки: текст сообщения здесь
    // непригоден для принятия решения и используется исключительно для логов.
    if (isRetriableTimeoutError(error)) {
      const retryDelayMs = resolveRetryDelay(input.execution ?? {});
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: "app-server",
          retryDelayMs,
        },
        "WARN [runtime:codex] Codex app-server start timeout, retrying once after delay",
      );
      await sleepMs(retryDelayMs);
      return await runCodexAppServerAttempt(input, logger);
    }
    // Наружу отдаётся уже классифицированная ошибка: вышестоящий код должен видеть
    // категорию и adapterCode, а не сырой текст от SDK или процесса.
    throw classifyCodexAppServerError(error);
  }
}

async function runCodexAppServerAttempt(
  input: RuntimeRunInput,
  logger?: CodexAppServerRunLogger,
): Promise<RuntimeRunResult> {
  // Здесь и далее completion - единственная точка сведения асинхронных источников. Локальная
  // подписка catch гасит промис на случай, если отклонение придёт раньше, чем до await
  // дойдёт управление: неперехваченный reject уронил бы процесс Node.js.
  const completion = createDeferredCompletion<void>();
  completion.promise.catch(() => undefined);
  const launch = spawnCodexAppServerProcess({
    input: toLaunchInput(input),
    logger,
  });
  // Таймауты навешиваются на сам процесс, а не на отдельные запросы: старт меряется от
  // момента спавна, а общий срок жизни - от начала запуска. Объект возвращает и флаги
  // факта истечения, и cleanup - последний обязателен в finally.
  const timeouts = withProcessTimeouts(
    launch.process,
    {
      startTimeoutMs: input.execution?.startTimeoutMs,
      runTimeoutMs: input.execution?.runTimeoutMs,
    },
    logger,
  );

  // threadId/turnId заполняются по мере выполнения и намеренно живут как let: часть
  // обработчиков (например, отправка interrupt) может сработать до того, как сервер вернёт
  // идентификаторы, и должна просто подождать следующего вызова. Это состояние сессии,
  // а не параметры запуска.
  let threadId: string | null = null;
  let turnId: string | null = null;
  // interruptRequested - намерение пользователя, interruptInFlight - фактический запрос.
  // Их разделение защищает от повторной отправки turn/interrupt при каждом уведомлении:
  // намерение может прийти раньше, чем появится чем прерывать.
  let interruptRequested = false;
  let interruptInFlight: Promise<void> | null = null;
  // AbortSignal приходит извне, поэтому на него нельзя подписываться навсегда: подписка
  // снимается в finally, иначе отменённый запуск удерживал бы замыкание до конца процесса.
  const abortSignal = input.execution?.abortController?.signal;
  // Причина отказа хранится отдельно от промиса: reject сообщает «всё кончилось», а этот
  // слот сохраняет, чем именно, чтобы await успел поднять её после пробуждения.
  let completionFailure: Error | null = null;
  // Экспериментальные поля протокола включаются только по явному флагу: их формат может
  // измениться между версиями app-server, и по умолчанию нагрузка должна оставаться
  // переносимой.
  const experimentalApiEnabled = asRecord(input.options).experimentalApi === true;
  const forkSourceSessionId = readForkSourceSessionId(input);

  // Маппер выступает адаптером между «сырым» потоком уведомлений и событиями рантайма.
  // Оба колбэка завершения переводят его внутренние уведомления в состояние нашего дефера.
  const mapper = new CodexAppServerEventMapper({
    input,
    logger,
    onTurnCompleted: () => completion.resolve(),
    onTurnFailed: (error) => {
      completionFailure = error;
      completion.reject(error);
    },
  });

  // Два клиента решают разные задачи: JsonlRpcClient отвечает за транспорт и корреляцию
  // запрос-ответ по протоколу, а CodexAppServerClient - за типизированные вызовы методов
  // app-server. Такое расслоение позволяет менять сценарии, не трогая парсер потока.
  const rpcClient = new JsonlRpcClient(launch.process, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs: resolveRequestTimeout(input),
    logger,
    // Уведомления приходят вне связи с нашими запросами и приходят в произвольные моменты,
    // поэтому идентификаторы подтягиваются из маппера «с приоритетом уже известного
    // значения»: null из mapper не должен затирать уже полученный id.
    onNotification: (notification) => {
      mapper.handleNotification(notification.method, notification.params);
      threadId = mapper.getThreadId() ?? threadId;
      turnId = mapper.getTurnId() ?? turnId;
    },
    // Обратный поток: сервер сам спрашивает разрешение или данные. Ответ формирует маппер,
    // потому что только он знает соответствие методов и текущий контекст хода.
    onRequest: (request) => mapper.handleServerRequest(request.method, request.params),
    onProtocolError: (error) => {
      completionFailure = error;
      completion.reject(error);
    },
  });
  const client = new CodexAppServerClient(rpcClient, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs: resolveRequestTimeout(input),
    logger,
  });
  // Идемпотентная отправка прерывания. Функция вызывается из двух мест - обработчика abort
  // и сразу после startTurn, - потому что порядок этих событий не гарантирован: отмена
  // может прийти до того, как известен turnId. Готовность определяется набором условий, а
  // не попыткой что-то повторить позже по таймеру.
  const sendInterruptIfReady = (): void => {
    if (
      !interruptRequested ||
      !threadId ||
      !turnId ||
      interruptInFlight ||
      completion.isSettled()
    ) {
      return;
    }

    const interruptThreadId = threadId;
    const interruptTurnId = turnId;
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: "app-server",
        threadId: interruptThreadId,
        turnId: interruptTurnId,
      },
      "DEBUG [runtime:codex] Abort requested, sending turn/interrupt",
    );

    interruptInFlight = requestInterrupt(client, interruptThreadId, interruptTurnId, logger)
      .catch((error) => {
        logger?.error?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport: "app-server",
            threadId: interruptThreadId,
            turnId: interruptTurnId,
            error: error instanceof Error ? error.message : String(error),
          },
          "ERROR [runtime:codex] Failed to interrupt app-server turn",
        );
      })
      .finally(() => {
        interruptInFlight = null;
      });
  };
  const abortHandler = (): void => {
    interruptRequested = true;
    sendInterruptIfReady();
  };

  // Ранний выход процесса - это отказ, а не нормальное завершение: app-server задуман
  // долгоживущим, поэтому если он умер до turn/completed, ждать больше нечего. Проверка
  // isSettled нужна, чтобы штатное закрытие в finally не превратилось в ложную ошибку.
  const processExitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
    if (completion.isSettled()) {
      return;
    }
    completion.reject(
      new Error(
        `Codex app-server exited before turn completion (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      ),
    );
  };
  launch.process.once("exit", processExitHandler);

  try {
    // Рукопожатие идёт первым: до него сервер не примет ни один прикладной запрос, а
    // заявленные здесь capability определяют, можно ли пользоваться экспериментальными
    // полями протокола на протяжении всей сессии.
    await client.initialize({
      clientInfo: {
        name: "aif-runtime-codex-runner",
        title: "AIF Runtime Codex Runner",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: experimentalApiEnabled,
        requestAttestation: false,
      },
    });

    const permissionSettings = resolveCodexPermissionOverrides(input, logger);
    const composedPrompt = composePrompt(input);
    const threadMetadata = buildThreadMetadata(input, permissionSettings);
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: "app-server",
        approvalPolicy: permissionSettings.approvalPolicy,
        sandboxMode: permissionSettings.sandboxMode,
        hasReasoningEffort: Boolean(permissionSettings.modelReasoningEffort),
      },
      "DEBUG [runtime:codex] Resolved app-server approval and sandbox settings",
    );

    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: "app-server",
        experimentalApi: experimentalApiEnabled,
        sendsExperimentalHistoryFields: experimentalApiEnabled,
      },
      "DEBUG [runtime:codex] Prepared thread payload capability gates",
    );

    // Ветвление взаимоисключающее и упорядочено по специфичности: fork требует явного
    // источника, resume - сохранённого sessionId, иначе создаётся новый thread. Порядок
    // важен: при одновременном наличии признаков fork должен победить, потому что он несёт
    // больше информации о намерении вызывающего.
    if (forkSourceSessionId) {
      const sourceThreadId = parseCodexThreadId(forkSourceSessionId);
      // Приведение через as к типу параметров конкретного метода - способ получить
      // проверку совместимости с протоколом без ручного описания промежуточного типа.
      const forkParams = {
        threadId: sourceThreadId,
        model: input.model ?? null,
        cwd: input.cwd ?? input.projectRoot ?? null,
        approvalPolicy: permissionSettings.approvalPolicy,
        sandbox: permissionSettings.sandboxMode,
        config: threadMetadata,
        persistExtendedHistory: experimentalApiEnabled,
      } as CodexAppServerRequestMap["thread/fork"]["params"];
      logger?.debug?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: "app-server",
          appServerEndpoint: readString(asRecord(input.options).appServerEndpoint) ?? "process",
          sourceThreadIdSuffix: sessionIdSuffix(sourceThreadId),
        },
        "DEBUG [runtime:codex] Starting Codex app-server thread fork",
      );
      // Маппер уведомляется синтетическим событием thread/started: при fork/resume
      // сервер не обязан присылать его сам, но остальному коду нужен единый путь, по
      // которому threadId попадает во внутреннее состояние маппера.
      const forked = await client.forkThread(forkParams);
      threadId = forked.thread.id;
      mapper.handleNotification("thread/started", { threadId });
      logger?.info?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: "app-server",
          appServerEndpoint: readString(asRecord(input.options).appServerEndpoint) ?? "process",
          sourceThreadIdSuffix: sessionIdSuffix(sourceThreadId),
          forkedThreadId: threadId,
        },
        "INFO [runtime:codex] Codex app-server thread fork completed",
      );
    } else if (input.resume && input.sessionId) {
      const resumeThreadId = parseCodexThreadId(input.sessionId);
      // persistExtendedHistory при resume передаётся условным спредом: поле появилось
      // только в экспериментальном протоколе, и его присутствие в обычном режиме могло бы
      // привести к ошибке валидации на стороне сервера.
      const resumeParams = {
        threadId: resumeThreadId,
        model: input.model ?? null,
        cwd: input.cwd ?? input.projectRoot ?? null,
        approvalPolicy: permissionSettings.approvalPolicy,
        sandbox: permissionSettings.sandboxMode,
        config: threadMetadata,
        ...(experimentalApiEnabled ? { persistExtendedHistory: true } : {}),
      } as CodexAppServerRequestMap["thread/resume"]["params"];
      const resumed = await client.resumeThread(resumeParams);
      threadId = resumed.thread.id;
      mapper.handleNotification("thread/resumed", { threadId });
      logger?.info?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: "app-server",
          threadId,
        },
        "INFO [runtime:codex] Codex app-server resume completed",
      );
    } else {
      // Новый thread. experimentalRawEvents явно false: сырые события не нужны, их разбор
      // остаётся на стороне app-server, а нам достаточно нормализованных уведомлений.
      const startParams = {
        model: input.model ?? undefined,
        cwd: input.cwd ?? input.projectRoot ?? null,
        approvalPolicy: permissionSettings.approvalPolicy,
        sandbox: permissionSettings.sandboxMode,
        config: threadMetadata,
        ...(experimentalApiEnabled
          ? {
              experimentalRawEvents: false,
              persistExtendedHistory: true,
            }
          : {}),
      } as CodexAppServerRequestMap["thread/start"]["params"];
      const started = await client.startThread(startParams);
      threadId = started.thread.id;
      mapper.handleNotification("thread/started", { threadId });
      logger?.info?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: "app-server",
          threadId,
        },
        "INFO [runtime:codex] Codex app-server run started",
      );
    }

    // Страховка на случай несовпадения версий протокола: без threadId следующий шаг
    // (startTurn) не имеет смысла, и падать нужно здесь, с понятным сообщением.
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }

    // Подписка на отмену ставится после создания thread, но до startTurn. Если сигнал уже
    // был aborted, addEventListener не сработает - поэтому состояние проверяется явно.
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortHandler();
      } else {
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const turnStarted = await client.startTurn({
      threadId,
      // Один текстовый элемент с вложенным массивом text_elements: такова форма входа в
      // протоколе, даже когда дополнительных элементов нет.
      input: [
        {
          type: "text",
          text: composedPrompt,
          text_elements: [],
        },
      ],
      cwd: input.cwd ?? input.projectRoot ?? null,
      approvalPolicy: permissionSettings.approvalPolicy,
      sandboxPolicy: buildSandboxPolicy(permissionSettings.sandboxMode, input),
      model: input.model ?? null,
      effort: permissionSettings.modelReasoningEffort,
      outputSchema: (input.execution?.outputSchema as JsonValue | undefined) ?? null,
    });
    turnId = turnStarted.turn.id;
    mapper.handleNotification("turn/started", { turnId });
    // Повторная проверка после получения turnId: если abort пришёл раньше, именно здесь
    // прерывание впервые становится возможным.
    sendInterruptIfReady();

    // Главный await: ответ на turn/start означает лишь «ход принят», а не «ход выполнен».
    // Результат приходит уведомлением, поэтому ждём дефер, а не возвращённое значение RPC.
    await completion.promise;

    // Разделение «промис разрешён» и «ошибки нет» не случайно: частичный результат мог быть
    // собран до отказа, и его нельзя отдать вызывающему как успешный.
    if (completionFailure) {
      throw completionFailure;
    }

    // Таймауты проверяются уже после завершения хода и не отменяют его: сначала забирается
    // то, что успело прийти, а решение о превышении срока принимается отдельно.
    const startTimedOut = await timeouts.startTimedOut;
    if (startTimedOut) {
      throw makeProcessStartTimeoutError(input.execution?.startTimeoutMs ?? 0);
    }
    if (timeouts.runTimedOut) {
      throw makeProcessRunTimeoutError(input.execution?.runTimeoutMs ?? 0);
    }

    // Отсутствие usage - легальная ситуация (не все версии протокола его присылают), но
    // заметная: молчаливый null скрыл бы регрессию в учёте токенов.
    const usage = mapper.getUsage();
    if (!usage) {
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: "app-server",
          threadId,
          turnId,
        },
        "WARN [runtime:codex] App-server turn completed without usage payload",
      );
    }

    // Итог собирается из маппера, но с откатом на локально сохранённые id: если событие о
    // thread/turn не дошло, сессия всё равно должна быть возвращена для последующего resume.
    return {
      outputText: mapper.getOutputText(),
      sessionId: mapper.getThreadId() ?? threadId,
      events: mapper.getEvents(),
      usage,
      raw: {
        provider: "openai",
        runtime: "codex",
        transport: "app-server",
        codexThreadId: mapper.getThreadId() ?? threadId,
        codexTurnId: mapper.getTurnId() ?? turnId,
        rawUsage: mapper.getRawUsage(),
      },
    };
  } catch (error) {
    // Таймауты перепроверяются и здесь: ошибка могла быть вызвана не отказом, а истечением
    // срока, и приоритет отдаётся именно таймаутной классификации - она несёт отдельный
    // признак, по которому внешний код решает, повторять ли попытку.
    const startTimedOut = await timeouts.startTimedOut;
    if (startTimedOut) {
      throw makeProcessStartTimeoutError(input.execution?.startTimeoutMs ?? 0);
    }
    if (timeouts.runTimedOut) {
      // Отдельный warn для случая «отмену запросили, но ход не остановился»: это признак
      // того, что app-server не отреагировал на turn/interrupt и процесс приходится
      // закрывать принудительно.
      if (interruptRequested) {
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport: "app-server",
            threadId,
            turnId,
          },
          "WARN [runtime:codex] Interrupted turn did not stop before timeout; forcing close",
        );
      }
      throw makeProcessRunTimeoutError(input.execution?.runTimeoutMs ?? 0);
    }
    // Ошибка отдаётся через enrich: детали хода живут в состоянии thread, а не в ответе
    // на запрос, поэтому без этой попытки наверх ушло бы малосодержательное сообщение.
    throw await enrichAppServerFailureFromThread({
      error,
      client,
      threadId: threadId ?? readThreadIdFromError(error),
      logger,
      input,
    });
  } finally {
    // Порядок очистки обратный порядку установки: сначала снимаются подписки, потом
    // останавливается ввод-вывод, и лишь затем закрывается процесс. Иначе события от уже
    // закрываемого транспорта могли бы снова дёрнуть обработчики.
    abortSignal?.removeEventListener("abort", abortHandler);
    launch.process.off("exit", processExitHandler);
    timeouts.cleanup();
    client.close("run finished");
    await terminateCodexAppServerProcess(launch, logger);
  }
}

// Best-effort обогащение ошибки. Контракт функции: вернуть либо исходную ошибку, либо
// новую, но с подробностями из thread, и никогда не бросить исключение. Дополнительный
// чтение thread - это диагностика, а не способ исправить ситуацию.
async function enrichAppServerFailureFromThread(input: {
  error: unknown;
  client: CodexAppServerClient;
  threadId: string | null;
  logger?: CodexAppServerRunLogger;
  input: RuntimeRunInput;
}): Promise<unknown> {
  // Без threadId читать нечего: запрос thread/read требует корреляции по конкретному thread.
  if (!input.threadId) {
    return input.error;
  }

  try {
    input.logger?.debug?.(
      {
        runtimeId: input.input.runtimeId,
        profileId: input.input.profileId ?? null,
        transport: "app-server",
        threadId: input.threadId,
      },
      "DEBUG [runtime:codex] Attempting to enrich Codex app-server failure from thread state",
    );
    // includeTurns обязателен: именно в ошибке хода, а не в статусе thread, лежит причина.
    const result = await input.client.readThread({
      threadId: input.threadId,
      includeTurns: true,
    });
    const detail = extractThreadFailureDetail(result);
    // Отсутствие деталей - не ошибка, а ожидаемый исход: сервер мог не отдать turns или
    // ошибка была не на стороне хода. Логируется форма ответа, а не пустое сообщение.
    if (!detail) {
      const thread = asRecord(result.thread);
      input.logger?.warn?.(
        {
          runtimeId: input.input.runtimeId,
          profileId: input.input.profileId ?? null,
          transport: "app-server",
          threadId: input.threadId,
          threadReadShape: summarizeThreadReadShape(result),
          threadStatus: thread.status ?? null,
        },
        "WARN [runtime:codex] Codex app-server thread read did not include a failed turn error",
      );
      return input.error;
    }

    input.logger?.warn?.(
      {
        runtimeId: input.input.runtimeId,
        profileId: input.input.profileId ?? null,
        transport: "app-server",
        threadId: input.threadId,
        turnId: detail.turnId,
        codexErrorInfo: detail.codexErrorInfo ?? null,
      },
      "WARN [runtime:codex] Enriched Codex app-server failure from thread state",
    );

    // cause сохраняет исходную ошибку в цепочке: полезно и для логов, и для классификации.
    // Если исходное значение не Error, cause не выставляется - поле не должно содержать
    // произвольное значение неожиданного типа.
    const cause = input.error instanceof Error ? input.error : undefined;
    return Object.assign(new Error(detail.message), {
      cause,
      codexErrorInfo: {
        threadId: input.threadId,
        turnId: detail.turnId,
        turnStatus: detail.turnStatus,
        turnError: detail.turnError,
        codexErrorInfo: detail.codexErrorInfo,
      },
    });
  } catch (readError) {
    // Ошибка диагностики не должна подменять исходную: возвращается то, что было.
    input.logger?.warn?.(
      {
        runtimeId: input.input.runtimeId,
        profileId: input.input.profileId ?? null,
        transport: "app-server",
        threadId: input.threadId,
        err: readError,
      },
      "WARN [runtime:codex] Failed to read Codex app-server thread after run failure",
    );
    return input.error;
  }
}

// Извлечение threadId из структурированного поля ошибки. asRecord всегда даёт объект, а
// readString - string | null, поэтому цепочка безопасна для любого входного значения:
// никакого приведения типа, отбрасывающего null, здесь нет.
function readThreadIdFromError(error: unknown): string | null {
  const info = asRecord(asRecord(error).codexErrorInfo);
  return readString(info.threadId);
}

// Разбор ответа thread/read. Возвращаемое значение | null - обязательная часть контракта:
// «не нашли ошибку» это нормальный результат, а не исключение.
// Обход идёт с конца: интересен последний неудачный ход, а не первый в истории.
function extractThreadFailureDetail(payload: unknown): {
  message: string;
  turnId: string | null;
  turnStatus: string | null;
  turnError: Record<string, unknown>;
  codexErrorInfo: unknown;
} | null {
  // payload может быть как полным ответом, так и уже распакованным thread - на практике
  // встречаются оба варианта в зависимости от версии протокола.
  const thread = asRecord(asRecord(payload).thread ?? payload);
  const turns = Array.isArray(asRecord(thread)?.turns)
    ? (asRecord(thread)?.turns as unknown[])
    : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = asRecord(turns[index]);
    // Пустой объект означает «поля error нет»: asRecord не различает отсутствие и null,
    // поэтому признаком служит отсутствие ключей, а не само значение.
    const turnError = asRecord(turn?.error);
    if (Object.keys(turnError).length === 0) {
      continue;
    }
    const message = readString(turnError.message);
    // Ход может быть помечен ошибочным без текста - такой пропускается: пользователю
    // нужна причина, а не факт, который и так виден по статусу.
    if (!message) {
      continue;
    }
    const additionalDetails = readString(turnError.additionalDetails);
    return {
      message: additionalDetails ? `${message}: ${additionalDetails}` : message,
      turnId: readString(turn?.id),
      turnStatus: readString(turn?.status),
      turnError,
      codexErrorInfo: turnError.codexErrorInfo ?? null,
    };
  }
  // Плоская форма не дала результата - пробуем рекурсивный поиск по вложенным структурам.
  return findNestedFailureDetail(payload);
}

// Обход неизвестного JSON в поисках записи, похожей на ошибку хода. Это защита от того,
// что app-server может прислать ошибку в неожиданном месте (внутри items, вложенного
// ответа и т.п.), а формат между версиями не фиксирован. Реализован явный стек, а не
// рекурсия: глубина входящего JSON не ограничена, и рекурсивный обход легко уронил бы
// процесс переполнением стека на специально подготовленном ответе.
function findNestedFailureDetail(payload: unknown): {
  message: string;
  turnId: string | null;
  turnStatus: string | null;
  turnError: Record<string, unknown>;
  codexErrorInfo: unknown;
} | null {
  // seen защищает от циклов: цикличный JSON технически возможен, а обход обязан
  // завершаться на любом входе. Сравнение идёт по ссылке, поэтому повторно встреченные
  // объекты просто пропускаются.
  const seen = new Set<unknown>();
  // Стек несёт контекст вместе со значением: без него найденная ошибка не знала бы, к
  // какому ходу она относится.
  const stack: Array<{ value: unknown; turnId: string | null; turnStatus: string | null }> = [
    { value: payload, turnId: null, turnStatus: null },
  ];

  while (stack.length > 0) {
    // Non-null assertion здесь безопасен: длина проверена условием цикла, а pop() на
    // непустом массиве всегда возвращает элемент.
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object") {
      continue;
    }
    if (seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);

    // Массивы разворачиваются в обратном порядке, чтобы элементы с конца попадали в стек
    // первыми и обрабатывались раньше - так находится последняя по времени ошибка.
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          turnId: current.turnId,
          turnStatus: current.turnStatus,
        });
      }
      continue;
    }

    // Запись turn распознаётся по набору терминальных статусов: это эвристика, но она
    // нужна, чтобы привязать найденную ошибку к конкретному ходу, а не к безымянному
    // объекту в глубине ответа.
    const record = current.value as Record<string, unknown>;
    const recordStatus = readString(record.status);
    const isTurnRecord =
      recordStatus === "completed" ||
      recordStatus === "interrupted" ||
      recordStatus === "failed" ||
      recordStatus === "inProgress";
    const status = isTurnRecord ? recordStatus : current.turnStatus;
    const id = isTurnRecord ? (readString(record.id) ?? current.turnId) : current.turnId;
    const error = asRecord(record.error);
    // Два варианта представления ошибки: отдельный объект error либо сама запись, но
    // только если она несёт характерные поля ошибки. Проверка на message отсекает записи,
    // где message - обычный текст ассистента, а не сообщение о сбое.
    const explicitError =
      Object.keys(error).length > 0
        ? error
        : readString(record.message) &&
            ("codexErrorInfo" in record || "additionalDetails" in record || "code" in record)
          ? record
          : null;
    if (explicitError) {
      const message = readString(explicitError.message);
      if (message) {
        const additionalDetails = readString(explicitError.additionalDetails);
        return {
          message: additionalDetails ? `${message}: ${additionalDetails}` : message,
          turnId: id,
          turnStatus: status,
          turnError: explicitError,
          codexErrorInfo: explicitError.codexErrorInfo ?? null,
        };
      }
    }

    // Контекст хода передаётся потомкам: вложенный объект может не иметь собственного id,
    // и тогда он наследует ближайший известный.
    for (const value of Object.values(record)) {
      stack.push({ value, turnId: id, turnStatus: status });
    }
  }

  // Ничего похожего на ошибку не нашлось - это ожидаемый результат, а не сбой разбора.
  return null;
}

// Компактное описание формы ответа для лога: если разбор не нашёл деталей, нужно понять,
// что именно пришло, не вываливая в лог весь payload.
function summarizeThreadReadShape(result: unknown): Record<string, unknown> {
  const thread = asRecord(asRecord(result).thread);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const lastTurn = asRecord(turns.at(-1));
  const lastError = asRecord(lastTurn.error);
  return {
    resultKeys: Object.keys(asRecord(result)),
    threadKeys: Object.keys(thread),
    turnsCount: turns.length,
    lastTurnKeys: Object.keys(lastTurn),
    lastTurnStatus: lastTurn.status ?? null,
    lastTurnErrorKeys: Object.keys(lastError),
    lastTurnItemTypes: Array.isArray(lastTurn.items)
      ? lastTurn.items.map((item) => readString(asRecord(item).type) ?? "unknown").slice(-5)
      : [],
  };
}

// Опция конфигурации имеет приоритет над константой, но проверяется на осмысленность:
// ноль, отрицательное или нечисловое значение не должно отключать таймаут запроса
// (иначе зависший RPC ждал бы бесконечно).
function resolveRequestTimeout(input: RuntimeRunInput): number {
  const options = asRecord(input.options);
  const optionTimeout = readNumber(options.appServerRequestTimeoutMs);
  return optionTimeout && optionTimeout > 0
    ? Math.floor(optionTimeout)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

// Дополнение к системному промпту склеивается впереди пользовательского текста, а не
// передаётся отдельным полем: app-server принимает один текстовый вход на ход.
// Пустое или пробельное дополнение не должно порождать лишние переводы строк.
function composePrompt(input: RuntimeRunInput): string {
  const append = input.execution?.systemPromptAppend?.trim();
  return append ? `${append}\n\n${input.prompt}` : input.prompt;
}

function buildThreadMetadata(
  input: RuntimeRunInput,
  permissions: {
    approvalPolicy: AskForApproval;
    sandboxMode: SandboxMode;
    modelReasoningEffort: ReasoningEffort | null;
  },
): CodexAppServerJsonObject {
  // Метаданные уходят в config потока и служат контекстом для последующих запусков и
  // диагностики: здесь фиксируется, с какой политикой и в каком каталоге работал раннер.
  const metadata: CodexAppServerJsonObject = {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    workflowKind: input.workflowKind ?? null,
    projectRoot: input.projectRoot ?? null,
    cwd: input.cwd ?? null,
    approvalPolicy: permissions.approvalPolicy,
    sandboxMode: permissions.sandboxMode,
  };
  if (permissions.modelReasoningEffort) {
    metadata.modelReasoningEffort = permissions.modelReasoningEffort;
  }
  return metadata;
}

// Приведение пользовательских опций разрешений к тому, что понимает текущий протокол.
// Ошибки здесь не бросаются: некорректное значение - это повод предупредить и подставить
// безопасное значение по умолчанию, а не сорвать запуск.
function resolveCodexPermissionOverrides(
  input: RuntimeRunInput,
  logger?: CodexAppServerRunLogger,
): {
  approvalPolicy: AskForApproval;
  sandboxMode: SandboxMode;
  modelReasoningEffort: ReasoningEffort | null;
} {
  const options = asRecord(input.options);
  const rawApproval = readString(options.approvalPolicy);
  const rawSandbox = readString(options.sandboxMode);
  const explicitApproval = normalizeCodexApprovalPolicy(rawApproval);
  const explicitSandbox = normalizeCodexSandboxMode(rawSandbox);
  const bypass = input.execution?.bypassPermissions === true;

  warnOnInvalidCodexPermissionOverride({
    logger,
    runtimeId: input.runtimeId,
    transport: "app-server",
    field: "approvalPolicy",
    rawValue: rawApproval,
    normalizedValue: explicitApproval,
  });
  warnOnInvalidCodexPermissionOverride({
    logger,
    runtimeId: input.runtimeId,
    transport: "app-server",
    field: "sandboxMode",
    rawValue: rawSandbox,
    normalizedValue: explicitSandbox,
  });

  const modelReasoningEffort = resolveModelEffortOption(
    options,
    "modelReasoningEffort",
    CODEX_MODEL_EFFORT_LEVELS,
  );
  // "on-failure" исторически существовал в конфигурации, но текущий протокол app-server
  // его не принимает - он маппится в ближайший по смыслу "on-request".
  const approvalPolicy = explicitApproval === "on-failure" ? "on-request" : explicitApproval;

  if (explicitApproval === "on-failure") {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        transport: "app-server",
        requestedApprovalPolicy: explicitApproval,
        resolvedApprovalPolicy: approvalPolicy,
      },
      "WARN [runtime:codex] App-server approval policy normalized for current protocol",
    );
  }

  // Явно заданное значение всегда важнее режима bypass: bypass лишь задаёт подстановку по
  // умолчанию, когда опции не указаны. Порядок именно такой, чтобы профиль не мог
  // самопроизвольно ослабить уже выбранные ограничения.
  return {
    approvalPolicy: approvalPolicy ?? (bypass ? "never" : "on-request"),
    sandboxMode: explicitSandbox ?? (bypass ? "danger-full-access" : "workspace-write"),
    modelReasoningEffort,
  };
}

// Отдельная функция, чтобы вызов прерывания был атомарным для вызывающего: логирование
// факта отправки происходит только после успешного ответа сервера.
async function requestInterrupt(
  client: CodexAppServerClient,
  threadId: string,
  turnId: string,
  logger?: CodexAppServerRunLogger,
): Promise<void> {
  await client.interruptTurn({
    threadId,
    turnId,
  });
  logger?.debug?.(
    {
      transport: "app-server",
      threadId,
      turnId,
    },
    "DEBUG [runtime:codex] Sent turn/interrupt to Codex app-server",
  );
}

// sessionId хранится с префиксом транспорта, а протоколу нужен «голый» thread id.
// Снятие префикса идемпотентно: строка без него возвращается как есть, поэтому функция
// безопасна и для внешних идентификаторов, и для уже распакованных.
function parseCodexThreadId(sessionId: string): string {
  const prefix = "codex-app-server:";
  return sessionId.startsWith(prefix) ? sessionId.slice(prefix.length) : sessionId;
}

// Песочница задаётся полиморфным объектом с полем-дискриминантом type: у каждого режима
// свой набор полей, поэтому собрать её одной общей структурой нельзя.
// Сеть выключена во всех ограниченных режимах - это осознанный выбор по умолчанию.
function buildSandboxPolicy(sandboxMode: string, input: RuntimeRunInput): SandboxPolicy {
  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (sandboxMode === "read-only") {
    return {
      type: "readOnly",
      networkAccess: false,
    };
  }

  // workspaceWrite - самый частый режим: запись разрешена только в рабочий каталог.
  // Цепочка откатов cwd - projectRoot - process.cwd() гарантирует, что массив корней
  // никогда не окажется пустым, иначе Codex остался бы без места для записи.
  return {
    type: "workspaceWrite",
    writableRoots: [input.cwd ?? input.projectRoot ?? process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

// Сужение RuntimeRunInput до формы запуска процесса: сюда попадают только те поля,
// которые нужны для спавна и аутентификации, без промпта и прочего содержимого хода.
function toLaunchInput(input: RuntimeRunInput): {
  runtimeId: string;
  profileId: string | null;
  transport: RuntimeTransport;
  options: Record<string, unknown>;
  projectRoot?: string;
  cwd?: string;
  apiKey?: string | null;
  apiKeyEnvVar?: string | null;
  baseUrl?: string | null;
} {
  const options = asRecord(input.options);
  return {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    options,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    apiKey: readString(options.apiKey),
    apiKeyEnvVar: readString(options.apiKeyEnvVar),
    baseUrl: readString(options.baseUrl),
  };
}

// Нормализатор недоверенного JSON. Всегда возвращает объект, чтобы обращение к полям не
// падало на null/undefined/массиве - разбор ответов app-server идёт по непроверенным
// данным, и «поля нет» должно быть обычной ситуацией. Массив не считается записью:
// у него нет именованных полей, и смешивать их семантику нельзя.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Возвращаемый string | null явен и не сужается приведением: пустая и пробельная строка
// трактуются как отсутствие значения, потому что для вызывающего кода «пришла пустота» и
// «поля нет» означают одно и то же.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Number.isFinite отсекает NaN и Infinity: такое значение прошло бы проверку typeof, но
// сломало бы любой расчёт таймаута или бюджета.
function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Реализация отложенного промиса. Внешние resolve/reject - тонкие обёртки над
// сохранёнными колбэками: сами колбэки недоступны снаружи, поэтому завершить промис можно
// только через возвращённый объект, и повторное завершение гарантированно отсекается.
function createDeferredCompletion<T>(): DeferredCompletion<T> {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((error: Error) => void) | null = null;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectFn = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });

  // Опциональный вызов resolveFn?.: колбэк назначается синхронно в конструкторе Promise,
  // но типовой поток это не видит, а падение на undefined здесь было бы лишним риском.
  return {
    promise,
    resolve(value: T) {
      resolveFn?.(value);
    },
    reject(error: Error) {
      rejectFn?.(error);
    },
    isSettled() {
      return settled;
    },
  };
}
