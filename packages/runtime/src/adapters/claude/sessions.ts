/**
 * Чтение истории сессий Claude Code через Agent SDK и её проекция на
 * runtime-нейтральные контракты RuntimeSession / RuntimeEvent.
 *
 * Сессии живут не в нашей БД, а в собственном хранилище CLI (JSONL в каталоге
 * ~/.claude); SDK даёт к ним доступ. Задача адаптера — не реплицировать историю,
 * а показывать её в едином виде, чтобы UI воспроизводил сессию любого рантайма
 * одними и теми же компонентами: список сессий, метаданные одной, лента событий.
 *
 * Данные приходят из файлов внешнего процесса, поэтому типы здесь — «честные
 * приближения»: индексы [key: string]: unknown, поля unknown, а каждое значение
 * проходит через оборонительные извлекатели. Смысл: следующий релиз SDK может
 * менять форму payload'а, и проекция обязана деградировать (null / пустая
 * строка), а не падать — просмотр истории не должен ронять приложение.
 *
 * Ошибки SDK не имеют структурированных полей: каждая выбрасываемая ошибка
 * проходит через classifyClaudeRuntimeError, наружу уходит структурированная
 * (category / adapterCode) — правило проекта о классификации ошибок.
 *
 * Порядок срезов limit осознанно разный: сессии режутся с головы (SDK отдаёт
 * отсортированный список), а события с хвоста — окну чата нужны последние
 * реплики, а не начало разговора.
 */

