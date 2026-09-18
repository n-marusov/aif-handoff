/**
 * Маппер потока уведомлений app-server в нормализованные RuntimeEvent.
 *
 * Транспорт отдаёт уведомления двумя разными способами: либо явным JSON-RPC-методом, либо
 * обёрткой event с полем type внутри params. Здесь эти два вида приводятся к одной строке
 * (normalizeNotificationMethod), поэтому дальше switch сравнивает только канонические
 * имена - и сразу с вариантами через слэш и точку, чтобы не зависеть от версии протокола.
 *
 * Маппер - это по сути маленькая машина состояний над потоком: он накапливает текст
 * ответа, usage, идентификаторы thread/turn и ровно один раз фиксирует исход хода
 * (completed или failedError). Раннер ждёт именно этого перехода, а не ответа на
 * turn/start, поэтому любой новый case обязан рано или поздно вызвать handleTurnCompleted
 * или failTurn, иначе запуск зависнет.
 *
 * Ещё две инварианта, ради которых вынесены отдельные ветки:
 * - приватные рассуждения модели (reasoning text delta) намеренно не попадают в outputText:
 *   это не пользовательский ответ, и его утечка исказила бы результат;
 * - события показываются наружу дважды - через массив runtimeEvents для истории и через
 *   колбэк onEvent для подписчиков в реальном времени; это один и тот же объект, разница
 *   только в способе доставки.
 *
 * Данные приходят из внешнего процесса и не проверены: каждый параметр прогоняется через
 * asRecord/readString/readNumber, которые явно возвращают | null, и ни одно обращение к
 * полям не выполняется без предварительной проверки.
 */

import type { RuntimeEvent, RuntimeRunInput, RuntimeUsage } from "../../../types.js";
import { classifyCodexAppServerError } from "./errors.js";

export interface CodexAppServerEventMapperLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

export interface CodexAppServerEventMapperOptions {
  input: RuntimeRunInput;
  logger?: CodexAppServerEventMapperLogger;
  onTurnCompleted?: () => void;
  onTurnFailed?: (error: Error) => void;
}

// Поля, которые вырезаются из нагрузок перед показом и логированием. Модель может вложить
// внутренние рассуждения в контекст запроса на подтверждение, а это не то, что должен
// видеть пользователь или хранить журнал.
const REDACTED_APPROVAL_FIELDS = new Set([
  "reasoning",
  "analysis",
  "thought",
  "thoughts",
  "chain_of_thought",
  "privateReasoning",
  "internalReasoning",
]);

// Нормализованное представление системной ошибки: message готов к показу, payload
// сохраняет структурированные поля (category/adapterCode/code), по которым потом ветвится
// вызывающий код, а serverName/status служат для диагностики MCP-подсистемы.
interface CodexAppServerSystemError {
  message: string;
  payload: Record<string, unknown>;
  serverName: string | null;
  status: string | null;
}

export class CodexAppServerEventMapper {
  private readonly input: RuntimeRunInput;
  private readonly logger?: CodexAppServerEventMapperLogger;
  private readonly onTurnCompleted?: () => void;
  private readonly onTurnFailed?: (error: Error) => void;
  private readonly runtimeEvents: RuntimeEvent[] = [];
  // Идентификаторы элементов, по которым уже пришли дельты. Нужен, чтобы не продублировать
  // текст: некоторые версии присылают и поток дельт, и финальный item/completed с тем же
  // текстом - повторное добавление удвоило бы ответ в outputText.
  private readonly deltaItemIds = new Set<string>();
  private outputText = "";
  // usage и rawUsage разделены намеренно: первый - нормализованный RuntimeUsage для
  // расчётов, второй - исходный payload для аудита и для случаев, когда нормализация
  // не смогла вытащить ни одного поля.
  private usage: RuntimeUsage | null = null;
  private rawUsage: unknown = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  // completed и failedError - два признака исхода. Оба могут быть сброшены в null/false,
  // поэтому проверки всегда идут парой там, где нужно отсечь повторное завершение.
  private completed = false;
  private failedError: Error | null = null;
  // Последняя системная ошибка хранится отдельно: thread/status/changed может прийти
  // раньше, чем уведомление с самим текстом ошибки, и тогда берётся этот запасной вариант.
  private latestSystemError: CodexAppServerSystemError | null = null;

