/**
 * Валидаторы входных данных для маршрутов Hono: единая точка, где выбирается
 * цель проверки - тело запроса или query-параметры.
 *
 * Зачем обертки: приведение схемы к any осознанно, оно обходит несовпадение
 * дженериков Zod v3/v4, из-за которого прямой вызов zValidator не проходит
 * строгую проверку типов. Разбор ошибки остается за стандартным поведением
 * zValidator, поэтому собственного обработчика здесь нет.
 */
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

/**
 * Типизированный валидатор JSON-тела для маршрутов Hono.
 * Оборачивает zValidator из @hono/zod-validator с целью "json".
 * Двойное приведение обходит несовпадение дженериков Zod v3/v4, из-за
 * которого прямой вызов не проходит при строгой конфигурации TypeScript.
 */
export function jsonValidator<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("json", schema as any);
}

/**
 * Типизированный валидатор query-параметров для маршрутов Hono.
 * Оборачивает zValidator из @hono/zod-validator с целью "query".
 */
export function queryValidator<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("query", schema as any);
}
