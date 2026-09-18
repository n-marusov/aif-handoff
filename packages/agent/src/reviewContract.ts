/**
 * Контракт ревью: строгая форма вердикта, который выдает ревьюер.
 *
 * Вердикт - не свободный markdown, а фиксированный набор секций: каждая строка
 * разбирается регулярным выражением, и первое же несовпадение отбраковывает ответ
 * целиком (парсер возвращает null). Благодаря этому вызывающая сторона различает
 * "контракт соблюден" и "модель ответила не по формату" и может применить
 * разбор legacy-формата вместо того, чтобы молча принять мусор.
 *
 * Инварианты:
 * - Идентификаторы находок детерминированы: SHA-1 от источника и нормализованного
 *   текста. Одна и та же проблема получает один id на разных итерациях, иначе
 *   сопоставление resolved / still_blocking было бы невозможно.
 * - Парсер и форматер - две стороны одного контракта. Правка формата в
 *   buildStructured* без правки parseStructured* ломает round-trip, поэтому
 *   менять их можно только парой.
 * - Частичный успех не допускается: отсутствующая секция или нераспознанная
 *   строка - это null, а не "находок нет".
 *
 * Подводные камни:
 * - normalizeListSection имеет три исхода, и путать их нельзя: null - секция не в
 *   формате (отказ от контракта), [] - секция корректна и пуста.
 * - Список предыдущих находок сверяется с входным набором: новый id от модели или
 *   пропуск строки означают выдумку либо потерю и отбраковывают ответ.
 */

import { createHash } from "node:crypto";
import type {
  AutoReviewFinding,
  AutoReviewFindingSource,
  AutoReviewState,
  AutoReviewStrategy,
} from "@aif/shared";

// Статус нужен только для повторных итераций: находка прошлого прогона либо
// закрыта, либо признана все еще блокирующей. Третьего состояния нет, и текст вне
// этого словаря считается нарушением формата.
export type AutoReviewPreviousFindingStatus = "resolved" | "still_blocking";

// Предыдущая находка - это находка плюс вердикт по ней; note - короткое пояснение
// модели, почему статус именно такой.
export interface AutoReviewPreviousFinding extends AutoReviewFinding {
  status: AutoReviewPreviousFindingStatus;
  note: string;
}

// У совета нет идентификатора: он не влияет на блокировку и не отслеживается между
// итерациями, поэтому сопоставлять его не с чем.
export interface AutoReviewAdvisory {
  source: AutoReviewFindingSource;
  text: string;
}

// Разбор ответа одного сайдкара. Источник известен из контекста вызова (обзор кода
// или аудит безопасности), поэтому в самом разборе он не хранится, а проставляется
// каждой находке при разборе.
export interface ParsedStructuredSidecarOutput {
  blockingFindings: AutoReviewFinding[];
  advisories: AutoReviewAdvisory[];
  previousFindings: AutoReviewPreviousFinding[];
}

// Канонический вид, который сохраняется в задаче: к разбору сайдкара добавляются
// стратегия и номер итерации. Они берутся из секции метаданных, которую печатает
// buildStructuredReviewComments, а не выводятся из свободного текста модели.
export interface ParsedStructuredReviewComments {
  strategy: AutoReviewStrategy;
  iteration: number;
  blockingFindings: AutoReviewFinding[];
  advisories: AutoReviewAdvisory[];
  previousFindings: AutoReviewPreviousFinding[];
}

// Разбор идет построчно, а не одной регуляркой на весь документ: секции
// многострочные, а роль разделителя играет только заголовок верхнего уровня. Строки
// возвращаются сырыми, без трима: решать, валиден ли список, будет
// normalizeListSection.
function collectSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current) {
      sections.get(current)?.push(line);
    }
  }

  return sections;
}

