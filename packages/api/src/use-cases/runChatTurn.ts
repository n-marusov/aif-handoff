/**
 * Application use case «выполнить ход чата».
 *
 * Весь жизненный цикл одной реплики чата: выбор профиля и адаптера,
 * переиспользование/создание runtime-сессии, стриминг дельт, персистенция
 * сообщений в БД, учёт usage и обработка прерывания. Маршрут остаётся тонким
 * контроллером: парсит тело запроса, инжектирует WS-порты (sendToClient /
 * broadcast) и формирует HTTP-ответ из результата.
 *
 * Транспортных понятий (Hono, hono Context) здесь нет — WebSocket доставляется
 * через порты, а ответ возвращается { status, body } с чистым JSON.
 *
 * Смысловые правила (почему код устроен так):
 * - Ответ идёт двумя каналами: JSON в HTTP-ответе и delta-события в WS. Оба
 *   обязаны описывать один и тот же текст, поэтому фрагменты накапливаются в
 *   assistantSegments и только затем отдаются наружу.
 * - Рантайм может оборвать поток: часть текста приходит дельтами, часть
 *   остаётся в result.outputText, а вопросы (AskUserQuestion) приходят
 *   отдельными событиями. Порядок "текст -> вопрос -> текст" восстанавливается
 *   вручную, а не берётся из порядка событий.
 * - AbortController регистрируется ДО любой медленной работы: иначе Stop,
 *   нажатый в первые сотни миллисекунд, попадал бы в 404, а запуск продолжал
 *   бы работать вхолостую.
 * - Ошибки рантайма не отдаются клиенту как есть: текст провайдера
 *   редактируется, наружу уходит только классификация по структурным полям.
 */
import crypto from "node:crypto";
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
  toChatSessionResponse,
  toRuntimeProfileResponse,
  toTaskResponse,
  type ChatMessageAttachment,
  type ChatSession,
  type ChatSessionMessage,
  type Task,
  type WsEvent,
} from "@aif/shared";
import {
  createChatMessage,
  createChatSession,
  findChatSessionById,
  findCodexSessionFilePathBySessionId,
  findProjectById,
  findRuntimeProfileById,
  findTaskById,
  updateChatSession,
  updateChatSessionTimestamp,
} from "@aif/data";
import { persistAttachments } from "../services/attachmentPersistence.js";
import { invalidateCache, sessionCacheKey } from "../services/sessionCache.js";
import {
  assertApiRuntimeCapabilities,
  extractLatestRuntimeLimitSnapshot,
  extractRuntimeLimitSnapshotFromError,
  getApiRuntimeRegistry,
  observeRuntimeLimitEvent,
  refreshRuntimeProfileLimitState,
  resolveApiRuntimeContext,
} from "../services/runtime.js";
import type { TaskAttachmentInput } from "./types.js";

const log = logger("chat-run-use-case");
// Отдельное имя для логов, которые читает UI рантайма: по нему сообщения
// фильтруются в панели активности.
const API_RUNTIME_LOG = "api-runtime";

// ── Промптовые константы и helpers чата ──────────────────────────────────────

// Границу проекта задаем текстом системного промпта, а не фильтрацией на
// стороне API: рантайм сам решает, какие пути читать.
const PROJECT_SCOPE_SYSTEM_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

// UI не умеет отвечать на интерактивный инструмент внутри одного хода.
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

