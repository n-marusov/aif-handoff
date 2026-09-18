// Загрузка внешних модулей рантайма: приведение произвольного экспорта к функции
// регистрации.
//
// Модуль описывает контракт плагина рантайма и терпимость к формам экспорта: поддержаны
// именованная функция, функция по умолчанию и объект с методом. Благодаря этому можно
// подключать как собранные ESM-пакеты, так и простые CommonJS-модули без адаптеров.

import type { RuntimeRegistry } from "./registry.js";

export type RegisterRuntimeModule = (registry: RuntimeRegistry) => void | Promise<void>;

export interface RuntimeModule {
  name?: string;
  version?: string;
  registerRuntimeModule: RegisterRuntimeModule;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRegistrar(value: unknown): value is RegisterRuntimeModule {
  return typeof value === "function";
}

/**
 * Разрешает экспорт модуля в `registerRuntimeModule(registry)`.
 * Поддерживаемые формы экспорта:
 * - `export function registerRuntimeModule(...) {}`
 * - `export default function registerRuntimeModule(...) {}`
 * - `export default { registerRuntimeModule(...) {} }`
 */
// Экспорт может быть функцией напрямую или объектом-обёрткой, поэтому сначала проверяется
// простой случай, затем - варианты с default. Возврат null означает "это не плагин
// рантайма": вызывающий код сам решает, считать это ошибкой или пропустить модуль.
export function resolveRuntimeModuleRegistrar(moduleExport: unknown): RegisterRuntimeModule | null {
  if (isRegistrar(moduleExport)) {
    return moduleExport;
  }

  if (!isObject(moduleExport)) {
    return null;
  }

  if (isRegistrar(moduleExport.registerRuntimeModule)) {
    return moduleExport.registerRuntimeModule;
  }

  const maybeDefault = moduleExport.default;
  if (isRegistrar(maybeDefault)) {
    return maybeDefault;
  }

  if (isObject(maybeDefault) && isRegistrar(maybeDefault.registerRuntimeModule)) {
    return maybeDefault.registerRuntimeModule;
  }

  return null;
}
