/**
 * Маршруты интерактивного чата (@aif/api).
 *
 * Назначение: единая точка общения пользователя с рантаймом (Claude, Codex,
 * OpenRouter) из UI. Здесь сосредоточен весь жизненный цикл одной реплики:
 * выбор адаптера и профиля, переиспользование или создание runtime-сессии,
 * стриминг событий в WebSocket, персистенция сообщений через @aif/data,
 * учет usage и обработка прерывания (abort).
 *
 * Почему файл устроен именно так:
 * - Ответ отдается по двум каналам сразу: JSON в HTTP-ответе (для клиентов без
 *   сокета) и дельта-события в WebSocket (для живого UI). Оба обязаны описывать
 *   один и тот же текст, поэтому любой фрагмент сначала накапливается в
 *   assistantSegments и только затем отдается наружу.
 * - Рантайм может оборвать поток на середине: часть текста приходит дельтами,
 *   часть остается в result.outputText, а вопросы (AskUserQuestion) приходят
 *   отдельными событиями. Поэтому порядок "текст -> вопрос -> текст"
 *   восстанавливается вручную, а не берется из порядка событий.
 * - AbortController регистрируется до любой медленной работы (резолв проекта,
 *   рантайма, автосоздание сессии). Иначе Stop, нажатый в первые сотни
 *   миллисекунд, попадал бы в 404, а запуск продолжал бы работу вхолостую.
 * - Часть состояния (полный ответ, id runtime-сессии, вложения) поднята во
 *   внешнюю область видимости try, потому что ветка abort должна успеть
 *   сохранить частичный результат и связать DB-сессию с рантаймом.
 * - Ошибки рантайма нельзя отдавать клиенту как есть: текст провайдера
 *   редактируется, а наружу уходит только классификация по структурным полям
 *   (категория, код), но не по содержимому сообщения.
 */
import { Hono } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { z } from "zod";
import {
  createRuntimeWorkflowSpec,
  getResultSessionId,
  isRuntimeErrorCategory,
  readCodexSessionEventsFromFile,
  readCodexSessionMetaFromFile,
  RUNTIME_TRUST_TOKEN,
  resolveAdapterCapabilities,
  RuntimeTransport,
  UsageSource,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeLimitSnapshot,
  type RuntimeRunInput,
  type RuntimeToolQuestionPayload,
} from "@aif/runtime";
import {
  logger,
  getEnv,
  redactProviderText,
  redactProviderTextForLogs,
  sanitizeRuntimeLimitSnapshotForExposure,
  type ChatMessageAttachment,
  type ChatSession,
  type ChatSessionMessage,
  type Task,
  type WsEvent,
} from "@aif/shared";
import {
  createChatMessage,
  createChatSession,
  deleteChatSession,
  findChatSessionById,
  findCodexSessionFilePathBySessionId,
  findProjectById,
  findRuntimeProfileById,
  findTaskById,
  listChatMessages,
  listChatSessions,
  listCodexSessionsByProjectRoot,
  toChatMessageResponse,
  toChatSessionResponse,
  toRuntimeProfileResponse,
  toTaskResponse,
  updateChatSession,
  updateChatSessionTimestamp,
} from "@aif/data";
import { chatRequestSchema, createChatSessionSchema, updateChatSessionSchema } from "../schemas.js";
import { persistAttachments } from "../services/attachmentPersistence.js";
import { readAttachment } from "../services/attachmentStorage.js";
import { broadcast, sendToClient } from "../ws.js";
import {
  getCached,
  invalidateCache,
  sessionCacheKey,
  setCached,
  shouldUseSessionCacheForRuntime,
} from "../services/sessionCache.js";
import {
  assertApiRuntimeCapabilities,
  extractLatestRuntimeLimitSnapshot,
  extractRuntimeLimitSnapshotFromError,
  getApiRuntimeRegistry,
  observeRuntimeLimitEvent,
  refreshRuntimeProfileLimitState,
  resolveApiRuntimeContext,
} from "../services/runtime.js";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";

// Границу проекта задаем текстом системного промпта, а не фильтрацией на
// стороне API: рантайм сам решает, какие пути читать, поэтому ограничить его
// можно только договоренностью в промпте.
const PROJECT_SCOPE_SYSTEM_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

// UI не умеет отвечать на интерактивный инструмент внутри одного хода: вопрос
// рендерится как markdown, а ответ приходит следующим сообщением. Без этой
// договоренности модель может молча ждать ввода, которого не будет.
const CHAT_ASKUSERQUESTION_HINT =
  "Chat interaction rule: the AIF chat UI renders AskUserQuestion tool calls as a markdown block " +
  "with the question, header, and numbered options — use the tool normally when you need structured " +
  "input. The user's next chat message is their answer and the session resumes with that answer in " +
  "history; never wait silently.";

// Читающие инструменты не меняют состояние проекта и дают много визуального
// шума, поэтому их вызовы не отражаются в ленте чата.
const NOISY_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

// Внутренняя форма вопроса: адаптеры дают необязательные поля, а рендерер
// ожидает нормализованный вид с гарантированным массивом опций.
type NormalizedQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

// Рендерим блок вручную (а не markdown-таблицей), чтобы нумерация опций
// совпадала с номерами, которые пользователь вводит в ответе.
function renderQuestionBlock(entry: NormalizedQuestion, showSelectionHint: boolean): string[] {
  const lines: string[] = [];
  if (entry.header) lines.push(`**${entry.header}**`);
  if (entry.question) lines.push(`**❓ ${entry.question}**`);
  if (showSelectionHint && entry.options.length > 0) {
    lines.push(
      entry.multiSelect
        ? `_Select one or more (${entry.options.length} options)._`
        : `_Select one._`,
    );
  }
  if (entry.options.length > 0) {
    lines.push("");
    entry.options.forEach((option, index) => {
      const description =
        option.description && option.description.trim().length > 0
          ? ` — ${option.description.trim()}`
          : "";
      lines.push(`${index + 1}. ${option.label}${description}`);
    });
  }
  return lines;
}

// Возвращает null, когда рендерить нечего: пустой блок лучше не показывать,
// чем вставлять в чат сообщение из одних разделителей.
function formatToolQuestion(payload: RuntimeToolQuestionPayload): string | null {
  const multipleQuestions = payload.questions.length > 1;
  const anyMultiSelect = payload.questions.some((q) => q.multiSelect === true);
  const blocks = payload.questions
    .map((entry) =>
      renderQuestionBlock(
        {
          question: entry.question,
          header: entry.header,
          multiSelect: entry.multiSelect,
          options: entry.options ?? [],
        },
        multipleQuestions || anyMultiSelect,
      ),
    )
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return null;
  const lines: string[] = ["", ""];
  blocks.forEach((block, index) => {
    if (index > 0) lines.push("", "---", "");
    lines.push(...block);
  });
  lines.push("");
  if (multipleQuestions) {
    lines.push(
      "_Answer each question in order — you can use numbers, comma-separated lists for multi-select, or free text._",
    );
  } else if (anyMultiSelect) {
    lines.push(
      "_You can select multiple options — list the numbers separated by commas, or answer in free text._",
    );
  } else {
    lines.push("_Answer by number or free text in the next message._");
  }
  lines.push("", "");
  return lines.join("\n");
}

// Протокол действий: модель помечает намерение создать задачу специальным
// блоком <!--ACTION:CREATE_TASK-->, а UI превращает его в карточку
// подтверждения. Так создание задачи остается явным действием пользователя, а
// не побочным эффектом обычного ответа.
const CHAT_ACTIONS_PROMPT = `
Identity: You are AIFer.

You have special capabilities in this chat:

1. CREATE TASK: ONLY when the user explicitly asks to create a task (e.g. "создай задачу", "create a task", "добавь таск"), output a structured block. Do NOT create tasks unprompted or for casual messages:
<!--ACTION:CREATE_TASK-->
{"title": "Short task title", "description": "Detailed task description with context from the conversation", "isFix": false}
<!--/ACTION-->
Include this block in your response along with a brief explanation of the task you're creating. The user will see a confirmation card and can approve it.

Set "isFix" to true when the user describes a bug, defect, or asks to fix/repair/debug something (e.g. "исправь", "fix", "починить", "баг", "не работает", "сломалось"). When isFix is true, the agent pipeline will use the bug-fix workflow instead of the feature workflow. Default is false for new features, improvements, and refactoring.

2. TASK SUMMARY: When the user asks to summarize what was done on the current task (or any task you have context for), generate a concise summary covering: what was planned, what was implemented, review results, and current status.
`.trim();

const log = logger("chat-route");
// Отдельное имя для логов, которые читает UI рантайма: по нему сообщения
// фильтруются в панели активности.
const API_RUNTIME_LOG = "api-runtime";
type CreateChatSessionPayload = z.infer<typeof createChatSessionSchema>;
type UpdateChatSessionPayload = z.infer<typeof updateChatSessionSchema>;
type ChatRequestPayload = z.infer<typeof chatRequestSchema>;

// Описание "виртуальной" сессии, у которой нет строки в БД: она существует
// только на стороне рантайма и адресуется составным идентификатором.
interface VirtualRuntimeSessionRef {
  runtimeId: string;
  sessionId: string;
}