import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type {
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
// toolEvents и questions переиспользуются из «живого» пути: проекция вопросов
// должна быть одинаковой для потока выполнения и для повторного просмотра сессии,
// иначе одна и та же реплика выглядела бы в чате по-разному до и после перезапуска.
import { toolQuestionEvent } from "../../toolEvents.js";
import { classifyClaudeRuntimeError } from "./errors.js";
import { parseClaudeAskUserQuestion } from "./questions.js";

// Форма записи сессии из хранилища CLI. Обязательны фактически только sessionId и
// lastModified; остальное отсутствует в зависимости от версии CLI и типа сессии.
// Индексная сигнатура — не лень, а разрешение незнакомым будущим полям
// долетать до metadata.raw без правок типа.
interface ClaudeSessionSummary {
  sessionId: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
  createdAt?: string | number;
  lastModified: string | number;
  [key: string]: unknown;
}

// Сообщение журнала: type ("user"/"assistant"/служебные) плюс message в формате
// Anthropic Messages API — его содержимое разбирается оборонительно ниже.
interface ClaudeSessionMessage {
  uuid: string;
  type: string;
  message: unknown;
  createdAt?: string | number;
  [key: string]: unknown;
}

// Любое значение времени → валидная ISO-строка. Фолбэк — «сейчас», а не null:
// RuntimeEvent требует timestamp, и одно «висящее» событие без даты дешевле
// нарисовать как свежее, чем выкинуть из ленты или упасть с TypeError.
// try/catch здесь не косметика: new Date() бросает на части экзотических
// входов (например BigInt), а NaN-даты ловятся проверкой getTime.
function toIso(value: string | number | undefined): string {
  try {
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  } catch {
    // проваливаемся к значению по умолчанию
  }
  return new Date().toISOString();
}

// ЕДИНСТВЕННАЯ точка, где запись CLI становится RuntimeSession. Холостые поля
// заполняются константами не от бедности: runtimeId/providerId у этого адаптера
// не спрашивают — они всегда claude/anthropic; model остаётся null, потому что
// список сессий SDK модели не отдаёт, а выдумывать «предполагаемую модель» —
// значит подделать данные источника.
function mapClaudeSession(
  session: ClaudeSessionSummary,
  profileId: string | null | undefined,
): RuntimeSession {
  return {
    id: session.sessionId,
    runtimeId: "claude",
    providerId: "anthropic",
    profileId: profileId ?? null,
    model: null,
    // Цепочка заголовка = приоритет «что человек сам о сессии знал»: явная
    // кастомная title > автосводка > начало первого промпта (обрезано, чтобы
    // карточка не растянулась). Последний кандидат берётся из firstPrompt — у
    // сессий без сводок это единственная зацепка для узнавания.
    title: session.customTitle || session.summary || session.firstPrompt?.slice(0, 80) || null,
    // createdAt часто отсутствует у коротких сессий — тогда «возраст» судят по
    // lastModified: это хуже истинного создания, но лучше выдуманного сейчас.
    createdAt: toIso(session.createdAt ?? session.lastModified),
    // updatedAt — строго из lastModified: это единственное поле, которое SDK
    // документирует как обязательное, и только по нему можно надёжно сортировать.
    updatedAt: toIso(session.lastModified),
    // Оригинал сохраняется как есть: при разборе «почему UI показал не то»
    // источник истины — сырая запись CLI, а не наша проекция.
    metadata: {
      raw: session,
    },
  };
}

// Извлечение plain-text'а из сообщения Anthropic-формата. Исторически content —
// либо строка, либо массив блоков; обе формы валидны и встречаются в архивах
// разных лет, поэтому поддерживаются обе. Из блоков берётся только text:
// tool_use/thinking — не «реплика» и в ленту текста не просится (для tool_use
// вопросов есть отдельная проекция ниже). Пустой ответ — '' , а не null:
// вызывающий код проверяет длину, и «сообщение без текста» — штатная ситуация.
function extractTextContent(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;

  if (typeof record.content === "string") {
    return record.content;
  }
  if (!Array.isArray(record.content)) return "";

  const parts: string[] = [];
  for (const item of record.content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  // Блоки склеиваются двойным переводом: одиночный \n склеил бы отдельные
  // абзацы-assistant-а в простыню и потерял бы верстку исходного сообщения.
  return parts.join("\n\n").trim();
}

// Список сессий проекта. projectRoot обязателен: сессии Claude привязаны к
// каталогу, без него список не имеет смысла, и пустой ответ — честнее ошибки
// (пользователь ещё не выбрал проект — UI показывает пустую вкладку).
export async function listClaudeRuntimeSessions(
  input: RuntimeSessionListInput,
): Promise<RuntimeSession[]> {
  if (!input.projectRoot) {
    return [];
  }

  try {
    // Единственный допустимый источник — SDK: лезть в ~/.claude руками означало
    // бы привязаться к формату, который Anthropic меняет без предупреждения.
    // as-каст здесь — граница доверия к SDK: тип возврата объявлен широким, а
    // разбирать его предстоит нам. Каст снимает неудобство типизации, но НЕ
    // отменяет правило Nullable Cast — каждое поле по-прежнему проверяется
    // точечно в mapClaudeSession и toIso.
    const sessions = (await listSessions({ dir: input.projectRoot })) as ClaudeSessionSummary[];
    const mapped = sessions.map((session) => mapClaudeSession(session, input.profileId));
    // limit применяется уже к отпроекцированным записям: иначе «сколько показать»
    // зависело бы от того, сколько мусора отфильтрует маппер.
    return input.limit ? mapped.slice(0, input.limit) : mapped;
  } catch (error) {
    // Недоступный каталог сессий — это ошибка, а не пустой список: иначе UI
    // показал бы «сессий нет» там, где на самом деле сломан доступ к проекту.
    throw classifyClaudeRuntimeError(error);
  }
}

// Одна сессия по id. null здесь — штатный ответ «сессии нет» (её могли удалить
// из CLI-хранилища вручную), и вызывающий код различает «нет данных» и «сбой
// чтения» именно по null-vs-throw, поэтому заглушать ошибку пустым ответом
// нельзя.
export async function getClaudeRuntimeSession(
  input: RuntimeSessionGetInput,
): Promise<RuntimeSession | null> {
  try {
    // projectRoot не нужен: getSessionInfo работает по глобальному id сессии —
    // сведения о том, к какому проекту она относится, лежат в её метаданных.
    const info = (await getSessionInfo(input.sessionId)) as ClaudeSessionSummary | null;
    // null от SDK и null из-за отсутствия сессии для вызывающего одинаковы: оба
    // означают «такой сессии нет», и разделять их незачем.
    if (!info) return null;
    return mapClaudeSession(info, input.profileId);
  } catch (error) {
    // Ошибка чтения не прячется за null: UI обязан отличать «сессии нет» от
    // «хранилище недоступно», иначе будет показывать пустую историю там, где на
    // самом деле сломан доступ к файлам CLI.
    throw classifyClaudeRuntimeError(error);
  }
}

// Отдельная функция: message приходит из CLI-журнала, где assistant-ход может
// содержать tool_use блоки. Здесь они отбираются теми же правилами, что и в
// потоковом разборе, и превращаются в события через общий toolQuestionEvent.
// Каждая нераспознанная форма просто пропускается: отсутствующий вопрос не должен
// стоить всей ленты событий.
function extractAssistantToolQuestionEvents(
  message: ClaudeSessionMessage,
  timestamp: string,
): RuntimeEvent[] {
  const raw = message.message;
  if (!raw || typeof raw !== "object") return [];
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const events: RuntimeEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; name?: string; id?: string; input?: unknown };
    // Только tool_use со строковым именем — candidate; фильтр до парсера, чтобы
    // не тащить text/thinking блоки в разбор «вопрос это или нет».
    if (item.type !== "tool_use" || typeof item.name !== "string") continue;
    const toolUseId = typeof item.id === "string" ? item.id : null;
    // Парсер возвращает null для нерелевантных инструментов — тихий continue,
    // а не ошибка: большинство tool_use это Read/Edit/Bash, не вопросы.
    const payload = parseClaudeAskUserQuestion(item.name, toolUseId, item.input);
    if (!payload) continue;
    events.push(toolQuestionEvent(payload, timestamp));
  }
  return events;
}