// Три исхода, и они не взаимозаменяемы:
// - null - секции нет или она не сводится к списку пунктов (отказ от контракта);
// - [] - секция корректна, но пуста: только "- none" или полное отсутствие строк;
// - список строк - реальные пункты.
// Пустой массив - это законное "ничего не найдено", null - повод отбросить ответ
// целиком, поэтому возвращать null вместо [] нельзя.
function normalizeListSection(lines: string[] | undefined): string[] | null {
  if (!lines) return null;

  const normalized = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (normalized.length === 0) return [];
  if (normalized.every((line) => line.startsWith("- "))) {
    const items = normalized.map((line) => line.slice(2).trim());
    // Сентинел принимается только как единственный пункт: вперемешку с реальными
    // находками слово none означало бы, что формат не понят.
    if (items.length === 1 && items[0]?.toLowerCase() === "none") {
      return [];
    }
    // Пустой пункт или none среди настоящих пунктов - нарушение формата, а не
    // "почти валидный" ответ.
    if (items.some((item) => item.length === 0 || item.toLowerCase() === "none")) {
      return null;
    }
    return items;
  }

  return null;
}

// Приведение текста к одной строке. Нужно дважды: регулярки разбора рассчитаны на
// однострочные пункты, а хеш идентификатора не должен зависеть от переносов и
// кратных пробелов, иначе та же находка получит новый id.
export function normalizeFindingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Идентификатор детерминирован, потому что по нему находка прошлой итерации
// сопоставляется с новой. Регистр снимается, чтобы формулировка с заглавной буквы
// не порождала другой id, а длина урезана ради читаемости строк контракта.
export function createAutoReviewFindingId(source: AutoReviewFindingSource, text: string): string {
  const normalized = `${source}:${normalizeFindingText(text).toLowerCase()}`;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

// Сентинел "- none" здесь не косметика: normalizeListSection понимает его как
// валидную пустоту. Если не напечатать секцию вовсе, модель может решить, что
// рассказывать про прошлые находки не требуется.
export function formatPreviousFindingsForPrompt(
  findings: AutoReviewFinding[],
  source?: AutoReviewFindingSource,
): string {
  const filtered = source ? findings.filter((finding) => finding.source === source) : findings;
  if (filtered.length === 0) {
    return "- none";
  }

  return filtered.map((finding) => `- [${finding.id}] ${finding.text}`).join("\n");
}

// Строгий разбор ответа сайдкара. Любое отклонение - нет секции, строка не по
// формату, неизвестный id - дает null. Частично принятый вердикт опаснее отказа:
// неполный список блокирующих находок выглядит как успешное ревью.
export function parseStructuredSidecarOutput(
  resultText: string,
  source: AutoReviewFindingSource,
  previousFindingsInput: AutoReviewFinding[] = [],
): ParsedStructuredSidecarOutput | null {
  // Отсутствие секции Previous Findings трактуется как пустой список (подстановка
  // []), а отсутствие остальных секций - как отказ: на первом ревью предыдущих
  // находок нет вовсе, и это нормальный случай.
  const sections = collectSections(resultText);
  const blockingItems = normalizeListSection(sections.get("Blocking Findings"));
  const advisoryItems = normalizeListSection(sections.get("Advisories"));
  const previousItems = normalizeListSection(sections.get("Previous Findings") ?? []);

  if (!blockingItems || !advisoryItems || previousItems === null) {
    return null;
  }

  const previousFindings: AutoReviewPreviousFinding[] = [];
  const previousFindingMap = new Map(previousFindingsInput.map((finding) => [finding.id, finding]));
  // Каноническая строка предыдущей находки здесь короче: источник известен из
  // контекста вызова, поэтому в самой строке его нет.
  for (const item of previousItems) {
    const match = item.match(/^\[([^\]]+)\]\s+(resolved|still_blocking)\s+\|\s+(.+)$/);
    if (!match) {
      return null;
    }
    const matchedFinding = previousFindingMap.get(match[1]);
    if (!matchedFinding && previousFindingsInput.length > 0) {
      return null;
    }
    previousFindings.push({
      id: match[1],
      source: matchedFinding?.source ?? source,
      status: match[2] as AutoReviewPreviousFindingStatus,
      note: normalizeFindingText(match[3]),
      text: normalizeFindingText(match[3]),
    });
  }

  // Соответствие должно быть один-к-одному: пропущенная строка означала бы
  // молчаливое закрытие находки, продублированная - неоднозначный статус.
  if (
    previousFindingsInput.length > 0 &&
    previousFindings.length !== previousFindingsInput.length
  ) {
    return null;
  }

  return {
    blockingFindings: blockingItems.map((item) => ({
      id: createAutoReviewFindingId(source, item),
      text: normalizeFindingText(item),
      source,
    })),
    advisories: advisoryItems.map((item) => ({
      source,
      text: normalizeFindingText(item),
    })),
    previousFindings,
  };
}

