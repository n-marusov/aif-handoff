/**
 * Политика директивы о языке.
 *
 * По конфигу проекта `language.artifacts` + `language.technical_terms`
 * готовит компактную добавку к system prompt, предписывающую модели писать
 * артефакты (описания задач, планы, заметки ревью, сообщения коммитов,
 * ответы чата, пункты roadmap) на настроенном языке. Возвращает пустую
 * строку, когда директива не нужна (не задано, пусто или `en`), —
 * вызывающий может безопасно конкатенировать.
 *
 * Чистая функция, без I/O и логирования; место инъекции живёт в обёртке
 * реестра runtime, так что путь каждого адаптера получает её автоматически.
 */
/**
 * Директива о языке артефактов: текст, врезается в system prompt запуска.
 *
 * Модуль решает узкую, но коварную задачу: модель по умолчанию отвечает на
 * языке промпта и своих тренировочных данных, а артефакты (план, ревью, коммиты)
 * должны выходить на языке проекта. Настройка living в конфиге проекта, а
 * применение - в каждом рантайме, поэтому функция чистая и вызывается из
 * общего wrapper-реестра: один injection point покрывает все адаптеры,
 * и ни один из них не может «забыть» про язык.
 *
 * Пустая строка - не «нет директивы», а «директива не нужна»: англоязычный
 * проект не должен слать модели указание писать по-английски (шум и соблазн
 * переучиться). Вызывающий код конкатенирует результат безусловно, без
 * проверок на пустоту.
 */

// Вход нормализован вызывающим (Zod/env), но артефакты могут быть не заданы:
// null | undefined допустимы и означают «директивы нет». technicalTerms - закрытый
// союз, а не строка: ветвление в конце функции полное, и неизвестное значение
// не должно вести себя как «translate» из-за falsy-проверки.
export interface LanguageDirectiveInput {
  artifacts: string | null | undefined;
  technicalTerms: "keep" | "translate";
}

// Код языка -> человекочитаемое имя ДЛЯ ВСТАВКИ В ПРОМПТ (сам промпт англоязычный,
// поэтому имена English-first). Родной алфавит в скобках - не украшение: модель
// лучше держит целевой язык, когда видит его название на самом этом языке
// (русском языке, 中文) - это якорь против дрейфа в английский.
// Ключи - только основные субтэги BCP-47: региональные варианты разрешаются
// через primarySubtag, и словарь не обязан перечислять en-US, pt-BR и т.д.
const LANGUAGE_NAMES: Record<string, string> = {
  ru: "Russian (русском языке)",
  en: "English",
  fr: "French (français)",
  de: "German (Deutsch)",
  es: "Spanish (español)",
  pt: "Portuguese (português)",
  it: "Italian (italiano)",
  pl: "Polish (polski)",
  uk: "Ukrainian (українською)",
  tr: "Turkish (Türkçe)",
  zh: "Chinese (中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
};

// Разбор тега вида ru-RU / pt_BR: и дефис, и подчёркивание - законные
// разделители BCP-47-подобных тегов, split(/[-_]/, 1) берёт только первый
// фрагмент. Пустого результата у split с limit 1 не бывает, но доступ [0] к
// массиву - источник undefined для будущих изменений, и ?? "" - дешёвая страховка.
function primarySubtag(code: string): string {
  return code.toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

// Неизвестный код возвращается как есть: директива «write in swahili» полезна и
// без красивого имени, а вот молчаливый пустой подстановочный текст или падение
// сломали бы запуск из-за косметики. Фолбэк на сырой код - дешёвая тотальность
// функции без Try/Catch.
function resolveLanguageName(code: string): string {
  return LANGUAGE_NAMES[primarySubtag(code)] ?? code;
}

export function buildLanguageDirective(input: LanguageDirectiveInput): string {
  // Нормализация до сравнения: артефакты могли прийти с пробелами и в верхнем
  // регистре из UI-формы.
  const raw = (input.artifacts ?? "").trim().toLowerCase();
  // No-op не только для точного `en`, но и для любого BCP-47 тега, чей
  // основной подтег английский (`en-US`, `en_GB`, `en-x-private`, …). Без этого
  // региональные английские настройки всё равно впрыскивали бы директиву
  // «пиши по-английски» — это шум и введение в заблуждение
  // (таблица поиска строковала бы `en-US` как сырой тег).
  if (!raw || primarySubtag(raw) === "en") return "";

  const languageName = resolveLanguageName(raw);
  // Директива собирается списком строк, а не одним литералом: запрет
  // «только проза, смысл задачи не меняется» и хвост про технические токены -
  // отдельные правила, и их легче добавлять/переставлять пунктами.
  const lines = [
    "Language policy for all produced artifacts:",
    `- Write all generated artifacts — task descriptions, plans, review notes, commit messages, chat replies, and roadmap items — in ${languageName}.`,
    "- Apply this to free-form prose only; it does not change the meaning of the task.",
  ];

  // Две политики для technical tokens: keep - категоричный запрет перевода
  // (идентификаторы и пути ломаются при переводе), translate - мягкое
  // разрешение с оговоркой «иначе keep». Ветвление по закрытому союзу,
  // else == translate гарантирован типом.
  if (input.technicalTerms === "keep") {
    lines.push(
      "- Keep technical tokens in English: identifiers, API/function/class names, file paths, CLI flags, environment variables, code snippets, log strings, and error messages emitted by the code.",
    );
  } else {
    lines.push(
      "- Technical tokens may be translated where a natural equivalent exists; otherwise keep them verbatim.",
    );
  }

  // join("\n"): строки - уже готовые markdown-буллеты, join только склеивает.
  // Возврат строки (не массива) упрощает конкатенацию в systemPromptAppend.
  return lines.join("\n");
}