  constructor(options: CodexAppServerEventMapperOptions) {
    this.input = options.input;
    this.logger = options.logger;
    this.onTurnCompleted = options.onTurnCompleted;
    this.onTurnFailed = options.onTurnFailed;
  }

  // Единственная точка входа для потока уведомлений. Метод не бросает исключений: ошибки
  // хода превращаются в failTurn, а неизвестные методы просто логируются - раннер не
  // должен падать из-за того, что сервер прислал что-то новое.
  handleNotification(method: string, params: unknown): void {
    // Метод нормализуется до switch: только после этого сравнение имён вообще имеет смысл.
    const normalizedMethod = normalizeNotificationMethod(method, params);
    // Метка времени снимается один раз на уведомление, чтобы все события и логи,
    // порождённые им, имели согласованное время.
    const nowIso = new Date().toISOString();
    const payload = asRecord(params);

    switch (normalizedMethod) {
      case "thread/started":
      case "thread.started":
      case "thread/resumed": {
        // threadId может отсутствовать - тогда событие не эмитится, а состояние остаётся
        // прежним: пустой идентификатор хуже отсутствующего, потому что сломал бы resume.
        const threadId = extractThreadId(payload);
        if (threadId) {
          this.threadId = threadId;
          this.emit({
            type: "system:init",
            timestamp: nowIso,
            level: "debug",
            message:
              normalizedMethod === "thread/resumed"
                ? "Codex thread resumed"
                : "Codex thread started",
            data: {
              sessionId: threadId,
              threadId,
            },
          });
        }
        return;
      }

      case "turn/started":
      case "turn.started": {
        // В отличие от thread, событие о начале хода эмитится всегда: сам факт старта
        // полезен и без id, поэтому data собирается условно.
        const turnId = extractTurnId(payload);
        if (turnId) {
          this.turnId = turnId;
        }
        this.emit({
          type: "turn:started",
          timestamp: nowIso,
          level: "debug",
          message: "Codex turn started",
          data: turnId ? { turnId } : undefined,
        });
        return;
      }

      case "item/agentMessage/delta": {
        // readDeltaString, а не readString: для дельты значима и строка из пробелов
        // (переносы, отступы в разметке), поэтому trim здесь не применяется, важна лишь
        // непустота строки.
        const delta = readDeltaString(payload?.delta);
        if (delta == null) {
          return;
        }
        const itemId = readString(payload?.itemId);
        // Запоминается факт получения дельты по элементу: по этому множеству ниже
        // решается, добавлять ли финальный текст item/completed.
        if (itemId) {
          this.deltaItemIds.add(itemId);
        }
        this.outputText += delta;
        this.emit({
          type: "stream:text",
          timestamp: nowIso,
          level: "debug",
          message: delta,
          data: { text: delta },
        });
        return;
      }

      case "item/started": {
        // Элемент может лежать и в payload.item, и на верхнем уровне; откат на payload
        // покрывает вторую форму без отдельной ветки.
        const item = asRecord(payload?.item) ?? payload;
        const itemType = readString(item?.type) ?? "item";
        this.emit({
          type: "tool:started",
          timestamp: nowIso,
          level: "debug",
          message: `Codex item started: ${itemType}`,
          data: {
            itemType,
            itemId: readString(item?.id) ?? readString(payload?.itemId) ?? null,
          },
        });
        return;
      }

      case "item/completed":
      case "item.completed": {
        const item = asRecord(payload?.item);
        const itemType = readString(item?.type);
        // Без типа элемент не классифицировать - пропускаем молча, без события.
        if (!itemType) {
          return;
        }

        // Текстовый ответ ассистента обрабатывается здесь только если по этому элементу не
        // было потока дельт: иначе текст уже накоплен, и добавление финальной версии
        // породило бы дубль. Разделитель \n\n ставится между разными сообщениями.
        if (itemType === "agentMessage" || itemType === "agent_message") {
          const itemId = readString(item?.id);
          const text = readString(item?.text) ?? readString(payload?.text);
          if (text && (!itemId || !this.deltaItemIds.has(itemId))) {
            if (this.outputText) {
              this.outputText += "\n\n";
            }
            this.outputText += text;
            this.emit({
              type: "stream:text",
              timestamp: nowIso,
              level: "debug",
              message: text,
              data: { text },
            });
          }
          return;
        }

        // Рассуждения модели не попадают в outputText: в результат идёт только финальный
        // ответ, а сама запись события нужна лишь для отображения прогресса.
        if (itemType === "reasoning") {
          this.emit({
            type: "reasoning:summary",
            timestamp: nowIso,
            level: "debug",
            message: "Codex reasoning item completed",
          });
          return;
        }

        // Инструментальные вызовы проходят через общий суммаризатор. Отсутствие результата
        // означает, что тип не из числа известных - тогда эмитится нейтральное завершение.
        const toolSummary = summarizeToolUse(itemType, item);
        if (!toolSummary) {
          this.emit({
            type: "tool:completed",
            timestamp: nowIso,
            level: "debug",
            message: `Codex item completed: ${itemType}`,
            data: {
              itemType,
              itemId: readString(item?.id) ?? readString(payload?.itemId) ?? null,
            },
          });
          return;
        }
        // Колбэк onToolUse вызывается до emit: потребитель узнаёт об инструменте даже
        // если подписка на события не установлена.
        this.input.execution?.onToolUse?.(toolSummary.name, toolSummary.detail);
        this.emit({
          type: "tool:summary",
          timestamp: nowIso,
          level: "info",
          message: toolSummary.detail
            ? `${toolSummary.name}: ${toolSummary.detail}`
            : toolSummary.name,
          data: {
            toolName: toolSummary.name,
            itemType,
          },
        });
        return;
      }

      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded": {
        this.emit({
          type: "reasoning:summary",
          timestamp: nowIso,
          level: "debug",
          message: "Codex reasoning summary updated",
        });
        return;
      }

      case "item/reasoning/textDelta": {
        // Сам текст рассуждений намеренно не сохраняется и не эмитится - только отметка в
        // логе, что поток был. Это защита от утечки внутренних размышлений в интерфейс.
        this.logger?.debug?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
          },
          "DEBUG [runtime:codex] Suppressed private reasoning text delta from app-server",
        );
        return;
      }

      case "command/exec/outputDelta":
      case "item/commandExecution/outputDelta":
      case "item/commandExecution/terminalInteraction":
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress":
      case "item/plan/delta":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        // Высокочастотные служебные уведомления с шумным содержимым - намеренно глушатся:
        // они не несут информации для пользователя, а их объём мог бы вытеснить полезные
        // события из истории и журнала.
        return;
      }

      case "thread/tokenUsage/updated": {
        // Сначала сохраняется сырой payload, потом нормализованный: если нормализатор не
        // сможет разобрать формат, наружу всё равно уйдёт исходник для разбора.
        this.rawUsage = payload?.tokenUsage ?? payload;
        this.usage = normalizeUsageFromTokenUsage(payload);
        // Обновление без распознанных цифр - не повод эмитить событие: иначе счётчики
        // мигали бы на каждом пустом уведомлении.
        if (this.usage) {
          this.logger?.debug?.(
            {
              runtimeId: this.input.runtimeId,
              profileId: this.input.profileId ?? null,
              transport: this.input.transport ?? "app-server",
              usage: this.usage,
            },
            "DEBUG [runtime:codex] App-server usage payload received",
          );
        }
        return;
      }

      case "account/rateLimits/updated": {
        // Лимиты касаются аккаунта, а не конкретного запуска: информация только
        // фиксируется в логе и не превращается в событие рантайма.
        this.logger?.debug?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
            keys: Object.keys(payload ?? {}),
          },
          "DEBUG [runtime:codex] App-server account rate limits notification received",
        );
        return;
      }

      case "mcpServer/startupStatus/updated": {
        // Не всякое обновление статуса - ошибка: успешный старт просто логируется.
        const startupError = extractMcpStartupError(payload);
        if (!startupError) {
          this.logger?.debug?.(
            {
              runtimeId: this.input.runtimeId,
              profileId: this.input.profileId ?? null,
              transport: this.input.transport ?? "app-server",
              serverName: readString(payload?.name) ?? null,
              status: readString(payload?.status) ?? null,
            },
            "DEBUG [runtime:codex] App-server MCP server startup status updated",
          );
          return;
        }

        // Ошибка запоминается в latestSystemError: она может быть единственным объяснением
        // последующего перехода thread в состояние systemError.
        this.latestSystemError = startupError;
        this.emit({
          type: "warning",
          timestamp: nowIso,
          level: "warn",
          message: startupError.message,
          data: sanitizeApprovalPayload(payload) ?? undefined,
        });
        this.logger?.warn?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
            serverName: startupError.serverName,
            status: startupError.status,
            errorKeys: Object.keys(asRecord(payload?.error) ?? {}),
          },
          "WARN [runtime:codex] Codex app-server MCP server startup failed",
        );
        return;
      }

      case "thread/status/changed": {
        // Идентификатор обновляется, если пришёл: статус может относиться и к другому
        // (например, ранее созданному) thread, и тогда текущий сохраняется.
        const threadId = extractThreadId(payload);
        if (threadId) {
          this.threadId = threadId;
        }
        // Обращение к вложенному полю без проверки на null невозможно: asRecord уже вернул
        // объект или null, а readString безопасен для null-входа.
        const threadStatus = asRecord(payload?.status);
        const threadStatusType = readString(threadStatus?.type);
        this.logger?.debug?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
            threadId,
            status: payload?.status ?? null,
          },
          "DEBUG [runtime:codex] App-server thread status changed",
        );
        // Проверка пары флагов обязательна: событие может прийти после нормального
        // завершения хода, и тогда оно уже не должно переводить запуск в ошибку.
        if (threadStatusType === "systemError" && !this.completed && !this.failedError) {
          const systemError =
            this.latestSystemError ??
            createThreadSystemError(payload, "Codex app-server system error");
          this.failTurn(
            toErrorWithStructuredPayload(systemError.message, systemError.payload),
            nowIso,
          );
        }
        return;
      }

      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "applyPatchApproval":
      case "execCommandApproval":
      case "turn.approval_requested":
      case "approval.requested": {
        // Запросы подтверждения от сервера приходят как уведомления, но требуют ответа;
        // общий эмиттер только фиксирует факт, ответ отправляется из handleServerRequest.
        this.emitApprovalRequest(payload, nowIso);
        return;
      }

      // Простое уведомление о предупреждении: текст берётся как есть, если есть, иначе
      // подставляется нейтральная формулировка, чтобы сообщение не было пустым.
      // Сантизация применяется и здесь: предупреждение может включать фрагменты контекста.
      case "warning":
      case "configWarning": {
        this.emit({
          type: "warning",
          timestamp: nowIso,
          level: "warn",
          message: readString(payload?.message) ?? "Codex app-server warning",
          data: sanitizeApprovalPayload(payload) ?? undefined,
        });
        return;
      }

      case "turn/completed":
      case "turn.completed": {
        this.handleTurnCompleted(payload, nowIso);
        return;
      }

      case "turn.failed":
      case "error": {
        // Откат на latestSystemError нужен потому, что сам payload ошибки не всегда несёт
        // текст: при системном сбое содержательное сообщение пришло раньше, отдельно.
        const systemError = this.latestSystemError;
        const message = readString(payload?.message) ?? systemError?.message ?? "Codex turn failed";
        this.failTurn(
          toErrorWithStructuredPayload(message, payload ?? systemError?.payload ?? null),
          nowIso,
        );
        return;
      }

      default: {
        // Неизвестный метод не завершает запуск: новые версии app-server могут слать
        // дополнительные уведомления, и это не должно ломать совместимость вперёд.
        this.logger?.warn?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
            method: normalizedMethod,
            keys: Object.keys(payload ?? {}),
          },
          "WARN [runtime:codex] Unknown non-fatal app-server notification received",
        );
      }
    }
  }

  handleServerRequest(method: string, params: unknown): unknown {
    // Любой запрос сначала превращается в событие: даже автоматически отклонённый запрос
    // должен быть виден в истории.
    const payload = asRecord(params);
    this.emitApprovalRequest(payload, new Date().toISOString());

    // Все ветки отвечают отказом. Это осознанная позиция: у раннера нет моста к человеку,
    // поэтому вместо молчаливого разрешения опасного действия серверу отдаётся явный
    // запрет - Codex продолжит работу, но без запрошенного действия.
    // У каждого метода своя форма ответа, поэтому их нельзя свести к одной строке.
    switch (method) {
      case "item/commandExecution/requestApproval":
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "applyPatchApproval":
        return { decision: "denied" };
      case "execCommandApproval":
        return { decision: "denied" };
      default:
        // А вот неизвестный запрос - это ошибка, а не повод молча промолчать: без ответа
        // сервер будет ждать вечно, поэтому корреляция обрывается явным исключением.
        throw new Error(`Unsupported Codex app-server request: ${method}`);
    }
  }

  // Копия массива, а не ссылка: наружу нельзя отдавать внутреннее хранилище, иначе
  // вызывающий код смог бы дописать событие или очистить историю.
  getEvents(): RuntimeEvent[] {
    return [...this.runtimeEvents];
  }

  getOutputText(): string {
    return this.outputText;
  }

  getUsage(): RuntimeUsage | null {
    return this.usage;
  }

  getRawUsage(): unknown {
    return this.rawUsage;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getTurnId(): string | null {
    return this.turnId;
  }

  isCompleted(): boolean {
    return this.completed;
  }

  getFailure(): Error | null {
    return this.failedError;
  }

  private handleTurnCompleted(payload: Record<string, unknown> | null, nowIso: string): void {
    // Usage может прийти и здесь, если отдельное уведомление thread/tokenUsage/updated
    // отсутствовало: сначала проверяется флаг, чтобы не перезаписать уже собранные данные.
    if (!this.usage) {
      this.rawUsage = payload?.usage ?? this.rawUsage;
      this.usage = normalizeUsageFromTokenUsage(payload);
    }

    const turn = asRecord(payload?.turn);
    const status = readString(turn?.status);
    const turnId = extractTurnId(payload);
    if (turnId) {
      this.turnId = turnId;
    }

    // "failed" - отдельная ветка, потому что упавший ход приходит тем же уведомлением
    // turn/completed, что и успешный: различие только в поле status.
    if (status === "failed") {
      const turnError = asRecord(turn?.error);
      const systemError = this.latestSystemError;
      const message = readString(turnError?.message) ?? systemError?.message ?? "Codex turn failed";
      this.failTurn(
        toErrorWithStructuredPayload(message, turnError ?? systemError?.payload ?? payload),
        nowIso,
      );
      return;
    }

    // Всё, что не failed, считается завершением: включая interrupted - отменённый ход
    // это не ошибка, поэтому он уходит событием result:cancelled с уровнем warn.
    this.completed = true;
    this.emit({
      type: status === "interrupted" ? "result:cancelled" : "result:success",
      timestamp: nowIso,
      level: status === "interrupted" ? "warn" : "info",
      message: status === "interrupted" ? "Codex turn interrupted" : "Codex turn completed",
      data: this.usage ? { usage: this.usage, rawUsage: this.rawUsage } : undefined,
    });
    this.onTurnCompleted?.();
  }

  private failTurn(error: Error, nowIso: string): void {
    // Ошибка обязательно проходит классификацию: наружу и в событие должны уйти category
    // и adapterCode - вышестоящий код ветвится по ним, а не по тексту сообщения.
    const failure = classifyCodexAppServerError(error);
    this.failedError = failure;
    this.emit({
      type: "result:error",
      timestamp: nowIso,
      level: "error",
      message: failure.message,
      data: {
        category: failure.category,
        adapterCode: failure.adapterCode,
      },
    });
    this.onTurnFailed?.(failure);
  }

  private emitApprovalRequest(payload: Record<string, unknown> | null, nowIso: string): void {
    // Сантизация обязательна перед показом: текст запроса может содержать фрагменты
    // контекста, включая внутренние рассуждения модели.
    const sanitized = sanitizeApprovalPayload(payload);
    this.emit({
      type: "approval:request",
      timestamp: nowIso,
      level: "info",
      message: "Codex app-server requested approval",
      data: sanitized ?? {},
    });
    // Уровень warn, а не info: сам факт запроса подтверждения означает, что действие
    // отклонено, и это стоит заметить в журнале.
    this.logger?.warn?.(
      {
        runtimeId: this.input.runtimeId,
        profileId: this.input.profileId ?? null,
        transport: this.input.transport ?? "app-server",
        requestKeys: Object.keys(payload ?? {}),
      },
      "WARN [runtime:codex] Denying app-server approval request because no human approval bridge is configured",
    );
  }

  private emit(event: RuntimeEvent): void {
    // Двойная доставка: массив для последующего getEvents и колбэк для живых подписчиков.
    // Порядок важен - событие сначала попадает в историю, поэтому подписчик, который
    // сразу же запросит getEvents, увидит его на месте.
    this.runtimeEvents.push(event);
    this.input.execution?.onEvent?.(event);
  }
}