// Канонические форматеры - единственный источник правды о формате строк. Парсеры
// обязаны принимать ровно то, что печатают эти функции, и ничего кроме.
function formatCanonicalPreviousFindingLine(finding: AutoReviewPreviousFinding): string {
  return `- [${finding.id}] ${finding.source} | ${finding.status} | ${finding.note}`;
}

function formatCanonicalBlockingFindingLine(finding: AutoReviewFinding): string {
  return `- [${finding.id}] ${finding.source} | ${finding.text}`;
}

function formatCanonicalAdvisoryLine(advisory: AutoReviewAdvisory): string {
  return `- ${advisory.source} | ${advisory.text}`;
}

// Сборка канонического комментария из разборов обоих сайдкаров. Свежие
// блокирующие находки имеют приоритет над восстановленными из прошлой итерации:
// у них актуальная формулировка.
export function buildStructuredReviewComments(input: {
  strategy: AutoReviewStrategy;
  iteration: number;
  codeReview: ParsedStructuredSidecarOutput;
  securityAudit: ParsedStructuredSidecarOutput;
  rawCodeReview: string;
  rawSecurityAudit: string;
}): string {
  const previousFindings = [
    ...input.codeReview.previousFindings,
    ...input.securityAudit.previousFindings,
  ];
  const advisories = [...input.codeReview.advisories, ...input.securityAudit.advisories];
  // Накопитель по id: id включает источник, поэтому похожие по смыслу находки
  // разных сайдкаров остаются раздельными, а повторы внутри одного источника
  // схлопываются.
  const blockingMap = new Map<string, AutoReviewFinding>();

  // Незакрытые находки прошлой итерации возвращаются в блокирующие: снять
  // блокировку может только явный статус resolved.
  for (const finding of previousFindings) {
    if (finding.status !== "still_blocking") continue;
    blockingMap.set(finding.id, {
      id: finding.id,
      source: finding.source,
      text: finding.note,
    });
  }

  // Обход идет вторым: свежая находка перезаписывает восстановленную из прошлой
  // итерации, подменяя устаревшее note актуальным текстом.
  for (const finding of [
    ...input.codeReview.blockingFindings,
    ...input.securityAudit.blockingFindings,
  ]) {
    blockingMap.set(finding.id, finding);
  }

  const blockingFindings = [...blockingMap.values()];

  // Заголовки секций - это ключи, по которым работает collectSections, а не
  // оформление: переименование любой строки "## ..." сломает разбор.
  const lines = [
    "## Auto Review Metadata",
    `- Strategy: ${input.strategy}`,
    `- Review Iteration: ${input.iteration}`,
    "",
    "## Previous Findings",
    ...(previousFindings.length > 0
      ? previousFindings.map(formatCanonicalPreviousFindingLine)
      : ["- none"]),
    "",
    "## Blocking Findings",
    ...(blockingFindings.length > 0
      ? blockingFindings.map(formatCanonicalBlockingFindingLine)
      : ["- none"]),
    "",
    "## Advisories",
    ...(advisories.length > 0 ? advisories.map(formatCanonicalAdvisoryLine) : ["- none"]),
    "",
    "## Raw Code Review",
    input.rawCodeReview.trim() || "No code review output.",
    "",
    "## Raw Security Audit",
    input.rawSecurityAudit.trim() || "No security audit output.",
  ];

  return lines.join("\n");
}

