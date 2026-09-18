/**
 * Проверка возможностей (capabilities) рантайма перед запуском воркфлоу.
 *
 * Идея gate-проверки: воркфлоу заранее объявляет, какие способности ему нужны
 * (стриминг, сессии, сабагенты, fork сессии...), а адаптер - какие у него есть.
 * Несоответствие выявляется ДО запуска процесса, а не посреди работы, когда
 * половина задачи уже выполнена и откатывать больно. Это же спасает от самой
 * коварной категории багов: фича «не падает», а тихо деградирует (например,
 * стриминг молча превращается в односоловый ответ).
 *
 * Двойственность API - check-функции против assert-обёрток - не дублирование:
 * check-* возвращает
 * результат (для UI и мягкого деградирования), assert-* бросает структурированную
 * RuntimeCapabilityError (для пайплайна, где без способности работать нельзя).
 * Проверка одна, форма отказа - разная.
 *
 * Все вызовы логгера - через цепочки optional (logger?.debug?.()): модуль
 * вызывается с горячего пути, и ни логгер, ни его методы не обязаны существовать.
 */

import { RuntimeCapabilityError } from "./errors.js";
import type { RuntimeCapabilities, RuntimeTransport } from "./types.js";

// keyof вместо ручного союза строк: имя способности = имя поля в контракте
// адаптера. Добавят поле в RuntimeCapabilities - RuntimeCapabilityName расширится
// само, и ни один вызывающий код не обязан обновляться вручную.
export type RuntimeCapabilityName = keyof RuntimeCapabilities;

export interface RuntimeCapabilitiesLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Вход проверки: связка «кто (runtimeId), зачем (workflowKind) и что нужно
// (required)». workflowKind и logger опциональны: gate работает и вне контекста
// воркфлоу (например, при ручной диагностике профиля), а workflowKind нужен для
// читаемого сообщения об отказе.
export interface RuntimeCapabilityCheckInput {
  runtimeId: string;
  workflowKind?: string;
  capabilities: RuntimeCapabilities;
  required: RuntimeCapabilityName[];
  logger?: RuntimeCapabilitiesLogger;
}

// Результат сохраняет не только вердикт, но и оба списка: required - что
// запрашивали, missing - чего не хватило. Вызывающий код (UI) рисует из этого
// подсказку «включите X в профиле», не перепроверяя capabilities заново.
export interface RuntimeCapabilityCheckResult {
  ok: boolean;
  required: RuntimeCapabilityName[];
  missing: RuntimeCapabilityName[];
}

// Дискриминатор причины отказа вместо текста: «нет в capabilities» и «сама
// capability
// заявлена, но у адаптера нет метода forkSession» лечатся по-разному (первое -
// профиль/версия, второе - баг реализации адаптера), и UI ветвится по коду.
export type RuntimeSessionForkSkipReason = "unsupported_capability" | "missing_adapter_method";

// hasForkSessionMethod приходит булевым флагом извне, а не вычисляется здесь: проверка
// «есть ли у объекта-адаптера метод» требует владения самим адаптером, а модуль
// намеренно работает только с plain-данными (capabilities-снимок). Это держит
// функции чистыми и тестируемыми без конструирования фальшивых адаптеров.
// transport?: RuntimeTransport | string | null - союз намеренно широкий:
// транспорт мог ещё не пройти валидацию профиля, и gate не должен падать на
// «почти строке» - здесь transport только для логов, не для решения.
export interface RuntimeSessionForkSupportInput {
  runtimeId: string;
  transport?: RuntimeTransport | string | null;
  capabilities: RuntimeCapabilities;
  hasForkSessionMethod: boolean;
  sourceSessionId?: string | null;
  logger?: RuntimeCapabilitiesLogger;
}

export interface RuntimeSessionForkSupportResult {
  ok: boolean;
  skipReason?: RuntimeSessionForkSkipReason;
}

// Дедупликация Set'ом: required часто собирается склейкой из нескольких
// источников (spec + feature-флаги), и дубли исказили бы и missing (одно имя
// дважды), и подсчёт в логах. [ ...new Set ] - идиома уникализации массива.
function dedupeCapabilities(required: RuntimeCapabilityName[]): RuntimeCapabilityName[] {
  return [...new Set(required)];
}