// Приведение к каноническому имени метода. Обёртка event с полем type - транспортная
// деталь некоторых версий протокола; разворачивается только она, остальные имена
// возвращаются без изменений, чтобы не искажать неизвестные методы.
function normalizeNotificationMethod(method: string, params: unknown): string {
  const trimmedMethod = method.trim();
  if (trimmedMethod !== "event") {
    return trimmedMethod;
  }
  const payload = asRecord(params);
  return readString(payload?.type) ?? trimmedMethod;
}

function normalizeUsageFromTokenUsage(
  payload: Record<string, unknown> | null,
): RuntimeUsage | null {
  // Цепочка откатов отражает разные формы payload: вложенный tokenUsage с полями last/total
  // либо сами счётчики на верхнем уровне. asRecord возвращает | null, поэтому промежуточные
  // результаты могут быть null - и это нормально, финальная проверка ниже отсекает пустоту.
  const tokenUsage = asRecord(payload?.tokenUsage);
  const usageRecord =
    asRecord(tokenUsage?.last) ?? asRecord(tokenUsage?.total) ?? tokenUsage ?? payload;
  // Явная проверка на null перед обращением к полям - вместо приведения типа, которое
  // молча скрыло бы возможность null и привело к падению на реальных данных.
  if (!usageRecord) {
    return null;
  }

  // Оба стиля именования (camelCase и snake_case) поддержаны одновременно: формат
  // менялся между версиями протокола, и различать их по версии здесь негде.
  const inputTokens =
    readNumber(usageRecord.inputTokens) ?? readNumber(usageRecord.input_tokens) ?? 0;
  const outputTokens =
    readNumber(usageRecord.outputTokens) ?? readNumber(usageRecord.output_tokens) ?? 0;
  // total вычисляется как сумма только если сервер его не прислал: собственная арифметика
  // менее надёжна, чем готовое значение.
  const totalTokens =
    readNumber(usageRecord.totalTokens) ??
    readNumber(usageRecord.total_tokens) ??
    inputTokens + outputTokens;
  const costUsd = readNumber(usageRecord.costUsd) ?? readNumber(usageRecord.cost_usd) ?? undefined;

  // Пустой отчёт приравнивается к отсутствию usage: нулевые счётчики без стоимости не несут
  // информации, а вызывающий код уже умеет обрабатывать null.
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0 && costUsd == null) {
    return null;
  }

  // costUsd добавляется условным спредом: undefined в поле сломало бы проверки на наличие
  // стоимости у потребителя.
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(costUsd != null ? { costUsd } : {}),
  };
}