// Обратная операция: разбор уже сохраненного комментария. Нужна после перезапуска
// процесса, когда исходных ответов сайдкаров и их разборов уже нет, а состояние
// авторевью восстановить надо.
export function parseStructuredReviewComments(
  reviewComments: string | null,
): ParsedStructuredReviewComments | null {
  const normalizedComments = reviewComments?.trim();
  if (!normalizedComments) return null;

  const sections = collectSections(normalizedComments);
  const metadataLines = normalizeListSection(sections.get("Auto Review Metadata"));
  const blockingItems = normalizeListSection(sections.get("Blocking Findings"));
  const advisoryItems = normalizeListSection(sections.get("Advisories"));
  const previousItems = normalizeListSection(sections.get("Previous Findings"));

  if (!metadataLines || !blockingItems || !advisoryItems || previousItems === null) {
    return null;
  }

  const strategyLine = metadataLines.find((line) => line.startsWith("Strategy: "));
  const iterationLine = metadataLines.find((line) => line.startsWith("Review Iteration: "));
  if (!strategyLine || !iterationLine) {
    return null;
  }

  const strategy = strategyLine.slice("Strategy: ".length).trim();
  // Словарь стратегий закрыт: значение влияет на ветвление логики авторевью,
  // поэтому неизвестное значение - признак чужого формата, а не повод угадывать.
  if (strategy !== "full_re_review" && strategy !== "closure_first") {
    return null;
  }

  const iteration = Number.parseInt(iterationLine.slice("Review Iteration: ".length).trim(), 10);
  // Номер итерации считается с единицы: ноль или мусор означают, что метаданные
  // писало не наше ревью.
  if (!Number.isFinite(iteration) || iteration < 1) {
    return null;
  }

  const previousFindings: AutoReviewPreviousFinding[] = [];
  // Здесь источник указан в самой строке, поэтому регулярка строже сайдкарной:
  // дополнительно проверяется, что источник входит в известный словарь.
  for (const item of previousItems) {
    const match = item.match(
      /^\[([^\]]+)\]\s+(code_review|security_audit|review_gate)\s+\|\s+(resolved|still_blocking)\s+\|\s+(.+)$/,
    );
    if (!match) {
      return null;
    }
    previousFindings.push({
      id: match[1],
      source: match[2] as AutoReviewFindingSource,
      status: match[3] as AutoReviewPreviousFindingStatus,
      note: normalizeFindingText(match[4]),
      text: normalizeFindingText(match[4]),
    });
  }

  const blockingFindings: AutoReviewFinding[] = [];
  // Тот же словарь источников, что и у прошлых находок: id и источник должны
  // разбираться одинаково, иначе находка потеряет связь с прошлой итерацией.
  for (const item of blockingItems) {
    const match = item.match(
      /^\[([^\]]+)\]\s+(code_review|security_audit|review_gate)\s+\|\s+(.+)$/,
    );
    if (!match) {
      return null;
    }
    blockingFindings.push({
      id: match[1],
      source: match[2] as AutoReviewFindingSource,
      text: normalizeFindingText(match[3]),
    });
  }

  const advisories: AutoReviewAdvisory[] = [];
  // У совета нет префикса с id: он не переживает итерации, и связывать его не с
  // чем, поэтому формат строки проще.
  for (const item of advisoryItems) {
    const match = item.match(/^(code_review|security_audit|review_gate)\s+\|\s+(.+)$/);
    if (!match) {
      return null;
    }
    advisories.push({
      source: match[1] as AutoReviewFindingSource,
      text: normalizeFindingText(match[2]),
    });
  }

  return {
    strategy,
    iteration,
    blockingFindings,
    advisories,
    previousFindings,
  };
}

// Проекция разбора в состояние, которое хранится в задаче. Отдельная функция
// развязывает форму промежуточного разбора и форму персистентного состояния:
// менять их можно независимо.
export function toAutoReviewState(input: {
  strategy: AutoReviewStrategy;
  iteration: number;
  findings: AutoReviewFinding[];
}): AutoReviewState {
  return {
    strategy: input.strategy,
    iteration: input.iteration,
    findings: input.findings,
  };
}