// Редактируем построчно, а не целиком: многострочные блоки (план, лог
// реализации) должны сохранить разбиение, иначе промпт потеряет структуру.
function redactTaskContextForRuntimePrompt(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => redactProviderText(line))
    .join("\n");
}

// Собирает системную добавку из независимых частей: правило области проекта
// присутствует всегда, а подсказка про интерактивные вопросы - только если
// адаптер действительно умеет их задавать.
function buildContextAppend(
  projectName: string,
  task: Task | null,
  options: { interactiveQuestions?: boolean } = {},
): string {
  const parts = [PROJECT_SCOPE_SYSTEM_APPEND];
  if (options.interactiveQuestions) parts.push(CHAT_ASKUSERQUESTION_HINT);

  parts.push(`\nCurrent project: "${projectName}"`);

  if (task) {
    const lines = [
      `\nCurrently open task [${task.id}]:`,
      `  Title: ${redactTaskContextForRuntimePrompt(task.title)}`,
      `  Status: ${task.status}`,
    ];
    if (task.description) {
      lines.push(`  Description: ${redactTaskContextForRuntimePrompt(task.description)}`);
    }
    if (task.plan) lines.push(`  Plan:\n${redactTaskContextForRuntimePrompt(task.plan)}`);
    if (task.implementationLog) {
      lines.push(
        `  Implementation log:\n${redactTaskContextForRuntimePrompt(task.implementationLog)}`,
      );
    }
    if (task.reviewComments) {
      lines.push(`  Review comments:\n${redactTaskContextForRuntimePrompt(task.reviewComments)}`);
    }
    if (task.agentActivityLog) {
      lines.push(
        `  Agent activity log:\n${redactTaskContextForRuntimePrompt(task.agentActivityLog)}`,
      );
    }
    parts.push(lines.join("\n"));
  } else {
    parts.push("No task is currently open.");
  }

  parts.push(`\n${CHAT_ACTIONS_PROMPT}`);
  return parts.join("\n");
}

// Идентификаторы рантаймов сравниваем в нормализованном виде: пользователь и
// конфиг могут дать разный регистр, а реестр адаптеров регистрозависим.
function normalizeRuntimeId(value: string): string {
  return value.trim().toLowerCase();
}

const CODEX_RUNTIME_ID = "codex";

function isLocalCodexRuntimeId(runtimeId: string): boolean {
  return normalizeRuntimeId(runtimeId) === CODEX_RUNTIME_ID;
}

// Схема виртуального id: "sdk:<id>" для единого SDK-транспорта и
// "runtime:<runtimeId>:<sessionId>" для остальных. Так один и тот же
// внешний id не конфликтует между разными рантаймами.
function formatVirtualRuntimeSessionId(
  runtimeId: string,
  runtimeSessionId: string,
  transport?: string,
): string {
  if (transport === RuntimeTransport.SDK) {
    return `sdk:${runtimeSessionId}`;
  }
  return `runtime:${encodeURIComponent(runtimeId)}:${encodeURIComponent(runtimeSessionId)}`;
}

// Разбор обратен formatVirtualRuntimeSessionId; для схемы "sdk:" рантайм
// берется из окружения, потому что в самом id его нет.
function parseVirtualRuntimeSessionId(
  id: string,
  fallbackRuntimeId?: string,
): VirtualRuntimeSessionRef | null {
  if (id.startsWith("sdk:")) {
    const sessionId = id.slice(4).trim();
    return sessionId
      ? { runtimeId: fallbackRuntimeId ?? getEnv().AIF_DEFAULT_RUNTIME_ID, sessionId }
      : null;
  }

  if (!id.startsWith("runtime:")) {
    return null;
  }

  const match = /^runtime:([^:]+):(.+)$/.exec(id);
  if (!match) return null;

  const runtimeId = decodeURIComponent(match[1] ?? "").trim();
  const sessionId = decodeURIComponent(match[2] ?? "").trim();

  if (!runtimeId || !sessionId) return null;
  return { runtimeId: normalizeRuntimeId(runtimeId), sessionId };
}

// Источник влияет на то, как UI подписывает сессию: запуски через CLI и
// app-server считаются локальными, все остальные - агентными.
function runtimeSourceFromTransport(transport: string): "cli" | "agent" {
  return transport === RuntimeTransport.CLI || transport === RuntimeTransport.APP_SERVER
    ? "cli"
    : "agent";
}

// Преобразование событий рантайма в сообщения чата. События без роли или без
// текста отбрасываются: в UI они не отображаются, а в БД создавали бы пустые
// строки и ломали дедупликацию при перезагрузке.
function mapRuntimeEventsToChatMessages(
  runtimeEvents: RuntimeEvent[],
  sessionId: string,
  adapter?: RuntimeAdapter,
): ChatSessionMessage[] {
  return runtimeEvents
    .map((event) => {
      if (event.type === "tool:question") {
        const payload = event.data as unknown as RuntimeToolQuestionPayload | undefined;
        if (!payload) return null;
        const rendered = formatToolQuestion(payload);
        if (!rendered || !rendered.trim()) return null;
        return {
          id: eventId(event),
          sessionId,
          role: "assistant" as const,
          content: rendered,
          createdAt: event.timestamp,
        } as ChatSessionMessage;
      }
      const role = eventRole(event);
      const rawContent = event.message ?? "";
      const content = extractMessageContent(rawContent, adapter);
      if (!role || !content.trim()) return null;
      return {
        id: eventId(event),
        sessionId,
        role,
        content,
        createdAt: event.timestamp,
      } as ChatSessionMessage;
    })
    .filter((message): message is ChatSessionMessage => Boolean(message));
}

// Быстрый путь для Codex: сессия восстанавливается из локального индекса без
// поднятия адаптера. Возврат null означает "индекса нет", и вызывающий код
// откатывается на общий путь через адаптер.
async function loadIndexedCodexVirtualSession(input: {
  virtualId: string;
  projectId: string | null;
  runtimeProfileId: string | null;
  runtimeSessionId: string;
}): Promise<ChatSession | null> {
  const filePath = findCodexSessionFilePathBySessionId(input.runtimeSessionId);
  if (!filePath) return null;

  const meta = await readCodexSessionMetaFromFile(filePath);
  if (!meta) return null;

  return {
    id: input.virtualId,
    projectId: input.projectId ?? "",
    title: meta.prompt || "Untitled",
    agentSessionId: null,
    runtimeProfileId: input.runtimeProfileId,
    runtimeSessionId: meta.id,
    source: "agent",
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

// То же самое для сообщений: null здесь - сигнал откатиться на адаптер, а не
// "сообщений нет". Пустой массив означает именно отсутствие событий.
async function loadIndexedCodexRuntimeMessages(input: {
  runtimeSessionId: string;
  chatSessionId: string;
  limit?: number;
}): Promise<ChatSessionMessage[] | null> {
  const filePath = findCodexSessionFilePathBySessionId(input.runtimeSessionId);
  if (!filePath) return null;
  const runtimeEvents = await readCodexSessionEventsFromFile(filePath, {
    limit: input.limit,
  });
  // События JSONL проиндексированного Codex нормализованы в обычные строковые
  // сообщения, поэтому специфичное для адаптера извлечение контента здесь не нужно.
  return mapRuntimeEventsToChatMessages(runtimeEvents, input.chatSessionId);
}

// Прерывание может быть обернуто: проверяем name, code и рекурсивно cause,
// потому что разные транспорты заворачивают сигнал по-своему.
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const asError = err as { name?: string; code?: string; cause?: unknown };
  if (asError.name === "AbortError") return true;
  if (asError.code === "ABORT_ERR") return true;
  if (asError.cause) return isAbortError(asError.cause);
  return false;
}

// Классификация ошибки без разбора текста сообщения: решение принимается по
// структурной категории (@aif/runtime), а наружу уходит уже безопасная строка.
// Сырой текст провайдера остается только в логах.
function classifyChatError(err: unknown): {
  status: 429 | 500;
  code: string;
  message: string;
} {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const normalizedRawMessage = rawMessage?.trim()
    ? redactProviderTextForLogs(rawMessage.trim())
    : null;

  const redactForClient = (message: string, code: string, status: 429 | 500) => {
    if (normalizedRawMessage && normalizedRawMessage !== message) {
      log.warn(
        {
          code,
          status,
          rawMessage: normalizedRawMessage,
        },
        "Redacted runtime error details before sending chat failure to the client",
      );
    }
    return { status, code, message };
  };

  if (isRuntimeErrorCategory(err, "rate_limit")) {
    return redactForClient(
      "Runtime usage limit reached. Try again later.",
      "CHAT_USAGE_LIMIT",
      429,
    );
  }

  if (isRuntimeErrorCategory(err, "auth")) {
    return redactForClient(
      "Runtime authentication failed. Check the configured runtime profile.",
      "CHAT_AUTH_ERROR",
      500,
    );
  }

  return redactForClient("Chat request failed", "CHAT_REQUEST_FAILED", 500);
}

/** Санитизация входа с учётом runtime: adapter.sanitizeInput, если доступен, иначе без изменений. */
function sanitizeRuntimeInput(text: string, adapter?: RuntimeAdapter): string {
  return adapter?.sanitizeInput ? adapter.sanitizeInput(text) : text.trim();
}

// Снимок лимитов показываем только при включенной фиче: клиентские экраны
// завязаны на тот же флаг, и отдача снимка в выключенном деплое дает лишь
// лишние байты и риск устаревшего UI.
function normalizeOptionalRuntimeLimitSnapshot(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): RuntimeLimitSnapshot | null {
  // Полностью пропускаем выдачу, когда функция лимитов использования
  // отключена — поверхности UI гейтятся тем же флагом, поэтому пересылка
  // снапшота лишь тратит байты и рискует устаревшим UI в отключённых сборках.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return null;
  return snapshot ? sanitizeRuntimeLimitSnapshotForExposure(snapshot, "chat") : null;
}

/**
 * Убирает блок "Attached files:", дописываемый к пользовательским промптам.
 * Runtime-адаптеры могут сохранять полный промпт; нужно только исходное сообщение пользователя.
 */
function stripAttachedFilesBlock(text: string): string {
  const idx = text.indexOf("\n\n---\nAttached files:\n");
  return idx !== -1 ? text.slice(0, idx) : text;
}

/**
 * Извлекает человекочитаемый текст из полезной нагрузки сообщений.
 * Возвращает только видимый пользователю текст — блоки thinking/tool пропускаются.
 */
// Событие может быть строкой, объектом с content-строкой или массивом
// блоков. Интересуют только текстовые блоки: thinking и вызовы инструментов в
// историю чата не попадают.
function extractMessageContent(message: unknown, adapter?: RuntimeAdapter): string {
  const sanitize = (t: string) => sanitizeRuntimeInput(t, adapter);

  if (typeof message === "string") return stripAttachedFilesBlock(sanitize(message));
  if (!message || typeof message !== "object") return "";

  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return stripAttachedFilesBlock(sanitize(msg.content));

  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (!b || typeof b !== "object") continue;

      if (b.type === "text" && typeof b.text === "string") {
        parts.push(sanitize(b.text));
      }
    }
    return stripAttachedFilesBlock(parts.join("\n\n").trim());
  }

  return "";
}