function summarizeToolUse(
  itemType: string,
  item: Record<string, unknown> | null,
): { name: string; detail: string } | null {
  // null на входе - штатный случай: элемент мог не прийти, и вызывающий это уже умеет.
  if (!item) {
    return null;
  }
  // Имена инструментов приводятся к человекочитаемым независимо от варианта написания
  // типа в протоколе (camelCase или snake_case).
  switch (itemType) {
    case "commandExecution":
    case "command_execution":
      return {
        name: "Bash",
        detail: shortenString(readString(item.command) ?? ""),
      };
    case "fileChange":
    case "file_change":
      return {
        name: "FileChange",
        detail: shortenString(safeJson(item)),
      };
    case "mcpToolCall":
    case "mcp_tool_call":
      // Имя MCP-инструмента составное: важно и какой сервер, и какой инструмент в нём.
      // safeJson на arguments, потому что это произвольный JSON без фиксированной формы.
      return {
        name: `MCP:${readString(item.server) ?? "unknown"}/${readString(item.tool) ?? "unknown"}`,
        detail: shortenString(safeJson(item.arguments)),
      };
    case "webSearch":
    case "web_search":
      return {
        name: "WebSearch",
        detail: shortenString(readString(item.query) ?? ""),
      };
    default:
      // Неизвестный тип инструмента не превращается в событие с выдуманным именем -
      // вызывающий сам решит, что делать с неизвестным ему элементом.
      return null;
  }
}

function sanitizeApprovalPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  // null пробрасывается как null, а не как пустой объект: вызывающий код различает
  // «данных не было» и «данные были, но от них ничего не осталось».
  if (!payload) {
    return null;
  }
  // Приведение здесь безопасно: вход гарантированно объект (проверка выше), а
  // рекурсивный обход для объектов всегда возвращает объект.
  return sanitizeStructuredValue(payload) as Record<string, unknown>;
}

// Рекурсивная чистка произвольного JSON. Обходятся и массивы, и объекты: вложенная
// структура запроса на подтверждение может содержать секретное поле на любой глубине.
function sanitizeStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredValue(entry));
  }
  // Примитивы возвращаются как есть: чистить в них нечего.
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    // Запрещённые поля вырезаются целиком вместе с поддеревом, а не заменяются заглушкой.
    if (REDACTED_APPROVAL_FIELDS.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeStructuredValue(entry);
  }
  return sanitized;
}

function toErrorWithStructuredPayload(
  message: string,
  payload: Record<string, unknown> | null,
): Error & { codexErrorInfo?: Record<string, unknown> } {
  // Структурированный контекст вешается на сам объект ошибки: классификатор ошибок читает
  // именно поле codexErrorInfo, а не текст сообщения.
  const error = new Error(message) as Error & { codexErrorInfo?: Record<string, unknown> };
  // Если структурированных данных нет, поле не создаётся - наличие поля с null отличалось
  // бы от его отсутствия для последующего разбора.
  if (payload) {
    error.codexErrorInfo = payload;
  }
  return error;
}

