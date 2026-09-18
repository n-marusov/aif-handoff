/**
 * Простейший in-memory кэш с TTL для сервисов рантайма.
 *
 * Кэш создан не «на все случаи»: его потребители - modelDiscovery и проверка
 * соединений, где в каталоге десятки-сотни записей и важна предсказуемость,
 * а не идеальный hit-rate. Отсюда три решения:
 * - никакого фонового таймера чистки: просрочка вскрывается при чтении (лениво),
 *   а общий мусор выметается только при переполнении. Таймер удерживал бы event
 *   loop и требовал остановки при shutdown;
 * - вытеснение - FIFO по порядку вставки Map, а не LRU: нет bookkeeping на каждое
 *   чтение, поведение детерминированно, и для «список моделей провайдера» точность
 *   вытеснения не важна;
 * - время впрыскивается через options.now: тесты управляют «секундной стрелкой»
 *   без vi.useFakeTimers и sleeps.
 *
 * Это НЕ кэш между перезапусками процесса: после рестарта всё серое, discovery
 * просто пройдёт заново.
 */

// Узкий контракт из четырёх методов - намеренная «заменяемость»: вызывающий код
// зависит от интерфейса, а не от Map-реализации, и его можно подменить на
// no-store или redis-подобный без правок потребителей.
export interface RuntimeCache<T> {
  get(key: string): T | null;
  set(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
}

// Храним абсолютный дедлайн expiresAt, а не относительный ttl: сравнение
// «дедлайн <= сейчас» на чтении не требует держать время записи и не накапливает
// ошибку округления. Замыкание value сохраняет ссылку на объект без копирования:
// кэш не владеет данными (дешевле), но и не защищает их от мутации - контракт
// вызывающего кода не менять полученное.
interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

// Все три опции со значениями по умолчанию внутри фабрики; теперь возвращает
// время в миллисекундах эпохи (совместимо с Date.now и performance-таймерами).
export interface RuntimeCacheOptions {
  defaultTtlMs?: number;
  maxSize?: number;
  now?: () => number;
}

export function createRuntimeMemoryCache<T>(options: RuntimeCacheOptions = {}): RuntimeCache<T> {
  // Math.max(x, 1) - двойная защита: от нуля/отрицательных (ttl 0 означал бы
  // «всё протухло», maxSize 0 - невозможное состояние) и от опечаток. От NaN
  // Math.max, увы, не спасает (Math.max(NaN, 1) === NaN), но опции задаёт код
  // пакета, а не пользователь напрямую. 60_000/1000 - «достаточные, но не жадные».
  const defaultTtlMs = Math.max(options.defaultTtlMs ?? 60_000, 1);
  const maxSize = Math.max(options.maxSize ?? 1000, 1);
  const now = options.now ?? (() => Date.now());
  // Map выбран не случайно: порядок обхода строго == порядок вставки, и
  // удаление/чтение - O(1). У plain-объекта с ключами-числами порядок коварнее
  // (целочисличные ключи всегда всплывают первыми), и FIFO на нём сломался бы.
  const entries = new Map<string, CacheEntry<T>>();

  // Полная линейная чистка O(n) допускается только как редкое событие при
  // переполнении: вызывается из set по строгому условию, а не на каждом
  // обращении. Для n <= maxSize (по умолчанию 1000) такой проход почти бесплатен.
  function evictExpired(): void {
    const timestamp = now();
    // Удаление из Map прямо во время его же итерации допустимо в JS: «живой»
    // итератор не пропускает ещё не пройденные элементы и не падает.
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  }

  return {
    get(key: string): T | null {
      const entry = entries.get(key);
      if (!entry) return null;
      // Ленивая экспирация: просрочка проверяется здесь и запись удаляется на месте
      // (read-repair), чтобы следующий get не платил повторно и evictExpired не
      // обязан был видеть это значение.
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key: string, value: T, ttlMs?: number): void {
      // Двухступенчатое вытеснение: сначала освобождаем место «честно» -
      // просроченными записями, и лишь если кэш полон СВЕЖИМИ данными жертвуем
      // самой старой вставкой (FIFO). Порядок операций гарантирует, что живой
      // кэш почти никогда не теряет актуальные записи из-за потолка размера.
      if (entries.size >= maxSize) {
        evictExpired();
      }
      if (entries.size >= maxSize) {
        // keys().next().value - первый ключ Map == самый старый по вставке;
        // проверка !== undefined нужна только типами (IteratorResult.value).
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      // Пер-запись ttl переопределяет общий дефолт: discovery знает, что список
      // моделей живее настроек соединения, и назначает им разные времена жизни.
      const effectiveTtlMs = Math.max(ttlMs ?? defaultTtlMs, 1);
      entries.set(key, {
        expiresAt: now() + effectiveTtlMs,
        value,
      });
    },
    delete(key: string): void {
      // Удаление отсутствующего ключа - no-op без исключения (семантика Map):
      // инвалидация «на всякий случай» не требует предварительного has().
      entries.delete(key);
    },
    clear(): void {
      // Полная очистка: используется при смене профиля/токена, когда старые
      // данные провайдера заведомо невалидны и ждать их истечения нельзя.
      entries.clear();
    },
  };
}
