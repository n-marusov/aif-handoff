/**
 * Мост от runtime-нейтральных колбэков к SDK-хукам Claude.
 *
 * Координатор передаёт onToolUse/onSubagentStart в универсальной сигнатуре
 * (имя инструмента + краткая сводка), а SDK ждёт HookCallback для событий
 * PostToolUse/SubagentStart со своим payload'ом. Модуль оборачивает одно в другое
 * и «оглупляет» недоверенный input до безопасных строк.
 *
 * Главное эксплуатационное правило: хуки выполняются внутри SDK-запроса, и их
 * исключение рвёт поток модели (в diagnostics.ts такой сбой узнаётся по фразе
 * "error in hook callback"). Поэтому мосты не бросают на грязных данных:
 * нераспознанный вход — пустой объект в ответ.
 */

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeSubagentStartCallback, RuntimeToolUseCallback } from "../../types.js";

// Вход сборки хуков: уже готовые SDK-колбэки (их подставляет вызывающий код) плюс
// два универсальных колбэка нашего контракта. Разделение важно: первые — «своя
// логика» потребителя, вторые — то, что нужно спроецировать в наблюдаемость.
export interface ClaudeHookOptions {
  postToolUseHooks?: HookCallback[];
  subagentStartHooks?: HookCallback[];
  onToolUse?: RuntimeToolUseCallback;
  onSubagentStart?: RuntimeSubagentStartCallback;
}

// Форма, которую понимает SDK: событие -> массив групп хуков. Группа — это
// объект с массивом hooks; массив нужен потому, что в SDK с хуком можно
// сопоставить matcher (фильтр по имени инструмента). Мы фильтр не задаём —
// группа без matcher срабатывает на все инструменты, что нам и нужно.
export interface ClaudeHooksPayload {
  PostToolUse?: Array<{ hooks: HookCallback[] }>;
  SubagentStart?: Array<{ hooks: HookCallback[] }>;
}

// Проверка «это plain-объект»: нужна, потому что input хука приходит как unknown
// и может быть массивом/примитивом; дальше по коду обращение к полям без такой
// проверки бросило бы в середине SDK-запроса.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Сводка для UI/логов: только суть действия, а не весь payload. JSON.stringify
// тут не годится по двум причинам: он шумный (у Read полстраницы одинаковых
// полей) и неограниченный по объёму — команда Bash может весить мегабайты.
// switch по имени инструмента даёт человеку именно то, что ему важно: какую
// команду запустили, какой файл читали/писали, какой шаблон искали.
function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput) return "";
  switch (toolName) {
    case "Bash": {
      // Обрезка до 200 символов: в ленте событий длинная команда всё равно не
      // прочитается, а место занимает; полный текст есть в самом tool_event'е.
      const cmd = String(toolInput.command ?? "")
        .trim()
        .slice(0, 200);
      return cmd ? ` \`${cmd}\`` : "";
    }
    case "Read":
    case "Write":
    case "Edit":
      return toolInput.file_path ? ` ${toolInput.file_path}` : "";
    case "Glob":
      return toolInput.pattern ? ` ${toolInput.pattern}` : "";
    case "Grep":
      return toolInput.pattern ? ` /${toolInput.pattern}/` : "";
    case "Agent": {
      const desc = toolInput.description ?? toolInput.subagent_type ?? "";
      return desc ? ` ${desc}` : "";
    }
    default:
      // Незнакомый инструмент не описан в списке — пустая сводка. Список имён
      // намеренно закрытый: добавлять сюда новые инструменты можно только вместе
      // с осмысленным форматом сводки, иначе в ленте появится мусор.
      return "";
  }
}

/** Оборачивает универсальный колбэк onToolUse в Claude SDK HookCallback для PostToolUse. */
function bridgeToolUseHook(onToolUse: RuntimeToolUseCallback): HookCallback {
  return async (input) => {
    // Шумный или неожиданный input — возвращаем {} и не зовём колбэк: пустая
    // сводка лучше упавшего рана, а разбираться в мусорном payload'е — задача не
    // этой функции.
    if (!isRecord(input)) return {};
    const data = input as Record<string, unknown>;
    // String() здесь — защита от нестроковых значений в payload'е: SDK должен
    // присылать строку, но невалидированный input может дать число/undefined, и
    // без приведения имя инструмента утеклю бы в логи как "undefined".
    const toolName = String(data.tool_name ?? "unknown");
    const toolInput = isRecord(data.tool_input) ? data.tool_input : undefined;
    onToolUse(toolName, summarizeToolInput(toolName, toolInput));
    return {};
  };
}

/** Оборачивает универсальный колбэк onSubagentStart в Claude SDK HookCallback для SubagentStart. */
function bridgeSubagentStartHook(onSubagentStart: RuntimeSubagentStartCallback): HookCallback {
  return async (input) => {
    if (!isRecord(input)) return {};
    const data = input as Record<string, unknown>;
    // SDK присылает agent_type (например "plan-coordinator") и agent_id
    // SDK в разных версиях кладёт имя субагента в разные поля; цепочка
    // фолбэков сохраняет узнаваемость в логах при апгрейде Agent SDK.
    const name = String(
      data.agent_type ?? data.agent_name ?? data.subagent_type ?? data.description ?? "unknown",
    );
    // id опционален так же, как имя: в старых версиях SDK его не было, и без
    // фолбэка в логах появилось бы "undefined" вместо пустоты.
    const id = String(data.agent_id ?? data.session_id ?? "");
    onSubagentStart(name, id);
    return {};
  };
}

export function buildClaudeHooks(options: ClaudeHookOptions): ClaudeHooksPayload | undefined {
  // Массивы копируются перед push: вызывающий может передать одно и то же
  // значение в несколько сборок, и мутация исходного массива была бы побочным
  // эффектом, которого от чистой сборки не ждут.
  const postToolUseHooks = [...(options.postToolUseHooks ?? [])];
  const subagentStartHooks = [...(options.subagentStartHooks ?? [])];

  if (options.onToolUse) {
    postToolUseHooks.push(bridgeToolUseHook(options.onToolUse));
  }
  if (options.onSubagentStart) {
    subagentStartHooks.push(bridgeSubagentStartHook(options.onSubagentStart));
  }

  const hooks: ClaudeHooksPayload = {};
  // Ключи появляются только при непустом списке: пустой массив в PostToolUse SDK
  // воспринял бы как «хуки есть, но их ноль» — лишняя работа внутри запроса.
  if (postToolUseHooks.length > 0) {
    hooks.PostToolUse = [{ hooks: postToolUseHooks }];
  }
  if (subagentStartHooks.length > 0) {
    hooks.SubagentStart = [{ hooks: subagentStartHooks }];
  }

  // undefined, а не {}: пустой объект заставил бы SDK считать, что хуки
  // сконфигурированы, и обрабатывать событие ради ничего; отсутствие ключа —
  // честное «здесь хуков нет», и options остаются минимальными.
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