function extractMcpStartupError(
  payload: Record<string, unknown> | null,
): CodexAppServerSystemError | null {
  // null (данных нет) и отсутствие текста ошибки - принципиально разные случаи; первый
  // возвращается сразу, второй выясняется ниже.
  if (!payload) {
    return null;
  }

  // Поле error может быть как строкой, так и объектом - поддержаны оба варианта.
  const error = payload.error;
  const errorRecord = asRecord(error);
  // Перебор возможных мест с текстом: формат ошибки MCP не зафиксирован и менялся.
  // Ни один readString не может бросить исключение - обход безопасен на любом входе.
  const rawMessage =
    readString(error) ??
    readString(errorRecord?.message) ??
    readString(errorRecord?.error) ??
    readString(errorRecord?.details) ??
    readString(errorRecord?.reason);
  // Обновление статуса без текста ошибки означает, что сервер запустился или просто
  // сообщил состояние - это не наша ветка.
  if (!rawMessage) {
    return null;
  }

  const serverName = readString(payload.name);
  const status = readString(payload.status);
  const message = serverName
    ? `MCP server "${serverName}" failed to start: ${rawMessage}`
    : `MCP server failed to start: ${rawMessage}`;
  // Категория и код берутся из структурированных полей, если сервер их прислал, и только
  // при их отсутствии подставляются значения по умолчанию - тоже структурированные, а не
  // выведенные из текста сообщения.
  const category = readString(errorRecord?.category) ?? "transport";
  const adapterCode = readString(errorRecord?.adapterCode) ?? "CODEX_TRANSPORT_ERROR";

  return {
    message,
    payload: {
      ...payload,
      category,
      adapterCode,
      code: readString(errorRecord?.code) ?? "TRANSPORT_ERROR",
    },
    serverName: serverName ?? null,
    status: status ?? null,
  };
}