// Возвращает null, когда рендерить нечего: пустой блок лучше не показывать.
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
// подтверждения.
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
export function buildContextAppend(
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

// Идентификаторы рантаймов сравниваем в нормализованном виде.
function normalizeRuntimeId(value: string): string {
  return value.trim().toLowerCase();
}

const CODEX_RUNTIME_ID = "codex";

export function isLocalCodexRuntimeId(runtimeId: string): boolean {
  return normalizeRuntimeId(runtimeId) === CODEX_RUNTIME_ID;
}

export { parseVirtualRuntimeSessionId, formatVirtualRuntimeSessionId, runtimeSourceFromTransport };

// Схема виртуального id: "sdk:<id>" для единого SDK-транспорта и
// "runtime:<runtimeId>:<sessionId>" для остальных.
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
// берется из окружения.
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

// Санитизация входа с учётом runtime: adapter.sanitizeInput, если доступен.
function sanitizeRuntimeInput(text: string, adapter?: RuntimeAdapter): string {
  return adapter?.sanitizeInput ? adapter.sanitizeInput(text) : text.trim();
}

/**
 * Убирает блок "Attached files:", дописываемый к пользовательским промптам.
 */
function stripAttachedFilesBlock(text: string): string {
  const idx = text.indexOf("\n\n---\nAttached files:\n");
  return idx !== -1 ? text.slice(0, idx) : text;
}

/**
 * Извлекает человекочитаемый текст из полезной нагрузки сообщений.
 */
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

// Роль не приходит отдельным полем события - она лежит внутри data.
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

// Идентификатор должен быть стабильным между запросами.
function eventId(event: RuntimeEvent): string {
  const data = event.data;
  if (data && typeof data === "object") {
    if (typeof data.id === "string" && data.id) {
      return data.id;
    }
    if (event.type === "tool:question" && typeof data.toolUseId === "string" && data.toolUseId) {
      return `tool:question:${data.toolUseId}`;
    }
  }
  return crypto.randomUUID();
}

// Преобразование событий рантайма в сообщения чата.
export function mapRuntimeEventsToChatMessages(
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

// Быстрый путь для Codex: сессия восстанавливается из локального индекса.
export async function loadIndexedCodexVirtualSession(input: {
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

// То же самое для сообщений: null здесь - сигнал откатиться на адаптер.
export async function loadIndexedCodexRuntimeMessages(input: {
  runtimeSessionId: string;
  chatSessionId: string;
  limit?: number;
}): Promise<ChatSessionMessage[] | null> {
  const filePath = findCodexSessionFilePathBySessionId(input.runtimeSessionId);
  if (!filePath) return null;
  const runtimeEvents = await readCodexSessionEventsFromFile(filePath, {
    limit: input.limit,
  });
  return mapRuntimeEventsToChatMessages(runtimeEvents, input.chatSessionId);
}

// Прерывание может быть обернуто: проверяем name, code и рекурсивно cause.
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const asError = err as { name?: string; code?: string; cause?: unknown };
  if (asError.name === "AbortError") return true;
  if (asError.code === "ABORT_ERR") return true;
  if (asError.cause) return isAbortError(asError.cause);
  return false;
}

// Классификация ошибки без разбора текста сообщения.
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

// Снимок лимитов показываем только при включенной фиче.
function normalizeOptionalRuntimeLimitSnapshot(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): RuntimeLimitSnapshot | null {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return null;
  return snapshot ? sanitizeRuntimeLimitSnapshotForExposure(snapshot, "chat") : null;
}

// Ответ ассистента хранится не одной строкой, а последовательностью сегментов.
type AssistantSegment = {
  type: "text" | "question";
  content: string;
};

// Соседние текстовые дельты склеиваются в один сегмент.
function mergeAdjacentTextSegment(segments: AssistantSegment[], text: string): void {
  if (!text) return;
  const last = segments.at(-1);
  if (last?.type === "text") {
    last.content += text;
    return;
  }
  segments.push({ type: "text", content: text });
}

// Ищем наибольшее перекрытие суффикса left и префикса right.
function longestOverlapSuffixPrefix(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let len = max; len > 0; len -= 1) {
    if (left.endsWith(right.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

// Сопоставляет фактический текст ответа (outputText) со стримом дельт.
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

// Нормализует строку содержимого перед сопоставлением.
function normalizeContentForMatch(content: string): string {
  return content.trim();
}

// Сводим историю из рантайма и из БД в один список.
export function mergeRuntimeAndDbMessages(
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

// Спецификация workflow для чата.
function buildChatRuntimeWorkflow(prompt: string, systemPromptAppend: string) {
  return createRuntimeWorkflowSpec({
    workflowKind: "chat",
    prompt,
    requiredCapabilities: [],
    sessionReusePolicy: "resume_if_available",
    systemPromptAppend,
  });
}

// Общий путь резолва для всех чат-эндпоинтов.
export async function resolveChatRuntimeAdapter(
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

// Адаптер резолвится по runtimeId для операций над уже существующей сессией.
export async function getAdapterForRuntimeId(runtimeId: string): Promise<RuntimeAdapter> {
  const registry = await getApiRuntimeRegistry();
  return registry.resolveRuntime(runtimeId);
}

// Параметры, нужные адаптеру для доступа к чужой сессии.
interface RuntimeSessionLookupContext {
  providerId: string;
  profileId: string | null;
  runtimeProfileId: string | null;
  transport: string | null;
  projectRoot?: string;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

// Пустая строка и отсутствие параметра равнозначны.
export function parseOptionalQueryParam(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Собираем options только из заданных полей.
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

// Приоритет источников: сначала явно указанный профиль, затем профиль проекта.
export async function resolveVirtualSessionLookupContext(input: {
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

// ── Активные запуски и порты ─────────────────────────────────────────────────

/**
 * Реестр AbortController по каждой беседе. Заполняется перед отправкой
 * вызова run/resume рантайма и очищается после завершения хода. Эндпоинт
 * abort находит контроллер по conversationId и вызывает .abort().
 */
const activeChatRuns = new Map<string, AbortController>();

/**
 * Прерывание активного хода по id беседы. Возвращает true, если контроллер
 * был найден и прерван; false — если ход уже завершён или неизвестен.
 */
export function abortChatRun(conversationId: string): boolean {
  const controller = activeChatRuns.get(conversationId);
  if (!controller) {
    log.debug(
      { conversationId },
      "[chat-run] abort requested for unknown or completed conversation",
    );
    return false;
  }
  controller.abort();
  activeChatRuns.delete(conversationId);
  log.info({ conversationId }, "INFO [chat-run] Chat run aborted by user");
  return true;
}

// ── runChatTurn ───────────────────────────────────────────────────────────────

/** WebSocket-порты: доставка конкретному клиенту и широковещательная рассылка. */
export interface RunChatTurnPorts {
  sendToClient(clientId: string, event: WsEvent): void;
  broadcast(event: WsEvent): void;
}

/** Вход хода чата: транспортно-нейтральные поля запроса. */
export interface RunChatTurnInput {
  projectId: string;
  message: string;
  clientId?: string | null;
  conversationId?: string | null;
  explore?: boolean | null;
  taskId?: string | null;
  attachments?: TaskAttachmentInput[];
  inputSessionId?: string | null;
}

/** Результат хода: HTTP-статус + чистое JSON-тело для ответа. */
export interface RunChatTurnResult {
  status: number;
  conversationId: string;
  body: Record<string, unknown>;
}

/**
 * Единственная точка входа: выполняет ход чата с инжектированными WS-портами
 * и возвращает { status, body } для формирования HTTP-ответа маршрутом.
 */
export async function runChatTurn(
  input: RunChatTurnInput,
  ports: RunChatTurnPorts,
): Promise<RunChatTurnResult> {
  const { projectId, message, clientId, conversationId, explore, taskId, attachments } = input;
  let { inputSessionId } = input;
  const env = getEnv();

  // Регистрируем AbortController ДО любой медленной работы (поиск проекта,
  // разрешение профиля, автосоздание сессии). Это закрывает окно, когда ранний
  // клик Stop клиент присылал в `/abort` и получал 404, потому что контроллера
  // ещё не было, а запрос продолжал выполняться.
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
  // связать DB-сессию чата с runtime-сессией даже когда запуск так и не завершился.
  let runtimeSessionIdFromEvents: string | null = null;
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  // Вынесены наверх, чтобы ветка abort могла показать клиенту разрешённые
  // сервером пути вложений.
  let savedAttachments: ChatMessageAttachment[] | undefined;

  try {
    const project = findProjectById(projectId);
    if (!project) {
      return {
        status: 404,
        conversationId: chatConversationId,
        body: { error: "Project not found" },
      };
    }

    // Разрешение текущей открытой задачи для внедрения контекста.
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

    // Внешние runtime-сессии виртуальны — создаём DB-сессию, привязанную к runtime-сессии.
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
        ports.broadcast({ type: "chat:session_created", payload: toChatSessionResponse(session) });
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
        ports.broadcast({ type: "chat:session_created", payload: toChatSessionResponse(session) });
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

    // Сохраняем вложения-файлы на диск и собираем промпт с путями.
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
      ports.sendToClient(clientId, tokenEvent);
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

      // Захватываем id сессии рантайма сразу, как адаптер его выдаёт.
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
        "[chat-run] Persisted runtime session link",
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

    // Восстанавливаем текст ассистента, который так и не пришёл delta-ми.
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

    // Сохраняем каждый упорядоченный сегмент ассистента отдельно.
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
        // токенов/стоимости без похода к таблице usage_events.
        usage: result.usage ?? null,
      },
    };
    if (clientId) {
      ports.sendToClient(clientId, doneEvent);
    }

    return {
      status: 200,
      conversationId: chatConversationId,
      body: {
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
      },
    };
  } catch (err) {
    const errorLimitSnapshot = extractRuntimeLimitSnapshotFromError(err);
    const normalizedErrorLimitSnapshot = normalizeOptionalRuntimeLimitSnapshot(errorLimitSnapshot);
    const aborted = abortController.signal.aborted || isAbortError(err);
    if (aborted) {
      // Сохраняем все токены, отправленные до прерывания, чтобы частичный
      // ответ ассистента пережил перезагрузку.
      const partial = fullAssistantResponse.trim();
      if (chatSessionId && partial) {
        createChatMessage({ sessionId: chatSessionId, role: "assistant", content: partial });
        updateChatSessionTimestamp(chatSessionId);
      }
      // Привязываем DB-сессию чата к runtime-сессии, которую адаптер успел
      // запустить до прерывания.
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
        "INFO [chat-run] Chat run aborted",
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
        ports.sendToClient(clientId, abortedEvent);
        ports.sendToClient(clientId, doneEvent);
      }
      return {
        status: 409,
        conversationId: chatConversationId,
        body: {
          error: "Chat run aborted by user",
          code: "aborted",
          conversationId: chatConversationId,
          sessionId: chatSessionId,
          runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
          assistantMessage: partial.length > 0 ? partial : null,
          ...(savedAttachments?.length ? { attachments: savedAttachments } : {}),
        },
      };
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
      ports.sendToClient(clientId, errorEvent);
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
      ports.sendToClient(clientId, doneEvent);
    }

    return {
      status: classified.status,
      conversationId: chatConversationId,
      body: {
        error: classified.message,
        code: classified.code,
        runtimeLimitSnapshot: normalizedErrorLimitSnapshot,
      },
    };
  } finally {
    activeChatRuns.delete(chatConversationId);
  }
}
