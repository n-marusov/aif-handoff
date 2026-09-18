import { readStorage, writeStorage } from "./storage.js";

/**
 * Создаёт простой внешний store на основе localStorage,
 * совместимый с React useSyncExternalStore.
 */
export function createExternalStore<T>(
  storageKey: string,
  defaultValue: T,
  serialize: (value: T) => string = JSON.stringify,
  deserialize: (raw: string) => T = JSON.parse,
) {
  const listeners = new Set<() => void>();
  let cached: T = read();
  let snapshot = serialize(cached);

  function read(): T {
    const raw = readStorage(storageKey);
    if (!raw) return defaultValue;
    try {
      return deserialize(raw);
    } catch {
      return defaultValue;
    }
  }

  function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  function getSnapshot() {
    return snapshot;
  }

  function get(): T {
    return cached;
  }

  function set(next: T) {
    writeStorage(storageKey, serialize(next));
    cached = next;
    snapshot = serialize(next);
    listeners.forEach((cb) => cb());
  }

  function update(partial: Partial<T>) {
    set({ ...cached, ...partial });
  }

  return { subscribe, getSnapshot, get, set, update };
}