// Роль не приходит отдельным полем события - она лежит внутри data. Ответ null
// означает, что событие не является репликой и должно быть отброшено.
function eventRole(event: RuntimeEvent): "user" | "assistant" | null {
  const roleValue =
    event.data && typeof event.data === "object" && typeof event.data.role === "string"
      ? event.data.role
      : null;
  if (roleValue === "user" || roleValue === "assistant") {
    return roleValue;
  }
  return null;
}

// Идентификатор должен быть стабильным между запросами: если у события нет id,
// генерируем случайный, но для вопросов опираемся на toolUseId, иначе один и
// тот же вопрос получал бы новый id при каждом обновлении страницы.
function eventId(event: RuntimeEvent): string {
  const data = event.data;
  if (data && typeof data === "object") {
    if (typeof data.id === "string" && data.id) {
      return data.id;
    }
    // Полезная нагрузка `tool:question` не имеет общего поля `id` — откатываемся к
    // `toolUseId` провайдера, чтобы один и тот же вопрос сохранял стабильный клиентский
    // id между выборками/перезагрузками вместо перемешивания при каждом обновлении.
    if (event.type === "tool:question" && typeof data.toolUseId === "string" && data.toolUseId) {
      return `tool:question:${data.toolUseId}`;
    }
  }
  return crypto.randomUUID();
}

// Ответ ассистента хранится не одной строкой, а последовательностью сегментов:
// только так можно сохранить чередование текста и блоков вопросов.
type AssistantSegment = {
  type: "text" | "question";
  content: string;
};

// Соседние текстовые дельты склеиваются в один сегмент: дробить их значило бы
// получить десятки строк в БД на один ответ.
function mergeAdjacentTextSegment(segments: AssistantSegment[], text: string): void {
  if (!text) return;
  const last = segments.at(-1);
  if (last?.type === "text") {
    last.content += text;
    return;
  }
  segments.push({ type: "text", content: text });
}