function createThreadSystemError(
  payload: Record<string, unknown> | null,
  message: string,
): CodexAppServerSystemError {
  // Нагрузка обязательно несёт структурированные поля: даже когда сервер прислал только
  // человекочитаемое состояние, ошибка должна быть ветвимой для вызывающего кода.
  return {
    message,
    payload: {
      ...(payload ?? {}),
      category: "transport",
      adapterCode: "CODEX_TRANSPORT_ERROR",
      code: "TRANSPORT_ERROR",
    },
    serverName: null,
    status: readString(asRecord(payload?.status)?.type),
  };
}

// Идентификатор ищется в трёх местах: на верхнем уровне в двух вариантах написания и во
// вложенном объекте thread. Цепочка ?? возвращает null, если ничего не найдено - тип
// string | null объявлен явно, без приведения, отбрасывающего null.
function extractThreadId(payload: Record<string, unknown> | null): string | null {
  return (
    readString(payload?.threadId) ??
    readString(payload?.thread_id) ??
    readString(asRecord(payload?.thread)?.id) ??
    null
  );
}

// Симметрично extractThreadId: набор мест и вариантов написания тот же, что у треда.
function extractTurnId(payload: Record<string, unknown> | null): string | null {
  return (
    readString(payload?.turnId) ??
    readString(payload?.turn_id) ??
    readString(asRecord(payload?.turn)?.id) ??
    null
  );
}

// Обрезка длинных строк для отображения. Усечение с запасом в 3 символа нужно, чтобы
// итоговая длина вместе с многоточием не превысила лимит.
function shortenString(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

// JSON.stringify бросает на циклических ссылках и на значениях вроде BigInt. Здесь это
// диагностическая утилита, поэтому при сбое отдаётся String(value) вместо исключения:
// логирование не должно ломать обработку уведомления.
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// В отличие от одноимённой функции в run.ts, здесь возвращается именно | null, а не
// пустой объект: различие между «поля нет» и «поле есть, но пустое» существенно при
// разборе вложенных нагрузок. Все вызывающие обязаны проверять результат перед доступом.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Нормализация строковых полей недоверенного JSON: не-строка, пустая и пробельная строка
// дают null, поэтому проверка на непустоту и обрезка не нужны вызывающему.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Для дельт потокового текста trim не применяется намеренно: дельта из пробелов - значимая
// часть разметки, и её удаление исказило бы вывод. Требуется только непустая строка.
function readDeltaString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Number.isFinite отсекает NaN и Infinity: такие значения прошли бы проверку typeof, но
// затем распространились бы в расчёты учёта токенов и стоимости.
function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
