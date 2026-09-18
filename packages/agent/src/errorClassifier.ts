/**
 * Классификация ошибок конвейера координатора.
 *
 * Назначение: превратить разнородные исключения (рантайм, конфигурация, git,
 * платформенные сбои) в решения о дальнейшей судьбе задачи - повторять, остановить
 * или пометить сбой внешним.
 *
 * Почему так:
 * - Первичный сигнал - структурный: категория RuntimeExecutionError из
 *   @aif/runtime. Сопоставление по тексту сообщения запрещено правилами проекта,
 *   потому что текст меняется вместе с формулировками и локализацией.
 * - Поиск идёт по цепочке cause. Обёртки (например, ошибка шага воркфлоу) прячут
 *   исходную причину, поэтому обход причины обязателен для всех предикатов.
 * - Исключение из правила - FAST_RETRY_PATTERNS: разбор конкретных диагностических
 *   сообщений там, где структурного признака нет. Список намеренно короткий.
 * - Функции-предикаты возвращают boolean и не бросают: они вызываются в
 *   обработчиках ошибок, где вторичное исключение недопустимо.
 *
 * Классификация ошибок конвейера координатора.
 *
 * Основной сигнал — структурированная категория RuntimeExecutionError.category
 * из @aif/runtime. Сопоставление по тексту сообщений используется только для
 * ошибок, не являющихся RuntimeExecutionError (например, RuntimeCapabilityError).
 */

import {
  RuntimeCapabilityError,
  RuntimeExecutionError,
  RuntimeResolutionError,
  RuntimeValidationError,
  isExternalFailureCategory,
} from "@aif/runtime";
import { BranchIsolationError } from "./gitBranch.js";

// Проверка идёт по всей цепочке cause: BranchIsolationError часто обёрнут ошибкой
// шага, и без рекурсии признак терялся бы.
export function findBranchIsolationError(err: unknown): BranchIsolationError | null {
  if (err instanceof BranchIsolationError) return err;
  if (err instanceof Error && "cause" in err && err.cause) {
    return findBranchIsolationError(err.cause);
  }
  return null;
}

// Конфигурационные ошибки объединены в один предикат: для вызывающего важен сам
// факт неверной настройки, а не конкретный класс исключения.
export function findConfigurationError(
  err: unknown,
): RuntimeCapabilityError | RuntimeResolutionError | RuntimeValidationError | null {
  if (
    err instanceof RuntimeCapabilityError ||
    err instanceof RuntimeResolutionError ||
    err instanceof RuntimeValidationError
  ) {
    return err;
  }
  if (err instanceof Error && "cause" in err && err.cause) {
    return findConfigurationError(err.cause);
  }
  return null;
}

// Сообщения, при которых имеет смысл быстрый повтор без полного перезапуска
// стадии. Текст заранее приводится к нижнему регистру, поэтому предикаты уже не
// занимаются нормализацией.
const FAST_RETRY_PATTERNS: Array<(lower: string) => boolean> = [
  (lower) => lower.includes("stream interrupted before implement-worker dispatch"),
  (lower) => lower.includes("error in hook callback") && lower.includes("stream closed"),
];

// Приведение к нижнему регистру делает сопоставление регистронезависимым и убирает
// разницу между Error и брошенным значением: снаружи может прийти что угодно.
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

// Обход цепочки cause ради структурной категории: только она даёт надёжный
// признак сбоя на стороне провайдера.
export function findRuntimeExecutionError(err: unknown): RuntimeExecutionError | null {
  if (err instanceof RuntimeExecutionError) {
    return err;
  }
  if (err instanceof Error && "cause" in err && err.cause) {
    return findRuntimeExecutionError(err.cause);
  }
  return null;
}

// Внешний сбой означает проблему у провайдера или в окружении, а не в коде
// задачи, поэтому такие падения обрабатываются иначе, чем ошибки реализации.
export function isExternalFailure(err: unknown): boolean {
  // Первичный сигнал: структурированная категория из классификации Runtime-адаптера
  const runtimeError = findRuntimeExecutionError(err);
  if (runtimeError) {
    return isExternalFailureCategory(runtimeError.category);
  }

  // Признак конфигурации проверяется вторым: он не имеет категории рантайма, но
  // тоже означает внешнюю причину, не связанную с логикой задачи.
  const configurationError = findConfigurationError(err);
  if (configurationError) return true;
  return false;
}

// Явная проверка текста, а не структурной категории: это осознанное исключение
// для узкого набора сообщений о прерванном потоке.
export function isFastRetryableFailure(err: unknown): boolean {
  const lower = errorText(err);
  return FAST_RETRY_PATTERNS.some((check) => check(lower));
}

// Обрезка причины до фиксированной длины: значение уходит в сообщения и в
// хранилище, поэтому ограничение защищает интерфейс и базу от гигантских текстов.
// Многоточие входит в лимит, иначе результат вылезал бы за maxLength.
export function truncateReason(reason: string, maxLength = 240): string {
  if (reason.length <= maxLength) return reason;
  return `${reason.slice(0, maxLength - 3)}...`;
}