// Пустой required - не ошибка, а штатный случай (например, skills-mode задача
// без строгих требований): debug-запись фиксирует факт, ok:true. Отдельная
// ветвь нужна ещё и потому, что «проверка» над пустым списком тривиальна,
// и её полезно видеть в логе при разборе «почему рантайм с минимальными
// возможностями вообще допустили до воркфлоу».
export function checkRuntimeCapabilities(
  input: RuntimeCapabilityCheckInput,
): RuntimeCapabilityCheckResult {
  const required = dedupeCapabilities(input.required);
  if (required.length === 0) {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        requiredCount: 0,
      },
      "No runtime capabilities required for workflow",
    );
    return { ok: true, required, missing: [] };
  }

  // Ядро проверки: !input.capabilities[capability] - доступ по вычисляемому
  // ключу keyof. Трактовка строгая: любые falsy (false, undefined, ноль) считаются
  // «нет способности» - если поле не выставлено явно, оно НЕ поддерживается.
  // Safe-by-default: забыл объявить = получи отказ, а не ложное «ок».
  const missing = required.filter((capability) => !input.capabilities[capability]);
  const ok = missing.length === 0;

  if (!ok) {
    // warn на отказе и debug на успехе: асимметрия намеренная - отсутствие
    // способности это событие, о котором надо знать, а успех рутинен и в warn
    // только шумел бы.
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        missing,
      },
      "Runtime does not support required workflow capabilities",
    );
  } else {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflowKind ?? null,
        required,
      },
      "Runtime capability check passed",
    );
  }

  return { ok, required, missing };
}

// Обёртка-исключение поверх той же проверки: никакой второй логики, поэтому
// check и assert физически не могут разойтись в вердиктах. Текст ошибки несёт
// runtimeId, workflowKind и список missing - всё, что нужно для тикета, кроме
// стека. join(", ") вместо «показать первую» - пользователь чинит профиль за
// один проход.
export function assertRuntimeCapabilities(input: RuntimeCapabilityCheckInput): void {
  const checked = checkRuntimeCapabilities(input);
  if (checked.ok) return;

  throw new RuntimeCapabilityError(
    `Runtime "${input.runtimeId}" does not support required capabilities for workflow "${input.workflowKind ?? "unknown"}": ${checked.missing.join(", ")}`,
  );
}

// Fork сессии проверяется двухуровнево: сначала декларация (supportsSessionFork
// в capabilities), затем фактическая реализация (hasForkSessionMethod). Оба
// уровня нужны: адаптер может заявить capability по ошибке или устареть,
// и метод forkSession может исчезнуть при рефакторинге. Цепочка тернарников
// вычисляет единственную причину отказа по приоритету: декларация важнее -
// если её нет, METHOD уже неважен и не проверяется.
export function checkRuntimeSessionForkSupport(
  input: RuntimeSessionForkSupportInput,
): RuntimeSessionForkSupportResult {
  const skipReason: RuntimeSessionForkSkipReason | null = !input.capabilities.supportsSessionFork
    ? "unsupported_capability"
    : !input.hasForkSessionMethod
      ? "missing_adapter_method"
      : null;

  // hasSourceSessionId логируется как Boolean(...), а не сам id: в идентификаторе
  // сессии нет диагностической ценности для этого gate (он проверяется выше по
  // потоку), а вот факт «форкаем существующую или стартуем с нуля» объясняет
  // контекст запроса на fork.
  if (!skipReason) {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        transport: input.transport ?? null,
        hasSourceSessionId: Boolean(input.sourceSessionId),
      },
      "Runtime session fork support check passed",
    );
    return { ok: true };
  }

  input.logger?.warn?.(
    {
      runtimeId: input.runtimeId,
      transport: input.transport ?? null,
      hasSourceSessionId: Boolean(input.sourceSessionId),
      skipReason,
    },
    "Runtime session fork requested but unavailable",
  );

  return { ok: false, skipReason };
}
