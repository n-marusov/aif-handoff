/**
 * Генерация пути к файлу плана и получение slug из заголовка задачи.
 *
 * Файл намеренно НЕ зависит от Node.js (нет node:path и node:fs): он импортируется и
 * браузерной сборкой через browser.ts, где Node-модулей быть не должно. Поэтому пути
 * склеиваются строками, а не через path.join.
 */

// Полный план - отдельный файл на задачу, быстрый - общий единый PLAN.md, который
// переиспользуется между задачами.
const DEFAULT_PLANS_DIR = ".ai-factory/plans/";
const DEFAULT_PLAN_PATH = ".ai-factory/PLAN.md";

// Таблица транслитерации кириллицы строится из кодов символов, чтобы избежать
// предупреждений о не-ASCII символах в исходнике.
// prettier-ignore
const TRANSLIT_PAIRS: [number, string][] = [
  [0x430, "a"],  [0x431, "b"],    [0x432, "v"],    [0x433, "g"],
  [0x434, "d"],  [0x435, "e"],    [0x451, "yo"],   [0x436, "zh"],
  [0x437, "z"],  [0x438, "i"],    [0x439, "y"],    [0x43a, "k"],
  [0x43b, "l"],  [0x43c, "m"],    [0x43d, "n"],    [0x43e, "o"],
  [0x43f, "p"],  [0x440, "r"],    [0x441, "s"],    [0x442, "t"],
  [0x443, "u"],  [0x444, "f"],    [0x445, "kh"],   [0x446, "ts"],
  [0x447, "ch"], [0x448, "sh"],   [0x449, "shch"], [0x44a, ""],
  [0x44b, "y"],  [0x44c, ""],     [0x44d, "e"],    [0x44e, "yu"],
  [0x44f, "ya"],
];

// Таблица собирается в Map один раз при загрузке модуля: транслитерация вызывается
// при каждом создании плана, и линейный поиск по массиву пар был бы лишней работой.
const TRANSLIT_MAP = new Map<string, string>(
  TRANSLIT_PAIRS.map(([code, latin]) => [String.fromCharCode(code), latin]),
);

function transliterate(text: string): string {
  return text
    .split("")
    .map((ch) => TRANSLIT_MAP.get(ch) ?? ch)
    .join("");
}

/**
 * Превращает заголовок в безопасный для URL и файловой системы slug: транслитерация
 * кириллицы в латиницу, приведение к нижнему регистру, замена всего постороннего на дефисы,
 * сжатие подряд идущих дефисов, обрезка краёв и усечение до 60 символов.
 */
export function slugify(title: string): string {
  // Порядок замен важен: сначала всё неподходящее превращается в дефис, затем
  // сжимаются подряд идущие дефисы, и только потом срезаются края. Обратный порядок
  // оставил бы дефис на границе строки.
  const slug = transliterate(title.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  if (slug) return slug;

  // Заголовок может не содержать ни букв, ни цифр (например, только знаки
  // пунктуации). Имя всё равно должно быть непустым и уникальным - берём время.
  return `plan-${Date.now()}`;
}

export interface GeneratePlanPathOptions {
  plansDir?: string;
  defaultPlanPath?: string;
}

/**
 * Строит путь к файлу плана по режиму планировщика и заголовку задачи.
 * - режим "full": возвращается `<plansDir>/<slug>.md`
 * - режим "fast" (и любой другой): возвращается `<defaultPlanPath>`
 */
export function generatePlanPath(
  title: string,
  mode: string,
  options?: GeneratePlanPathOptions,
): string {
  if (mode === "full") {
    const plansDir = options?.plansDir ?? DEFAULT_PLANS_DIR;
    const slug = slugify(title);
    // Слэш дописывается, если его нет: путь склеивается строками, а path.join здесь
    // недоступен, потому что модуль браузер-безопасный.
    const dir = plansDir.endsWith("/") ? plansDir : `${plansDir}/`;
    return `${dir}${slug}.md`;
  }
  return options?.defaultPlanPath ?? DEFAULT_PLAN_PATH;
}