// Лента событий сессии: сообщения user/assistant разворачиваются в
// session-message события, поверх — вопросы инструментов (см. комментарий в
// теле цикла). Профильный срез: сообщения иных типов (system, summary) в ленте
// не нужны — UI рисует диалог, а не служебный лог CLI.
export async function listClaudeRuntimeSessionEvents(
  input: RuntimeSessionEventsInput,
): Promise<RuntimeEvent[]> {
  try {
    const messages = (await getSessionMessages(input.sessionId)) as ClaudeSessionMessage[];
    const events: RuntimeEvent[] = [];

    for (const message of messages) {
      if (message.type !== "user" && message.type !== "assistant") continue;
      const timestamp = toIso(message.createdAt);
      const text = extractTextContent(message.message);

      // Пустые по тексту сообщения не создаются: техническая реплика без
      // содержимого (например, чисто tool_use ход) уже покрыта событием вопроса
      // ниже, и пустой «пузырь» в чате был бы только шумом.
      if (text.length > 0) {
        // Тип события "session-message" выбран нейтральным намеренно: это не
        // «реплика Claude», а сообщение сессии любого рантайма, и UI рисует его
        // одинаково для Claude, Codex и остальных.
        events.push({
          type: "session-message",
          timestamp,
          // Уровень всегда info: это часть диалога, а не диагностика; разделение
          // по важности тут не несёт смысла и только усложнило бы фильтры.
          level: "info",
          message: text,
          // role и id уезжают в data как есть — UI по ним отличает вопросы
          // пользователя от ответов и группирует подряд идущие реплики.
          data: {
            role: message.type,
            id: message.uuid,
          },
        });
      }

      // Реплики assistant могут содержать блок AskUserQuestion tool_use. Без
      // проекции таких блоков в tool:question события виртуальный/runtime-only
      // replay сессии (GET /chat/sessions/:id/messages для sdk:/runtime: id) те
      // терял бы вопрос целиком, если в реплике не было текста рядом.
      if (message.type === "assistant") {
        events.push(...extractAssistantToolQuestionEvents(message, timestamp));
      }
    }

    // См. шапку модуля: здесь limit берёт ХВОСТ (-limit), потому что история
    // прокручивается к последним репликам; начало диалога докрутится по запросу.
    return input.limit ? events.slice(-input.limit) : events;
  } catch (error) {
    // Как и в списке сессий: ошибка не глотается, а классифицируется — лента
    // событий это такой же пользовательский ресурс, и «пусто» вместо «ошибка»
    // выглядело бы как потерянная история.
    throw classifyClaudeRuntimeError(error);
  }
}
