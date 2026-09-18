/**
 * Разбор инструмента AskUserQuestion в runtime-нейтральный payload события
 * tool:question.
 *
 * Диалог вопроса в UI должен выглядеть одинаково для любого рантайма, и каждый
 * адаптер держит знание о формате своего провайдера в одном месте — вот в этом
 * файле. Всё, что находится за его пределами, видит только {questions, options,
 * header, multiSelect} и не знает, что под ним был Claude.
 *
 * Вход — недоверенный payload из потока SDK (тип unknown), поэтому парсер не
 * бросает: не та структура — null, и вызывающий код нарисует обычное событие
 * tool:use. Принцип «не додумывать»: отсутствующие поля остаются undefined, а не
 * превращаются в пустые строки/значения по умолчанию — UI сам решит, как показать
 * пробел в данных.
 */

import type { RuntimeToolQuestionPayload } from "../../types.js";

/**
 * Разбирает input инструмента `AskUserQuestion` у Claude в runtime-нейтральную
 * форму `RuntimeToolQuestionPayload`. Возвращает `null`, когда input не содержит
 * хотя бы одного вопроса — вызывающий должен откатиться к обычному
 * событию `tool:use`.
 *
 * Input AskUserQuestion у Claude выглядит так:
 *   { questions: [{ question, header?, multiSelect?, options: [{ label, description? }] }] }
 *
 * Некоторые старые варианты передают `{ question, options }` на верхнем уровне; оба
 * принимаются здесь, чтобы событие runtime оставалось стабильным между версиями SDK/CLI.
 *
 * Адаптеры других провайдеров (Codex, OpenRouter, будущие runtime) должны
 * реализовать собственную функцию-парсер с той же формой payload и передавать
 * результат в runtime-нейтральный хелпер `buildToolUseEvents`.
 */
export function parseClaudeAskUserQuestion(
  toolName: string,
  toolUseId: string | null,
  input: unknown,
): RuntimeToolQuestionPayload | null {
  if (toolName !== "AskUserQuestion") return null;
  // Приведение unknown к объекту — первый шаг любого парсера недоверенного ввода;
  // record остаётся null, и дальше проверка на него — часть контракта «не бросаем».
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!record) return null;

  // Два исторически живых формата: массив questions (современный) и одиночный
  // объект с полями верхнего уровня (ранние варианты). Оборачивание record'а в
  // массив даёт единый путь обработки внизу и сохраняет рисуемость архивных сессий.
  // Фильтр по объектности — до нормализации: дальше код работает со структурой, а
  // не с «может быть».
  const rawQuestions: Record<string, unknown>[] = Array.isArray(record.questions)
    ? (record.questions as unknown[]).filter(
        (entry): entry is Record<string, unknown> => entry != null && typeof entry === "object",
      )
    : [record];

  const questions = rawQuestions
    .map((entry) => normalizeQuestion(entry))
    // type predicate (entry is ...) обязателен: без него TS не выведет, что null'ы
    // отфильтрованы, и массив остался бы (T | null)[].
    .filter((entry): entry is RuntimeToolQuestionPayload["questions"][number] => entry !== null);

  // Пустой список — сигнал «событие вопроса не состоялось»: нет ни одной
  // пригодной к показу части. null вместо пустого payload'а заставляет вызывающий
  // код откатиться к обычному tool:use, что и есть правильное поведение.
  if (questions.length === 0) return null;

  return {
    toolUseId,
    toolName,
    // Список уже отфильтрован от мусора: сюда попадают только вопросы, у которых
    // есть хотя бы текст или опции; пустые записи отсеяны выше.
    questions,
  };
}

// Нормализация одного вопроса. Текст берётся из question или, для старых
// форматов, из prompt: поле переименовали, а читать архив надо. Опции могут
// отсутствовать (вопрос-констатация) — это не причина выкидывать запись;
// выкидывается она только когда нет ни текста, ни опций.
function normalizeQuestion(
  record: Record<string, unknown>,
): RuntimeToolQuestionPayload["questions"][number] | null {
  const question =
    (typeof record.question === "string" && record.question) ||
    (typeof record.prompt === "string" && record.prompt) ||
    null;
  const rawOptions = Array.isArray(record.options) ? (record.options as unknown[]) : [];
  const options = rawOptions
    .map((entry) => normalizeOption(entry))
    // Тот же приём с type predicate, что и на уровне вопросов: чистим null'ы так,
    // чтобы тип стал массивом реальных опций.
    .filter(
      (entry): entry is RuntimeToolQuestionPayload["questions"][number]["options"][number] =>
        entry !== null,
    );
  if (!question && options.length === 0) return null;
  return {
    // question приводится к строке, потому что контракт payload'а её требует;
    // пустая строка здесь означает «вопрос без формулировки, только набор опций».
    question: question ?? "",
    // header и multiSelect не дефолтятся (никаких false/"") — это опциональные
    // подсказки UI, и «поля нет» должно остаться отличимым от «поле пустое».
    header: typeof record.header === "string" ? record.header : undefined,
    multiSelect: typeof record.multiSelect === "boolean" ? record.multiSelect : undefined,
    options,
  };
}

// Опция бывает и голой строкой (старый формат), и объектом; для строки
// превращение тривиально, а для объекта поле с меткой перебирается по всем
// известным именам (label/title/value/text) — у разных версий SDK оно звалось
// по-разному. Опция без распознанной метки не имеет смысла: рисовать кнопку без
// текста нельзя, поэтому null.
function normalizeOption(
  entry: unknown,
): RuntimeToolQuestionPayload["questions"][number]["options"][number] | null {
  if (typeof entry === "string") {
    return { label: entry };
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const label =
      (typeof record.label === "string" && record.label) ||
      (typeof record.title === "string" && record.title) ||
      (typeof record.value === "string" && record.value) ||
      (typeof record.text === "string" && record.text) ||
      null;
    if (!label) return null;
    return {
      label,
      description: typeof record.description === "string" ? record.description : undefined,
    };
  }
  return null;
}