// Ищем наибольшее перекрытие суффикса left и префикса right - по нему потом
// решается, какую часть outputText считать недостающей.
function longestOverlapSuffixPrefix(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let len = max; len > 0; len -= 1) {
    if (left.endsWith(right.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

// Сопоставляет фактический текст ответа (outputText) со стримом дельт и
// возвращает пропущенные части. Сравнение идет по точному вхождению, затем по
// краям, и лишь затем - по перекрытию: чем слабее эвристика, тем выше риск
// продублировать текст, поэтому порядок проверок именно такой.
function recoverMissingTextParts(
  streamed: string,
  outputText: string,
): { prefix: string; suffix: string } {
  if (!outputText) {
    return { prefix: "", suffix: "" };
  }

  if (!streamed) {
    return { prefix: outputText, suffix: "" };
  }

  if (outputText === streamed) {
    return { prefix: "", suffix: "" };
  }

  const exactIndex = outputText.indexOf(streamed);
  if (exactIndex !== -1) {
    return {
      prefix: outputText.slice(0, exactIndex),
      suffix: outputText.slice(exactIndex + streamed.length),
    };
  }

  if (outputText.startsWith(streamed)) {
    return { prefix: "", suffix: outputText.slice(streamed.length) };
  }

  if (outputText.endsWith(streamed)) {
    return { prefix: outputText.slice(0, outputText.length - streamed.length), suffix: "" };
  }

  const suffixOverlap = longestOverlapSuffixPrefix(streamed, outputText);
  const appendCandidate = outputText.slice(suffixOverlap);
  const prefixOverlap = longestOverlapSuffixPrefix(outputText, streamed);
  const prependCandidate = outputText.slice(0, outputText.length - prefixOverlap);

  if (appendCandidate.length <= prependCandidate.length) {
    return { prefix: "", suffix: appendCandidate };
  }

  return { prefix: prependCandidate, suffix: "" };
}

/**
 * Нормализует строку содержимого сообщения перед сопоставлением между
 * runtime- и DB-источниками. Runtime-содержимое уже `.trim()`'ится в
 * extractTextContent (и в парсере файлов сессий Claude, который склеивает
 * блоки через `\n\n` и затем обрезает), а DB-содержимое хранит сырую
 * потоковую строку с возможными ведущими/замыкающими пробелами из delta-
 * потока Claude. Без нормализации точное сравнение в
 * mergeRuntimeAndDbMessages не срабатывает и после перезагрузки страницы
 * появляется дубликат.
 */
function normalizeContentForMatch(content: string): string {
  return content.trim();
}

// Сводим историю из рантайма и из БД в один список. Совпадения ищутся по паре
// роль + нормализованный текст: при совпадении предпочитаем DB-запись, потому
// что только в ней есть настоящий id, время и вложения. Несовпавшие DB-строки
// (например, из отредактированной вручную истории) добавляются в конец.
function mergeRuntimeAndDbMessages(
  runtimeMessages: ChatSessionMessage[],
  dbMessages: ChatSessionMessage[],
): ChatSessionMessage[] {
  if (runtimeMessages.length === 0) {
    return dbMessages;
  }

  const matchedRuntimeMessages = new Array(runtimeMessages.length).fill(false);
  const merged = runtimeMessages.map((message) => ({ ...message }));
  const normalizedRuntimeContent = runtimeMessages.map((message) =>
    normalizeContentForMatch(message.content),
  );

  for (const dbMessage of dbMessages) {
    const normalizedDbContent = normalizeContentForMatch(dbMessage.content);
    const matchIndex = runtimeMessages.findIndex(
      (runtimeMessage, index) =>
        !matchedRuntimeMessages[index] &&
        runtimeMessage.role === dbMessage.role &&
        normalizedRuntimeContent[index] === normalizedDbContent,
    );

    if (matchIndex === -1) {
      merged.push(dbMessage);
      continue;
    }

    matchedRuntimeMessages[matchIndex] = true;
    merged[matchIndex] = {
      ...merged[matchIndex],
      id: dbMessage.id,
      createdAt: dbMessage.createdAt,
      ...(dbMessage.attachments?.length ? { attachments: dbMessage.attachments } : {}),
    };
  }

  return merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

// Спецификация workflow для чата: обязательных возможностей нет, а сессию
// переиспользуем, если адаптер умеет resume.
function buildChatRuntimeWorkflow(prompt: string, systemPromptAppend: string) {
  return createRuntimeWorkflowSpec({
    workflowKind: "chat",
    prompt,
    requiredCapabilities: [],
    sessionReusePolicy: "resume_if_available",
    systemPromptAppend,
  });
}

// Общий путь резолва для всех чат-эндпоинтов: сначала выбираем профиль и
// адаптер, затем сразу проверяем возможности - до запуска, а не после, чтобы
// не получить половину работы без возможности ее продолжить.
async function resolveChatRuntimeAdapter(
  projectId: string,
  prompt: string,
  systemAppend: string,
  options: { runtimeProfileId?: string | null } = {},
) {
  const workflow = buildChatRuntimeWorkflow(prompt, systemAppend);
  const context = await resolveApiRuntimeContext({
    projectId,
    mode: "chat",
    workflow,
    runtimeProfileId: options.runtimeProfileId,
  });
  assertApiRuntimeCapabilities({
    adapter: context.adapter,
    resolvedProfile: context.resolvedProfile,
    workflow,
  });
  return { workflow, context };
}

// Адаптер резолвится по runtimeId для операций над уже существующей
// runtime-сессией, когда профиль проекта может быть недоступен.
async function getAdapterForRuntimeId(runtimeId: string): Promise<RuntimeAdapter> {
  const registry = await getApiRuntimeRegistry();
  return registry.resolveRuntime(runtimeId);
}

// Параметры, нужные адаптеру для доступа к чужой сессии. Заполняются
// максимально доступно и деградируют до значений по умолчанию.
interface RuntimeSessionLookupContext {
  providerId: string;
  profileId: string | null;
  runtimeProfileId: string | null;
  transport: string | null;
  projectRoot?: string;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

// Пустая строка и отсутствие параметра равнозначны: иначе пустой query-параметр
// перезаписывал бы значение из профиля.
function parseOptionalQueryParam(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Собираем options только из заданных полей: undefined здесь был бы передан в
// адаптер и перекрыл бы собственные значения по умолчанию.
function buildSessionLookupOptions(input: {
  options?: Record<string, unknown> | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  apiKeyEnvVar?: string | null;
}): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {
    ...(input.options ?? {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.apiKeyEnvVar ? { apiKeyEnvVar: input.apiKeyEnvVar } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

// Приоритет источников: сначала явно указанный профиль, затем профиль проекта,
// и только потом дескриптор адаптера. Профиль принимается лишь при совпадении
// runtimeId, иначе адаптер пошел бы не за той сессией.
async function resolveVirtualSessionLookupContext(input: {
  runtimeId: string;
  adapter: RuntimeAdapter;
  projectId: string | null;
  runtimeProfileId: string | null;
}): Promise<RuntimeSessionLookupContext> {
  if (input.runtimeProfileId) {
    const profileRow = findRuntimeProfileById(input.runtimeProfileId);
    const profile = profileRow ? toRuntimeProfileResponse(profileRow) : null;
    if (profile && profile.runtimeId === input.runtimeId) {
      return {
        providerId: profile.providerId,
        profileId: profile.id,
        runtimeProfileId: profile.id,
        transport: profile.transport ?? null,
        options: buildSessionLookupOptions({
          options: profile.options ?? {},
          baseUrl: profile.baseUrl ?? null,
          apiKeyEnvVar: profile.apiKeyEnvVar ?? null,
        }),
        headers: profile.headers ?? {},
      };
    }
  }

  if (input.projectId) {
    const project = findProjectById(input.projectId);
    if (project) {
      try {
        const systemAppend = buildContextAppend(project.name, null);
        const { context } = await resolveChatRuntimeAdapter(
          input.projectId,
          "session-lookup",
          systemAppend,
        );
        if (context.resolvedProfile.runtimeId === input.runtimeId) {
          return {
            providerId: context.resolvedProfile.providerId,
            profileId: context.resolvedProfile.profileId ?? null,
            runtimeProfileId: context.resolvedProfile.profileId ?? null,
            transport: context.resolvedProfile.transport ?? null,
            projectRoot: project.rootPath,
            options: buildSessionLookupOptions({
              options: context.resolvedProfile.options ?? {},
              baseUrl: context.resolvedProfile.baseUrl ?? null,
              apiKey: context.resolvedProfile.apiKey ?? null,
              apiKeyEnvVar: context.resolvedProfile.apiKeyEnvVar ?? null,
            }),
            headers: context.resolvedProfile.headers,
          };
        }
      } catch (err) {
        log.debug(
          {
            err,
            projectId: input.projectId,
            runtimeId: input.runtimeId,
          },
          "Unable to resolve project runtime context for virtual session lookup",
        );
      }
    }
  }

  return {
    providerId: input.adapter.descriptor.providerId,
    profileId: null,
    runtimeProfileId: null,
    transport: null,
  };
}

export const chatRouter = new Hono();

/**
 * Реестр AbortController по каждой беседе. Заполняется перед отправкой
 * вызова `run`/`resume` рантайма и очищается в finally-блоке маршрута.
 * Эндпоинт `/:conversationId/abort` находит контроллер и вызывает
 * `.abort()`, что распространяется через адаптер Claude (AbortController в
 * опциях запроса SDK, `kill()` у spawn CLI) и проявляется клиенту как
 * `chat:error` с кодом `"aborted"`.
 */
// Активные запуски адресуются по conversationId, а не по sessionId: клиент
// начинает новый чат до того, как у него появится id сессии, и должен уметь
// его остановить.
const activeChatRuns = new Map<string, AbortController>();

// ── CRUD сессий ───────────────────────────────────────────

// Проект обязателен: без него нельзя ни найти корень репозитория, ни выбрать
// профиль рантайма, а сессии без проекта не имеют смысла.
// GET /chat/sessions?projectId=...
chatRouter.get("/sessions", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }
  log.debug("GET /chat/sessions projectId=%s", projectId);

  const project = findProjectById(projectId);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  // Список отдается в двух слоях: сначала сохраненные сессии из БД, затем
  // обнаруженные у рантайма. Слияние делает клиентский код ниже, а здесь
  // важно только то, что список из БД не зависит от доступности рантайма.
  // Веб-сессии из БД
  const dbRows = listChatSessions(projectId);
  const dbSessions = dbRows.map(toChatSessionResponse);

  // Собираем id внешних runtime-сессий, привязанных в БД, чтобы не дублировать
  const linkedRuntimeSessionIds = new Set(
    dbRows.map((r) => r.runtimeSessionId ?? r.agentSessionId).filter(Boolean) as string[],
  );

  // Обнаружение сессий у рантайма - вспомогательное: при недоступности
  // провайдера пользователь все равно должен видеть свои сохраненные чаты.
  let runtimeSessions: ChatSession[] = [];
  const systemAppend = buildContextAppend(project.name, null);
  try {
    const { context } = await resolveChatRuntimeAdapter(
      projectId,
      "session-discovery",
      systemAppend,
    );
    const adapter = context.adapter;
    const runtimeId = context.resolvedProfile.runtimeId;
    if (isLocalCodexRuntimeId(runtimeId)) {
      const indexed = listCodexSessionsByProjectRoot({
        projectRoot: project.rootPath,
        limit: 50,
      });
      runtimeSessions = indexed
        .filter((session) => !linkedRuntimeSessionIds.has(session.sessionId))
        .map((session) => ({
          id: formatVirtualRuntimeSessionId(
            runtimeId,
            session.sessionId,
            context.resolvedProfile.transport,
          ),
          projectId,
          title: session.title || session.previewText || "Untitled",
          agentSessionId: null,
          runtimeProfileId: context.resolvedProfile.profileId,
          runtimeSessionId: session.sessionId,
          source: runtimeSourceFromTransport(context.resolvedProfile.transport),
          createdAt: session.sourceCreatedAt ?? session.createdAt,
          updatedAt: session.sourceUpdatedAt ?? session.updatedAt,
        }));

      log.debug(
        {
          projectId,
          runtimeId,
          profileId: context.resolvedProfile.profileId,
          source: "codex_index",
          discovered: indexed.length,
          mergedRuntimeSessions: runtimeSessions.length,
          dbSessions: dbSessions.length,
        },
        "[chat-route] Runtime session discovery completed",
      );
    } else {
      const caps = resolveAdapterCapabilities(adapter, context.resolvedProfile.transport);
      if (!caps.supportsSessionList || !adapter.listSessions) {
        log.warn(
          {
            projectId,
            runtimeId,
            profileId: context.resolvedProfile.profileId,
          },
          "WARN [chat-route] Runtime does not support external session listing; returning DB sessions only",
        );
      } else {
        // Кеш нужен из-за дорогого листинга у провайдера; включается только
        // для рантаймов, где такое поведение объявлено безопасным.
        const useCache = shouldUseSessionCacheForRuntime(runtimeId);
        const cacheKey = sessionCacheKey(
          runtimeId,
          context.resolvedProfile.profileId,
          project.rootPath,
        );
        let listed = useCache
          ? getCached<Awaited<ReturnType<NonNullable<typeof adapter.listSessions>>>>(cacheKey)
          : undefined;
        if (!listed) {
          listed = await adapter.listSessions({
            runtimeId,
            providerId: context.resolvedProfile.providerId,
            profileId: context.resolvedProfile.profileId,
            projectRoot: project.rootPath,
            transport: context.resolvedProfile.transport,
            limit: 50,
            options: {
              ...context.resolvedProfile.options,
              ...(context.resolvedProfile.baseUrl
                ? { baseUrl: context.resolvedProfile.baseUrl }
                : {}),
            },
            headers: context.resolvedProfile.headers,
          });
          if (useCache) {
            setCached(cacheKey, listed);
          }
        }

        runtimeSessions = listed
          .filter((session) => !linkedRuntimeSessionIds.has(session.id))
          .map((session) => ({
            id: formatVirtualRuntimeSessionId(
              runtimeId,
              session.id,
              context.resolvedProfile.transport,
            ),
            projectId,
            title: session.title || "Untitled",
            agentSessionId: null,
            runtimeProfileId: context.resolvedProfile.profileId,
            runtimeSessionId: session.id,
            source: runtimeSourceFromTransport(context.resolvedProfile.transport),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          }));

        log.debug(
          {
            projectId,
            runtimeId,
            profileId: context.resolvedProfile.profileId,
            source: "runtime_adapter",
            cacheEnabled: useCache,
            discovered: listed.length,
            mergedRuntimeSessions: runtimeSessions.length,
            dbSessions: dbSessions.length,
          },
          "[chat-route] Runtime session discovery completed",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err, projectId },
      "WARN [chat-route] Failed runtime session discovery; returning DB sessions only",
    );
  }

  // Слияние, сортировка по updatedAt DESC, не более 20
  // Ограничение в 20 записей держит ответ компактным и заодно закрывает
  // случай, когда история рантайма содержит сотни технических сессий.
  const all = [...dbSessions, ...runtimeSessions]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);

  return c.json(all);
});

// POST /chat/sessions
chatRouter.post("/sessions", jsonValidator(createChatSessionSchema), async (c) => {
  const body = c.req.valid("json") as CreateChatSessionPayload;
  log.debug("POST /chat/sessions projectId=%s title=%s", body.projectId, body.title);
  // Проверяем, что выбранный профиль действительно принадлежит проекту:
  // иначе чат мог бы незаметно уехать в чужой рабочий каталог.
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: body.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    return c.json(runtimeValidation, 400);
  }

  const row = createChatSession({
    projectId: body.projectId,
    title: body.title,
    runtimeProfileId: body.runtimeProfileId,
    runtimeSessionId: body.runtimeSessionId,
  });
  if (!row) {
    return c.json({ error: "Failed to create chat session" }, 500);
  }
  const session = toChatSessionResponse(row);
  broadcast({ type: "chat:session_created", payload: session });
  return c.json(session, 201);
});

// GET /chat/sessions/:id
chatRouter.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  log.debug("GET /chat/sessions/%s", id);

  // Виртуальный id означает сессию рантайма без строки в БД, поэтому сначала
  // проверяем виртуальный формат и только потом ищем запись в БД.
  const virtual = parseVirtualRuntimeSessionId(id);
  if (virtual) {
    const queryProjectId = parseOptionalQueryParam(c.req.query("projectId"));
    const queryRuntimeProfileId = parseOptionalQueryParam(c.req.query("runtimeProfileId"));
    if (isLocalCodexRuntimeId(virtual.runtimeId)) {
      const indexedSession = await loadIndexedCodexVirtualSession({
        virtualId: id,
        projectId: queryProjectId,
        runtimeProfileId: queryRuntimeProfileId,
        runtimeSessionId: virtual.sessionId,
      });
      if (indexedSession) {
        return c.json(indexedSession);
      }
      log.debug(
        {
          runtimeId: virtual.runtimeId,
          runtimeSessionId: virtual.sessionId,
          source: "codex_index",
        },
        "[chat-route] Indexed Codex session lookup missed; falling back to adapter",
      );
    }

    try {
      const adapter = await getAdapterForRuntimeId(virtual.runtimeId);
      if (!adapter.getSession) {
        return c.json({ error: "Runtime does not support session details" }, 404);
      }
      const lookupContext = await resolveVirtualSessionLookupContext({
        runtimeId: virtual.runtimeId,
        adapter,
        projectId: queryProjectId,
        runtimeProfileId: queryRuntimeProfileId,
      });
      const info = await adapter.getSession({
        runtimeId: virtual.runtimeId,
        providerId: lookupContext.providerId,
        profileId: lookupContext.profileId,
        projectRoot: lookupContext.projectRoot,
        transport: lookupContext.transport as RuntimeTransport | undefined,
        sessionId: virtual.sessionId,
        options: lookupContext.options,
        headers: lookupContext.headers,
      });
      if (!info) {
        return c.json({ error: "Chat session not found" }, 404);
      }
      // projectId у виртуальной сессии неизвестен, поэтому в ответе он пустой:
      // привязка появится после первого ответа в этот чат.
      const session: ChatSession = {
        id,
        projectId: "",
        title: info.title || "Untitled",
        agentSessionId: null,
        runtimeProfileId: lookupContext.runtimeProfileId,
        runtimeSessionId: info.id,
        source: runtimeSourceFromTransport(lookupContext.transport ?? RuntimeTransport.API),
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
      };
      return c.json(session);
    } catch (err) {
      log.warn({ err, runtimeId: virtual.runtimeId }, "Failed to get runtime session info");
      return c.json({ error: "Chat session not found" }, 404);
    }
  }

  const row = findChatSessionById(id);
  if (!row) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  return c.json(toChatSessionResponse(row));
});

// GET /chat/sessions/:id/messages
chatRouter.get("/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  log.debug("GET /chat/sessions/%s/messages", id);

  const virtual = parseVirtualRuntimeSessionId(id);
  if (virtual) {
    const queryProjectId = parseOptionalQueryParam(c.req.query("projectId"));
    const queryRuntimeProfileId = parseOptionalQueryParam(c.req.query("runtimeProfileId"));
    if (isLocalCodexRuntimeId(virtual.runtimeId)) {
      const indexedMessages = await loadIndexedCodexRuntimeMessages({
        runtimeSessionId: virtual.sessionId,
        chatSessionId: id,
      });
      if (indexedMessages) {
        return c.json(indexedMessages);
      }
      log.debug(
        {
          runtimeId: virtual.runtimeId,
          runtimeSessionId: virtual.sessionId,
          source: "codex_index",
        },
        "[chat-route] Indexed Codex session-message lookup missed; falling back to adapter",
      );
    }

    try {
      const adapter = await getAdapterForRuntimeId(virtual.runtimeId);
      if (!adapter.listSessionEvents) {
        return c.json({ error: "Runtime does not support session message listing" }, 404);
      }
      const lookupContext = await resolveVirtualSessionLookupContext({
        runtimeId: virtual.runtimeId,
        adapter,
        projectId: queryProjectId,
        runtimeProfileId: queryRuntimeProfileId,
      });

      const runtimeEvents = await adapter.listSessionEvents({
        runtimeId: virtual.runtimeId,
        providerId: lookupContext.providerId,
        profileId: lookupContext.profileId,
        projectRoot: lookupContext.projectRoot,
        transport: lookupContext.transport as RuntimeTransport | undefined,
        sessionId: virtual.sessionId,
        options: lookupContext.options,
        headers: lookupContext.headers,
      });

      // События рантайма и строки БД могут описывать одни и те же реплики,
      // поэтому перед отдачей они сводятся вместе по роли и тексту.
      const messages = mapRuntimeEventsToChatMessages(runtimeEvents, id, adapter);

      return c.json(messages);
    } catch (err) {
      log.warn(
        { err, runtimeId: virtual.runtimeId, runtimeSessionId: virtual.sessionId },
        "Failed to get runtime session messages",
      );
      return c.json({ error: "Chat session not found" }, 404);
    }
  }

  const session = findChatSessionById(id);
  if (!session) {
    return c.json({ error: "Chat session not found" }, 404);
  }

  // Основной путь: сессия есть в БД. К ее сообщениям добавляются события
  // рантайма, чтобы UI видел и то, что сохранил сервер, и то, что успел
  // начитать провайдер.
  const dbMessages = listChatMessages(id).map(toChatMessageResponse);
  const project = findProjectById(session.projectId);
  const linkedRuntimeSessionId = session.runtimeSessionId ?? session.agentSessionId;

  if (linkedRuntimeSessionId && project) {
    let runtimeId = getEnv().AIF_DEFAULT_RUNTIME_ID;
    let providerId = getEnv().AIF_DEFAULT_PROVIDER_ID;
    let profileId = session.runtimeProfileId ?? null;
    let profileOptions: Record<string, unknown> | undefined;
    let profileHeaders: Record<string, string> | undefined;
    let profileBaseUrl: string | null = null;
    let profileTransport: RuntimeTransport | undefined;

    // Параметры профиля разворачиваются вручную, потому что адаптер идет к уже
    // существующей сессии: она могла быть создана с профилем, который сейчас
    // не является профилем проекта.
    if (session.runtimeProfileId) {
      const profileRow = findRuntimeProfileById(session.runtimeProfileId);
      if (profileRow) {
        const profile = toRuntimeProfileResponse(profileRow);
        runtimeId = profile.runtimeId;
        providerId = profile.providerId;
        profileId = profile.id;
        profileOptions = profile.options;
        profileHeaders = profile.headers;
        profileBaseUrl = profile.baseUrl ?? null;
        profileTransport = (profile.transport ?? undefined) as RuntimeTransport | undefined;
      }
    }

    try {
      if (isLocalCodexRuntimeId(runtimeId)) {
        const indexedRuntimeMessages = await loadIndexedCodexRuntimeMessages({
          runtimeSessionId: linkedRuntimeSessionId,
          chatSessionId: id,
        });
        if (indexedRuntimeMessages) {
          if (indexedRuntimeMessages.length === 0 && dbMessages.length > 0) {
            log.debug(
              {
                sessionId: id,
                runtimeId,
                runtimeSessionId: linkedRuntimeSessionId,
                dbMessageCount: dbMessages.length,
              },
              "[chat-route] Indexed Codex runtime events were empty; falling back to DB messages",
            );
            return c.json(dbMessages);
          }
          return c.json(mergeRuntimeAndDbMessages(indexedRuntimeMessages, dbMessages));
        }
      }

      const adapter = await getAdapterForRuntimeId(runtimeId);
      if (adapter.listSessionEvents) {
        const runtimeEvents = await adapter.listSessionEvents({
          runtimeId,
          providerId,
          profileId,
          projectRoot: project.rootPath,
          transport: profileTransport,
          sessionId: linkedRuntimeSessionId,
          options: {
            ...(profileOptions ?? {}),
            ...(profileBaseUrl ? { baseUrl: profileBaseUrl } : {}),
          },
          headers: profileHeaders,
        });

        const runtimeMessages = mapRuntimeEventsToChatMessages(runtimeEvents, id, adapter);

        // Пустой ответ рантайма не стирает историю: если в БД есть сообщения,
        // отдаем именно их, иначе чат выглядел бы потерянным.
        if (runtimeMessages.length === 0 && dbMessages.length > 0) {
          log.debug(
            {
              sessionId: id,
              runtimeId,
              runtimeSessionId: linkedRuntimeSessionId,
              dbMessageCount: dbMessages.length,
            },
            "[chat-route] Runtime session events were empty; falling back to DB messages",
          );
          return c.json(dbMessages);
        }

        return c.json(mergeRuntimeAndDbMessages(runtimeMessages, dbMessages));
      }
    } catch (err) {
      log.warn(
        { err, runtimeId, runtimeSessionId: linkedRuntimeSessionId },
        "WARN [chat-route] Failed runtime session event load, falling back to DB messages",
      );
    }
  }

  return c.json(dbMessages);
});

// PUT /chat/sessions/:id
chatRouter.put("/sessions/:id", jsonValidator(updateChatSessionSchema), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json") as UpdateChatSessionPayload;
  log.debug("PUT /chat/sessions/%s title=%s", id, body.title);
  const existing = findChatSessionById(id);
  if (!existing) {
    return c.json({ error: "Chat session not found" }, 404);
  }

  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: existing.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    return c.json(runtimeValidation, 400);
  }

  // Обновляем только разрешенные поля: id, проект и авторство сессии менять
  // через этот эндпоинт нельзя.
  const row = updateChatSession(id, {
    title: body.title,
    runtimeProfileId: body.runtimeProfileId,
    runtimeSessionId: body.runtimeSessionId,
  });
  return c.json(row ? toChatSessionResponse(row) : null);
});

// DELETE /chat/sessions/:id
chatRouter.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  log.debug("DELETE /chat/sessions/%s", id);
  const existing = findChatSessionById(id);
  if (!existing) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  // Удаление полное: вместе с сессией @aif/data убирает связанные сообщения,
  // поэтому отдельная очистка здесь не нужна.
  deleteChatSession(id);
  broadcast({ type: "chat:session_deleted", payload: { id } });
  return c.body(null, 204);
});

// GET /chat/sessions/:sessionId/attachments/:filename — скачать вложение чата
chatRouter.get("/sessions/:sessionId/attachments/:filename", async (c) => {
  const { sessionId, filename } = c.req.param();
  const session = findChatSessionById(sessionId);
  if (!session) return c.json({ error: "Chat session not found" }, 404);

  const project = findProjectById(session.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const messages = listChatMessages(sessionId);
  const decodedFilename = decodeURIComponent(filename);

  // Вложение ищется перебором сообщений сессии: путь к файлу хранится только в
  // БД, а не в URL, поэтому прямой доступ по имени невозможен без проверки.
  for (const msg of messages) {
    const response = toChatMessageResponse(msg);
    const attachment = response.attachments?.find((a) => a.name === decodedFilename);
    if (attachment?.path) {
      try {
        const buffer = await readAttachment(project.rootPath, attachment.path);
        c.header("Content-Type", attachment.mimeType || "application/octet-stream");
        c.header("Content-Disposition", `attachment; filename="${attachment.name}"`);
        c.header("Content-Length", String(buffer.length));
        return new Response(new Uint8Array(buffer), { headers: c.res.headers });
        // Ошибка чтения файла - это 404, а не 500: запись в БД могла сохраниться,
        // а сам файл на диске - исчезнуть (например, после очистки проекта).
      } catch {
        return c.json({ error: "Attachment file not found on disk" }, 404);
      }
    }
  }

  return c.json({ error: "Attachment not found" }, 404);
});

// POST /chat
// POST /chat/:conversationId/abort — прервать выполняющийся запуск чата.
chatRouter.post("/:conversationId/abort", async (c) => {
  const conversationId = c.req.param("conversationId");
  // Если запуска нет, отвечаем 404: клиент мог опоздать со Stop, и это не
  // ошибка - гонку с завершением запроса здесь гасить не нужно.
  const controller = activeChatRuns.get(conversationId);
  if (!controller) {
    log.debug(
      { conversationId },
      "[chat-route] abort requested for unknown or completed conversation",
    );
    return c.json({ error: "Conversation not found or already completed" }, 404);
  }
  controller.abort();
  activeChatRuns.delete(conversationId);
  log.info({ conversationId }, "INFO [chat-route] Chat run aborted by user");
  return c.body(null, 204);
});

chatRouter.post("/", jsonValidator(chatRequestSchema), async (c) => {
  const body = c.req.valid("json") as ChatRequestPayload;
  const { projectId, message, clientId, conversationId, explore, taskId, attachments } = body;
  let { sessionId: inputSessionId } = body;
  const env = getEnv();

  // Регистрируем AbortController ДО любой медленной работы (поиск проекта,
  // разрешение профиля, автосоздание сессии). Это закрывает окно, когда ранний
  // клик Stop клиент присылал в `/abort` и получал 404, потому что контроллера
  // ещё не было, а запрос `/chat` продолжал выполняться. Если `.abort()`
  // сработает до достижения `adapter.run()`, уже сброшенный сигнал доходит до
  // запуска и попадает в catch ниже.
  const chatConversationId = conversationId ?? crypto.randomUUID();
  const abortController = new AbortController();
  activeChatRuns.set(chatConversationId, abortController);

  let chatSessionId: string | null = null;
  let runtimeId: string | undefined;
  let runtimeProfileId: string | null | undefined;
  let runtimeProviderId: string | undefined;
  // Вынесена наверх, чтобы ветка abort могла сохранить частичный потоковый вывод.
  let fullAssistantResponse = "";
  // Захватывается из события runtime `system:init`, чтобы ветка abort могла
  // связать DB-сессию чата с runtime-сессией даже когда запуск так и не
  // завершился. Без этого прерывание первого хода нового чата ломало бы
  // непрерывность рантайма — следующий ход не имел бы контекста возобновления.
  let runtimeSessionIdFromEvents: string | null = null;
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  // Вынесены наверх, чтобы ветка abort могла показать клиенту разрешённые
  // сервером пути вложений — без этого прерванный запуск с файлами оставил бы
  // пузырёк пользователя с чипом без пути до повторного открытия сессии.
  let savedAttachments: ChatMessageAttachment[] | undefined;

  try {
    const project = findProjectById(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Разрешение текущей открытой задачи для внедрения контекста
    let currentTask: Task | null = null;
    if (taskId) {
      const row = findTaskById(taskId);
      if (row) currentTask = toTaskResponse(row);
    }

    chatSessionId = inputSessionId ?? null;
    const incomingVirtual = chatSessionId ? parseVirtualRuntimeSessionId(chatSessionId) : null;
    let existingSession =
      chatSessionId && !incomingVirtual ? (findChatSessionById(chatSessionId) ?? null) : null;
    if (chatSessionId && !incomingVirtual && !existingSession) {
      log.debug("Provided sessionId=%s not found, will auto-create", chatSessionId);
      chatSessionId = null;
    }

    const baseSystemAppend = buildContextAppend(project.name, currentTask);
    const runtimeResolution = await resolveChatRuntimeAdapter(
      projectId,
      message,
      baseSystemAppend,
      {
        runtimeProfileId: existingSession?.runtimeProfileId ?? null,
      },
    );
    const runtimeContext = runtimeResolution.context;
    const adapter = runtimeContext.adapter;
    runtimeId = runtimeContext.resolvedProfile.runtimeId;
    runtimeProfileId = runtimeContext.resolvedProfile.profileId;
    runtimeProviderId = runtimeContext.resolvedProfile.providerId;
    const chatRuntimeCaps = resolveAdapterCapabilities(
      adapter,
      runtimeContext.resolvedProfile.transport,
    );
    const systemAppend = buildContextAppend(project.name, currentTask, {
      interactiveQuestions: chatRuntimeCaps.supportsInteractiveQuestions === true,
    });

    // Разрешение или автосоздание сессии чата. Существующие DB-сессии читаются
    // до разрешения runtime, чтобы их сохранённый runtimeProfileId остался закреплён.

    // Внешние runtime-сессии виртуальны — создаём DB-сессию, привязанную к runtime-сессии
    if (incomingVirtual) {
      const autoTitle = message.slice(0, 80);
      const session = createChatSession({
        projectId,
        title: autoTitle,
        runtimeProfileId,
        runtimeSessionId: incomingVirtual.sessionId,
      });
      if (session) {
        chatSessionId = session.id;
        updateChatSession(session.id, {
          runtimeProfileId,
          runtimeSessionId: incomingVirtual.sessionId,
        });
        broadcast({ type: "chat:session_created", payload: toChatSessionResponse(session) });
      } else {
        chatSessionId = null;
      }
    }

    if (!chatSessionId) {
      const autoTitle = message.slice(0, 80);
      const session = createChatSession({
        projectId,
        title: autoTitle,
        runtimeProfileId,
      });
      chatSessionId = session?.id ?? null;
      if (session) {
        broadcast({ type: "chat:session_created", payload: toChatSessionResponse(session) });
      }
    }

    log.info(
      {
        projectId,
        clientId: clientId ?? null,
        conversationId: chatConversationId,
        sessionId: chatSessionId,
        runtimeId,
        runtimeProfileId,
        runtimeProviderId,
        logNamespace: API_RUNTIME_LOG,
        explore,
        taskId,
      },
      "INFO [api-runtime] Chat request started",
    );

    const dbSession = chatSessionId
      ? (existingSession ?? findChatSessionById(chatSessionId))
      : null;
    const resumeRuntimeSessionId =
      dbSession?.runtimeSessionId ?? dbSession?.agentSessionId ?? undefined;

    if (chatSessionId && !attachments?.length) {
      createChatMessage({ sessionId: chatSessionId, role: "user", content: message });
    }
    if (chatSessionId) {
      updateChatSessionTimestamp(chatSessionId);
    }

    // Сохраняем вложения-файлы на диск и собираем промпт с путями
    let prompt = explore ? `/aif-explore ${message}` : message;
    if (attachments?.length && chatSessionId) {
      const persisted = await persistAttachments(attachments, {
        projectRoot: project.rootPath,
        chatSessionId,
      });
      savedAttachments = persisted
        .filter((a) => a.path)
        .map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size, path: a.path }));
      const fileContext = persisted
        .map((f, i) => {
          const location = f.path ? `Path: ${f.path}` : "[metadata only]";
          return `File ${i + 1}: ${f.name} (${f.mimeType}, ${f.size} bytes)\n${location}`;
        })
        .join("\n\n");
      prompt = `${prompt}\n\n---\nAttached files:\n${fileContext}`;
    }

    if (chatSessionId && attachments?.length) {
      createChatMessage({
        sessionId: chatSessionId,
        role: "user",
        content: message,
        attachments: savedAttachments,
      });
    }

    const bypassPermissions = env.AGENT_BYPASS_PERMISSIONS;
    // Сохраняем порядок событий хода ассистента как сегменты text/question:
    //   * блоки вопросов буферизуются и сбрасываются перед следующим текстовым
    //     delta (или в конце хода), чтобы поток вида text→question→text оставался
    //     упорядоченным.
    //   * путь восстановления сливает отсутствующий текст из `result.outputText`
    //     с потоковыми delta через перекрытие суффикса/префикса и сбрасывает
    //     буферизованные вопросы после восстановленного текста, сохраняя
    //     порядок «вступление до вопроса».
    //   * персист в БД пишет каждый упорядоченный сегмент отдельной строкой
    //     ассистента, чтобы форма повтора совпадала с историей рантайма
    //     (`session-message` + отдельный `tool:question` на вопрос) и
    //     дедупликация оставалась стабильной при перезагрузке.
    let streamedText = "";
    let streamedTextLength = 0;
    const assistantSegments: AssistantSegment[] = [];
    const pendingQuestionBlocks: string[] = [];

    const sendToken = (text: string) => {
      if (!clientId) return;
      const tokenEvent: WsEvent = {
        type: "chat:token",
        payload: { conversationId: chatConversationId, token: text },
      };
      sendToClient(clientId, tokenEvent);
    };

    const seenToolPromptIds = new Set<string>();

    const flushPendingQuestionBlocks = () => {
      for (const block of pendingQuestionBlocks) {
        sendToken(block);
        assistantSegments.push({ type: "question", content: block });
        fullAssistantResponse = assistantSegments.map((segment) => segment.content).join("");
      }
      pendingQuestionBlocks.length = 0;
    };

    const onRuntimeEvent = (event: RuntimeEvent) => {
      latestLimitSnapshot = observeRuntimeLimitEvent(event, latestLimitSnapshot, {
        logger: log,
        observedMessage: "Observed runtime limit event during chat execution",
        malformedMessage: "Dropped runtime limit event with malformed snapshot payload",
        logContext: {
          conversationId: chatConversationId,
          projectId,
          taskId: taskId ?? null,
          runtimeId,
          runtimeProfileId,
        },
      });

      if (event.type === "stream:text" && event.message) {
        flushPendingQuestionBlocks();
        streamedTextLength += event.message.length;
        streamedText += event.message;
        mergeAdjacentTextSegment(assistantSegments, event.message);
        fullAssistantResponse = assistantSegments.map((segment) => segment.content).join("");
        sendToken(event.message);
        return;
      }

      if (event.type === "tool:summary" && event.message) {
        sendToken(`\n\n> ${event.message}\n\n`);
        return;
      }

      if (event.type === "tool:question") {
        const payload = event.data as unknown as RuntimeToolQuestionPayload | undefined;
        if (!payload) return;
        if (payload.toolUseId && seenToolPromptIds.has(payload.toolUseId)) return;
        const rendered = formatToolQuestion(payload);
        if (rendered) {
          log.debug(
            {
              tool: payload.toolName,
              conversationId: chatConversationId,
              questionCount: payload.questions.length,
            },
            "[chat] tool:question rendered",
          );
          pendingQuestionBlocks.push(rendered);
          if (payload.toolUseId) seenToolPromptIds.add(payload.toolUseId);
        }
        return;
      }

      if (event.type === "tool:use") {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const toolName = typeof data.name === "string" ? data.name : null;
        if (!toolName) return;
        if (data.interactive === true) {
          // Адаптер выпустит коррелированное событие `tool:question` для
          // интерактивных инструментов — пропускаем сырое tool:use, чтобы не
          // рендерить и строку `> Tool`, и блок вопроса. Нейтрально к runtime:
          // ветвление по флагу события, а не по имени инструмента провайдера.
          return;
        }
        if (NOISY_TOOL_NAMES.has(toolName) || toolName.startsWith("mcp__handoff__")) {
          log.debug(
            { tool: toolName, conversationId: chatConversationId },
            "[chat] tool:use suppressed (noisy)",
          );
          return;
        }
        log.debug(
          { tool: toolName, conversationId: chatConversationId, hasQuestion: false },
          "[chat] tool:use forwarded",
        );
        sendToken(`\n\n> 🔧 ${toolName}\n\n`);
      }

      // Захватываем id сессии рантайма сразу, как адаптер его выдаёт, чтобы
      // ветка abort могла сохранить связь DB→runtime-сессии даже когда
      // adapter.run() так и не разрешится. Без этого прерывание первого хода
      // нового чата оставило бы DB-сессию без runtimeSessionId, и следующий
      // ход ушёл бы без контекста возобновления.
      if (event.type === "system:init" && event.data) {
        const sid = event.data.sessionId;
        if (typeof sid === "string" && sid) {
          runtimeSessionIdFromEvents = sid;
        }
      }
    };

    const runInput: RuntimeRunInput = {
      runtimeId,
      providerId: runtimeProviderId,
      profileId: runtimeProfileId,
      workflowKind: "chat",
      transport: runtimeContext.resolvedProfile.transport,
      prompt,
      model: runtimeContext.resolvedProfile.model ?? undefined,
      sessionId: resumeRuntimeSessionId,
      resume: Boolean(resumeRuntimeSessionId),
      projectRoot: project.rootPath,
      cwd: project.rootPath,
      headers: runtimeContext.resolvedProfile.headers,
      usageContext: {
        source: UsageSource.CHAT,
        projectId: project.id,
        chatSessionId: chatSessionId ?? null,
        taskId: taskId ?? null,
      },
      options: {
        ...runtimeContext.resolvedProfile.options,
        ...(runtimeContext.resolvedProfile.baseUrl
          ? { baseUrl: runtimeContext.resolvedProfile.baseUrl }
          : {}),
        ...(runtimeContext.resolvedProfile.apiKey
          ? { apiKey: runtimeContext.resolvedProfile.apiKey }
          : {}),
        ...(runtimeContext.resolvedProfile.apiKeyEnvVar
          ? { apiKeyEnvVar: runtimeContext.resolvedProfile.apiKeyEnvVar }
          : {}),
      },
      execution: {
        startTimeoutMs: env.API_RUNTIME_START_TIMEOUT_MS,
        runTimeoutMs: env.API_RUNTIME_RUN_TIMEOUT_MS,
        includePartialMessages: true,
        maxTurns: env.AGENT_CHAT_MAX_TURNS,
        onEvent: onRuntimeEvent,
        systemPromptAppend: systemAppend,
        bypassPermissions,
        abortController,
        environment: {
          HANDOFF_MODE: "1",
          ...(taskId ? { HANDOFF_TASK_ID: taskId } : {}),
        },
        hooks: {
          permissionMode: bypassPermissions ? "bypassPermissions" : "acceptEdits",
          allowDangerouslySkipPermissions: bypassPermissions,
          _trustToken: RUNTIME_TRUST_TOKEN,
          settings: { attribution: { commit: "", pr: "" } },
          settingSources: ["project"],
        },
      },
    };

    const chatCapsForResume = resolveAdapterCapabilities(
      adapter,
      runtimeContext.resolvedProfile.transport,
    );
    const canResume =
      Boolean(resumeRuntimeSessionId) &&
      chatCapsForResume.supportsResume &&
      Boolean(adapter.resume);
    const result =
      canResume && adapter.resume
        ? await adapter.resume({ ...runInput, sessionId: resumeRuntimeSessionId! })
        : await adapter.run({
            ...runInput,
            sessionId: undefined,
            resume: false,
          });

    const chatCaps = resolveAdapterCapabilities(adapter, runtimeContext.resolvedProfile.transport);
    const runtimeSessionId = getResultSessionId(result, chatCaps) ?? resumeRuntimeSessionId ?? null;
    if (chatSessionId && runtimeSessionId) {
      updateChatSession(chatSessionId, {
        runtimeProfileId,
        runtimeSessionId,
      });
      invalidateCache(sessionCacheKey(runtimeId, runtimeProfileId, project.rootPath));
      log.debug(
        {
          runtimeId,
          runtimeProfileId,
          runtimeSessionId,
          sessionId: chatSessionId,
        },
        "[chat-route] Persisted runtime session link",
      );
    }

    latestLimitSnapshot = extractLatestRuntimeLimitSnapshot(result.events) ?? latestLimitSnapshot;
    if (latestLimitSnapshot) {
      refreshRuntimeProfileLimitState({
        runtimeProfileId,
        runtimeId,
        providerId: runtimeProviderId,
        snapshot: latestLimitSnapshot,
        taskId: taskId ?? null,
        projectId,
        conversationId: chatConversationId,
        workflowKind: "chat",
        reason: "chat:success",
      });
    } else {
      log.debug(
        {
          conversationId: chatConversationId,
          projectId,
          taskId: taskId ?? null,
          runtimeProfileId,
          runtimeId,
          providerId: runtimeProviderId,
        },
        "Preserving runtime limit state after successful chat execution without an authoritative recovery signal",
      );
    }

    // Восстанавливаем текст ассистента, который так и не пришёл delta-ми
    // `stream:text`. Claude CLI в partial-messages может выдавать смесь, где
    // часть текста ассистента приходит delta-ми, а остальное остаётся в
    // `result.outputText`. Склеиваем отсутствующие фрагменты префикса/суффикса
    // и отправляем их до буферизованных блоков вопросов, сохраняя порядок.
    const recovered = recoverMissingTextParts(streamedText, result.outputText ?? "");
    if (recovered.prefix) {
      mergeAdjacentTextSegment(assistantSegments, recovered.prefix);
      sendToken(recovered.prefix);
    }
    if (recovered.suffix) {
      mergeAdjacentTextSegment(assistantSegments, recovered.suffix);
      sendToken(recovered.suffix);
    }
    if (streamedTextLength === 0 && !streamedText && result.outputText) {
      streamedText = result.outputText;
    }
    flushPendingQuestionBlocks();

    fullAssistantResponse = assistantSegments.map((segment) => segment.content).join("");

    // Сохраняем каждый упорядоченный сегмент ассистента отдельно. Та же форма
    // разделения, что и при повторе runtime, делает mergeRuntimeAndDbMessages стабильным.
    if (chatSessionId) {
      for (const segment of assistantSegments) {
        const trimmed = segment.content.trim();
        if (!trimmed) continue;
        createChatMessage({
          sessionId: chatSessionId,
          role: "assistant",
          content: trimmed,
        });
      }
    }
    if (chatSessionId) {
      updateChatSessionTimestamp(chatSessionId);
    }

    const normalizedLatestLimitSnapshot =
      normalizeOptionalRuntimeLimitSnapshot(latestLimitSnapshot);
    const doneEvent: WsEvent = {
      type: "chat:done",
      payload: {
        conversationId: chatConversationId,
        projectId,
        taskId: taskId ?? null,
        runtimeProfileId: runtimeProfileId ?? null,
        runtimeLimitSnapshot: normalizedLatestLimitSnapshot,
        // Отдаём использование за ход, чтобы фронтенд показывал расход
        // токенов/стоимости без похода к таблице usage_events. Сам учёт уже
        // выполнен внутри обёртки реестра через DB-сток — эта полезная
        // нагрузка нужна исключительно для отображения в UI.
        usage: result.usage ?? null,
      },
    };
    if (clientId) {
      sendToClient(clientId, doneEvent);
    }

    return c.json({
      conversationId: chatConversationId,
      sessionId: chatSessionId,
      assistantMessage: fullAssistantResponse || null,
      usage: result.usage ?? null,
      runtime: {
        runtimeId,
        profileId: runtimeProfileId,
        providerId: runtimeProviderId,
      },
      runtimeLimitSnapshot: normalizedLatestLimitSnapshot,
      ...(savedAttachments?.length ? { attachments: savedAttachments } : {}),
    });
  } catch (err) {
    const errorLimitSnapshot = extractRuntimeLimitSnapshotFromError(err);
    const normalizedErrorLimitSnapshot = normalizeOptionalRuntimeLimitSnapshot(errorLimitSnapshot);
    const aborted = abortController.signal.aborted || isAbortError(err);
    if (aborted) {
      // Сохраняем все токены, отправленные до прерывания, чтобы частичный
      // ответ ассистента пережил перезагрузку. Без этого свежая сессия,
      // остановленная посреди потока, потеряла бы видимый вывод.
      const partial = fullAssistantResponse.trim();
      if (chatSessionId && partial) {
        createChatMessage({ sessionId: chatSessionId, role: "assistant", content: partial });
        updateChatSessionTimestamp(chatSessionId);
      }
      // Привязываем DB-сессию чата к runtime-сессии, которую адаптер успел
      // запустить до прерывания, чтобы следующий ход возобновил её, а не
      // начал новую runtime-ветку с потерей непрерывности.
      if (chatSessionId && runtimeSessionIdFromEvents) {
        updateChatSession(chatSessionId, {
          runtimeProfileId: runtimeProfileId ?? null,
          runtimeSessionId: runtimeSessionIdFromEvents,
        });
      }
      refreshRuntimeProfileLimitState({
        runtimeProfileId,
        runtimeId,
        providerId: runtimeProviderId,
        snapshot: errorLimitSnapshot,
        clearOnMissing: false,
        taskId: taskId ?? null,
        projectId,
        conversationId: chatConversationId,
        workflowKind: "chat",
        reason: "chat:aborted",
      });
      log.info(
        {
          runtimeId,
          runtimeProfileId,
          conversationId: chatConversationId,
          partial: partial.length,
          runtimeSessionId: runtimeSessionIdFromEvents,
        },
        "INFO [chat-route] Chat run aborted",
      );
      const abortedEvent: WsEvent = {
        type: "chat:error",
        payload: {
          conversationId: chatConversationId,
          projectId,
          taskId: taskId ?? null,
          runtimeProfileId: runtimeProfileId ?? null,
          runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
          message: "Chat run aborted by user",
          code: "aborted",
        },
      };
      const doneEvent: WsEvent = {
        type: "chat:done",
        payload: {
          conversationId: chatConversationId,
          projectId,
          taskId: taskId ?? null,
          runtimeProfileId: runtimeProfileId ?? null,
          runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
        },
      };
      if (clientId) {
        sendToClient(clientId, abortedEvent);
        sendToClient(clientId, doneEvent);
      }
      return c.json(
        {
          error: "Chat run aborted by user",
          code: "aborted",
          conversationId: chatConversationId,
          sessionId: chatSessionId,
          runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
          // Отдаём частичный ответ ассистента, чтобы клиенты без активного
          // WebSocket отрисовали сохранённое на сервере. Зеркалирует
          // `assistantMessage` успешного пути.
          assistantMessage: partial.length > 0 ? partial : null,
          // Эхо разрешённых сервером вложений, чтобы оптимистичный пузырёк
          // пользователя обновил чипы путями скачивания даже при прерывании.
          ...(savedAttachments?.length ? { attachments: savedAttachments } : {}),
        },
        409,
      );
    }

    refreshRuntimeProfileLimitState({
      runtimeProfileId,
      runtimeId,
      providerId: runtimeProviderId,
      snapshot: errorLimitSnapshot,
      clearOnMissing: false,
      taskId: taskId ?? null,
      projectId,
      conversationId: chatConversationId,
      workflowKind: "chat",
      reason: "chat:error",
    });
    const scrubbedErrorMessage =
      err instanceof Error
        ? redactProviderTextForLogs(err.message)
        : redactProviderTextForLogs(String(err));
    log.error(
      {
        runtimeId,
        runtimeProfileId,
        runtimeProviderId,
        conversationId: chatConversationId,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: scrubbedErrorMessage,
      },
      "Chat request failed",
    );
    const classified = classifyChatError(err);

    const errorEvent: WsEvent = {
      type: "chat:error",
      payload: {
        conversationId: chatConversationId,
        projectId,
        taskId: taskId ?? null,
        runtimeProfileId: runtimeProfileId ?? null,
        runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
        message: classified.message,
        code: classified.code,
      },
    };
    if (clientId) {
      sendToClient(clientId, errorEvent);
    }

    const doneEvent: WsEvent = {
      type: "chat:done",
      payload: {
        conversationId: chatConversationId,
        projectId,
        taskId: taskId ?? null,
        runtimeProfileId: runtimeProfileId ?? null,
        runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
      },
    };
    if (clientId) {
      sendToClient(clientId, doneEvent);
    }

    return c.json(
      {
        error: classified.message,
        code: classified.code,
        runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
      },
      classified.status,
    );
  } finally {
    activeChatRuns.delete(chatConversationId);
  }
});
