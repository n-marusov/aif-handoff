/**
 * Многослойные таймауты исполнения рантаймов.
 *
 * Файл реализует два независимых слоя защиты от зависаний:
 *
 * - start timeout: «процесс/поток молчит с самого начала» - признак
 *   стартового зависания (логин, антивирус, ожидание TTY). Такая ошибка
 *   помечается как retriable: один автоматический повтор часто помогает.
 * - run timeout: «работа идёт, но слишком долго» - жёсткий потолок,
 *   повтор не назначается, это уже сбой, а не гонка.
 *
 * Для каждого слоя есть своя обёртка: withStreamTimeouts для async-
 * итераторов (SDK-стримы) и withProcessTimeouts для дочерних процессов
 * (CLI-транспорты). Две обёртки, а не одна универсальная, потому что
 * «первый вывод» у потока и у процесса ловится принципиально разными
 * механизмами: в потоке это гонка next() против таймера, в процессе -
 * подписка на события stdout/stderr.
 *
 * Правило проекта, важное для этого файла: тексты ошибок таймаутов -
 * только диагностика. Управление потоком (повторять или нет) ветвится по
 * структурным полям: category === "timeout" и маркеру retriable, а не по
 * подстрокам в message.
 */

// type-import: ChildProcess нужен только в сигнатурах, в рантайме он не
// используется - import type гарантирует полное стирание импорта из JS.
import type { ChildProcess } from "node:child_process";
// Ошибки таймаутов - часть общей иерархии runtime-ошибок: потребители
// ловят единый класс и смотрят на category, не зная, кто именно сработал.
import { RuntimeExecutionError } from "./errors.js";

/* ------------------------------------------------------------------ */
/*  Общие типы                                                        */
/* ------------------------------------------------------------------ */

/** Часть RuntimeExecutionIntent, относящаяся к логике таймаутов. */
// Минимальный интерфейс вместо полного RuntimeExecutionIntent: обёртки не
// должны знать про модели, промпты и транспорты - только про время. Узкий
// контракт упрощает тестирование и не связывает модуль с типами выполнения.
//
// Формулировка «Ignored when <= 0» - часть контракта: отключённый таймаут
// кодируется не false или null, а невалидным числом, которое positiveMs
// превращает в «нет ограничения». Так конфигурация из env (строка -> число)
// естественно попадает в «выключено» при ошибке парсинга.
export interface TimeoutIntent {
  /** Таймаут ожидания первого вывода (мс). Игнорируется при ≤ 0 или undefined. */
  startTimeoutMs?: number;
  /** Пауза перед одной автоматической повторной попыткой после start-таймаута (мс). */
  startRetryDelayMs?: number;
  /** Жёсткий таймаут всего запуска (мс). Игнорируется при ≤ 0 или undefined. */
  runTimeoutMs?: number;
}

// Опциональные методы - тот же минимализм, что и в других модулях runtime:
// вызывается через `?.method?.()`, поэтому в тестах можно передать undefined.
export interface TimeoutLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

/* ------------------------------------------------------------------ */
/*  Константы                                                          */
/* ------------------------------------------------------------------ */

/** Маркер-свойство на ошибках таймаута: разрешён один автоматический повтор. */
// `as const` фиксирует литеральный тип строки: ключ сравнивается строго и
// не «широется» до string. Маркер вешается на сам объект ошибки, а не
// заводится отдельным подклассом: таймаут остаётся RuntimeExecutionError
// с тем же category, а retriable-статус - ортогональным флагом.
export const TIMEOUT_RETRIABLE_KEY = "__timeoutRetriable__" as const;

/* ------------------------------------------------------------------ */
/*  Функции работы с ошибками                                          */
/* ------------------------------------------------------------------ */

// Фабрика start-ошибки: единый формат сообщения, category и маркера.
// Держать это в одной функции важно: любое место, создающее ошибку,
// обязано не забыть маркер retriable - дублирование литерала легко теряет
// его, и ретрай молча перестаёт работать.
function makeStartTimeoutError(ms: number): RuntimeExecutionError {
  const err = new RuntimeExecutionError(
    `Start timeout: runtime produced no output within ${ms}ms`,
    // cause не передают: у этой ошибки нет «предыстории» - она и есть
    // корневая причина, порождённая самим таймером.
    undefined,
    "timeout",
  );
  // Запись произвольного свойства на типизированном объекте требует каста
  // через unknown: TS запрещает расширять класс «сбоку», а объект ошибки -
  // обычный JS-объект и терпит. Двойной каст честен: мы знаем, что делаем.
  (err as unknown as Record<string, unknown>)[TIMEOUT_RETRIABLE_KEY] = true;
  return err;
}

// Run-ошибка намеренно без маркера retriable: превышение общего потолка
// означает, что сама работа слишком долгая - повтор того же запроса
// удвоит потерянное время и точно не изменит результат.
function makeRunTimeoutError(ms: number): RuntimeExecutionError {
  return new RuntimeExecutionError(
    `Run timeout: execution exceeded ${ms}ms limit`,
    undefined,
    "timeout",
  );
}

/** Проверяет, допускает ли ошибка таймаута одну повторную попытку. */
// Образцовая реализация правила «никакого ветвления по тексту сообщения»:
// решение принимается по instanceof, enum-ному category и булевому маркеру.
// Все три условия ортогональны: любой из них может быть истиной и без
// остальных, поэтому перепутать start-таймаут с run невозможно.
// Сама обёртка ретрайт не делает: она лишь выносит вердикт. Решение
// «повторять или нет» остаётся за вызывающим - только он знает бюджет
// стадии и сколько попыток уже израсходовано. Так политика и механизм
// не переплетаются.
export function isRetriableTimeoutError(error: unknown): boolean {
  return (
    error instanceof RuntimeExecutionError &&
    error.category === "timeout" &&
    (error as unknown as Record<string, unknown>)[TIMEOUT_RETRIABLE_KEY] === true
  );
}

/** Определяет startRetryDelayMs из намерения (по умолчанию 1 000 мс). */
// Значение по умолчанию 1000 мс: достаточно, чтобы пережить мимолётную
// загрузку машины, но не тормозить пайплайн. Проверка Number.isFinite
// обязательна: значение часто приходит из env-переменной, где опечатка
// превращается в NaN, а setTimeout(NaN) ведёт себя как setTimeout(0).
export function resolveRetryDelay(intent: TimeoutIntent): number {
  const delay = intent.startRetryDelayMs;
  return typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : 1_000;
}

/** Sleep на промисах. Разрешается сразу при ms ≤ 0. */
// Промис-таймер: await sleepMs(...) вместо коллбека, чтобы вызывающий мог
// строить линейный async-код. Ветка ms <= 0 не создаёт таймер вовсе - это
// не микрооптимизация, а гарантия: «спать ноль» не должно добавлять лишний
// тик event loop в горячих циклах.
export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  // setTimeout(resolver, ms) - идиома «резолв по таймеру»: аргументы
  // коллбека промиса-резолвера просто игнорируются.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Общие функции валидации                                            */
/* ------------------------------------------------------------------ */

// Единый нормализатор «число миллисекунд или null».
//
// null как результат означает «таймаут выключен/некорректен» - так
// различаются «нет ограничения» и «ограничение 0мс». Math.floor приводит
// дробные значения (из секунд-конвертаций) к целым: setTimeout дробные
// значения законно принимает, но логи и сравнения с ними только шумят.
function positiveMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/* ------------------------------------------------------------------ */
/*  1. Обёртка таймаута потока                                         */
/* ------------------------------------------------------------------ */
// Поточная обёртка: живёт там, где выполнение - async-итератор событий
// (SDK Claude, стриминг Codex API). Здесь «убийство» - это abort-сигнал:
// мы не можем вырвать исполнение из чужого генератора, только попросить
// его остановиться.

/**
 * Оборачивает async-итератор с защитами start- и run-таймаута.
 *
 * - **startTimeoutMs**: отклоняет retriable-ошибкой таймаута, если
 *   первый вызов `next()` не разрешится в заданное окно.
 * - **runTimeoutMs**: по общему дедлайну срабатывает AbortController,
 *   и любой ожидающий `next()` отклоняется.
 *
 * При срабатывании таймаута обёртка вызывает `iterator.return()`, чтобы
 * освободить нижележащий ресурс потока.
 *
 * @returns Новый async-итерируемый итератор, прозрачно транслирующий
 *          значения источника с контролем таймаутов.
 */
// Обёртка над async-итератором: декоратор, сохраняющий протокол
// итератора. Реализована руками (объект с next), а не async-генератором,
// чтобы пробросить метод return() в исходный итератор: for-await вызывает
// его при раннем break, и этот контракт нельзя потерять.
export function withStreamTimeouts<T>(
  iterator: AsyncIterableIterator<T>,
  intent: TimeoutIntent,
  abort?: AbortController,
  logger?: TimeoutLogger,
): AsyncIterableIterator<T> {
  // Оба лимита проходят через positiveMs: мусор из env превращается в null
  // и дальше просто выключает соответствующий слой защиты.
  const startMs = positiveMs(intent.startTimeoutMs);
  const runMs = positiveMs(intent.runTimeoutMs);

  // Нечего оборачивать — возвращаем исходный итератор как есть
  if (startMs === null && runMs === null) return iterator;

  // Состояние обёртки живёт в замыканиях, а не в классе: экземпляр
  // ровно один, наследники не планируются - функции-обработчики проще.
  let firstYielded = false;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  // Run-таймаут — прерывает весь поток после дедлайна
  // Запуск здесь, на этапе обёртывания: отсчёт общего времени идёт от
  // момента создания, а не от первого next() - иначе ожидание инициализации
  // SDK неучтённо продлевало бы жизнь процесса.
  //
  // Таймеры намеренно не unref-ятся (в отличие от shared/withTimeout):
  // здесь живой запуск сам держит event loop, и таймер - не единственный
  // повод ждать; гарантию «не пережить процесс» несёт cleanup, а не unref.
  if (runMs !== null) {
    runTimer = setTimeout(() => {
      logger?.warn?.({ runTimeoutMs: runMs }, "Stream run timeout reached, aborting");
      // abort - сигнализация «сотрудничеству»: сам поток не убивается,
      // а источник обязан отреагировать на сигнал и завершиться. Поэтому
      // дальше идёт cleanup, а не ожидание реакции.
      // Порядок важен: сначала сигнал, потом снятие таймеров - обработчик
      // источника, проснувшись по abort, увидит уже закрытую обёртку (done)
      // и не попытается отдать данные в мёртвую итерацию.
      abort?.abort();
      cleanup();
    }, runMs);
  }

  // Идемпотентный останов таймеров: вызывается из нескольких путей
  // (таймаут, done, ошибка, return), и повторный вызов должен быть безвреден.
  // Флаг done закрывает обёртку: следующие next() вернут done сразу.
  function cleanup(): void {
    if (startTimer !== null) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    if (runTimer !== null) {
      clearTimeout(runTimer);
      runTimer = null;
    }
    done = true;
  }

  // Возврат ресурса исходному итератору. Метод return() опционален в
  // протоколе итератора (`?.`), а его бросок проигнорирован намеренно:
  // чистим по остаточному принципу - не перебиваем основную ошибку
  // второстепенной. Пустой catch с комментарием - Accepted стандарт,
  // lint-правило no-empty требует обоснования.
  async function cleanupIterator(): Promise<void> {
    try {
      await iterator.return?.();
    } catch {
      // очистка потока по мере возможности
    }
  }

  async function next(): Promise<IteratorResult<T>> {
    // После cleanup не отдаём ничего: double-done безопаснее, чем отдать
    // данные из уже закрытого потока.
    if (done) return { value: undefined as unknown as T, done: true };

    // Start-таймаут применяется только к первому вызову
    // Start-таймаут защищает только «первый байт»: время до инициализации
    // модели. Дальше поток считается живым, и за него отвечает run-таймер.
    if (!firstYielded && startMs !== null) {
      // Гонка трёх кандидатов. Победители-страховки разрешаются строками-
      // сентинелами (union-тип в аннотации), а не исключениями: проигравшие
      // промисы остаются в подвешенном состоянии, и это нормально -
      // Promise.race не отменяет конкурентов.
      const racers: Promise<IteratorResult<T> | "START_TIMEOUT" | "ABORTED">[] = [
        // Вызов iterator.next() стартует до создания гонки - источник
        // работает, пока мы ждём. Известное следствие: если победит
        // START_TIMEOUT, уже извлечённое значение (если оно придёт позже)
        // будет потеряно. Приемлемо: ретрай всё равно начинает сессию
        // заново, а ловить «опоздавшее» значение означало бы усложнить
        // обёртку ради данных, которые всё равно нельзя вернуть потребителю
        // после выброшенного исключения.
        iterator.next(),
        new Promise<"START_TIMEOUT">((resolve) => {
          startTimer = setTimeout(() => {
            logger?.warn?.(
              { startTimeoutMs: startMs },
              "Stream start timeout reached, no output received",
            );
            resolve("START_TIMEOUT");
          }, startMs);
        }),
      ];
      // Также в гонке внешний abort — чтобы watchdog прервал первый вызов
      // Abort участвует в гонке только если ещё не сработал: слушать
      // уже «умерший» сигнал бессмысленно, его проверят ниже отдельно.
      // { once: true } - авто-снятие слушателя после первого сигнала:
      // без него длинная жизнь обёртки копила бы мёртвые обработчики.
      if (abort && !abort.signal.aborted) {
        racers.push(
          new Promise<"ABORTED">((resolve) => {
            abort.signal.addEventListener("abort", () => resolve("ABORTED"), { once: true });
          }),
        );
      }
      const result = await Promise.race(racers);

      // Таймаут разрешает гонку значением-сентинелом, а не исключением -
      // иначе незабронированный reject проигравшего промиса устроил бы
      // unhandled rejection. Бросаем сами, после cleanup.
      if (result === "START_TIMEOUT") {
        cleanup();
        await cleanupIterator();
        throw makeStartTimeoutError(startMs);
      }

      // Abort до первого вывода: внешний watchdog (например, таймер стадии).
      // Ошибку конструируем run-таймаутом: по смыслу это «процессу пора
      // умирать», а не «он не начался»; ретрай здесь не назначен.
      if (result === "ABORTED") {
        cleanup();
        await cleanupIterator();
        throw makeRunTimeoutError(runMs ?? 0);
      }

      // Снимаем start-таймер — первое значение получено
      // Поток ожил - start-таймер больше не нужен; снимаем его, чтобы не
      // удерживал event loop и не сработал ложно позже.
      if (startTimer !== null) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      // Первая порция получена: старт удался, «первый байт» больше не ждём.
      firstYielded = true;

      // done до первого содержательного чанка - поток был пустой: закрываем
      // обёртку тем же cleanup, что и по таймауту, - таймеры не должны
      // переживать завершение.
      if (result.done) {
        cleanup();
      }
      return result;
    }

    // Последующие вызовы — гонка с abort-сигналом, чтобы внешний abort (watchdog,
    // таймаут стадии) сразу прерывал зависший iterator.next().
    // Ветвь «после первого вывода»: своего таймера здесь нет, но abort
    // по-прежнему перехватывается, иначе зависший next() переждал бы всю
    // смерть процесса молча.
    //
    // Сознательное ограничение: per-chunk таймаута на промежуточные порции
    // нет - «поток молчит вторую минуту» ловит только общий run-таймер.
    // Это рабочий компромисс: длинная генерация с паузами нормальна, и
    // отдельный watchdog на чанк породил бы ложные убийства медленных моделей.
    try {
      // Объявление без инициализатора: результат будет назначен в одной из
      // трёх веток ниже, и TypeScript проверяет это flow-анализом -
      // альтернатива громоздкому вложенному тернарнику.
      let result: IteratorResult<T>;
      if (abort && !abort.signal.aborted) {
        // На каждом вызове создаётся новый промис-сигнал с новым слушателем.
        // Это осознанный компромисс простоты: слушатели self-remove'ятся по
        // once при abort, но на успешном пути остаются висеть до конца
        // жизни сигнала - на очень длинных стримах это заметно по памяти.
        const abortRace = new Promise<"ABORTED">((resolve) => {
          const onAbort = () => resolve("ABORTED");
          abort.signal.addEventListener("abort", onAbort, { once: true });
        });
        const raced = await Promise.race([iterator.next(), abortRace]);
        if (raced === "ABORTED") {
          cleanup();
          await cleanupIterator();
          throw makeRunTimeoutError(runMs ?? 0);
        }
        result = raced;
      } else if (abort?.signal.aborted) {
        // Abort уже случился до вызова: не дёргаем исходный итератор вообще
        // - гонять next() по мёртвому потоку значит создавать ложные ошибки
        // внутри провайдера.
        cleanup();
        await cleanupIterator();
        throw makeRunTimeoutError(runMs ?? 0);
      } else {
        // Ни таймеров, ни abort: сквозной проброс без накладных расходов.
        result = await iterator.next();
      }

      // Формальная поддержка инварианта «после любого успешного next()
      // firstYielded === true»: при выключенном start-таймауте ветка выше
      // не выполнялась, и без этой строки флаг остался бы false навсегда.
      if (!firstYielded) firstYielded = true;
      if (result.done) {
        // Естественный конец потока: снимаем таймер run, иначе он доживёт
        // до своего срабатывания и попытается abort-ить уже завершённый запуск.
        cleanup();
      }
      return result;
    } catch (error) {
      cleanup();
      // Если abort вызван run-таймаутом — бросаем явную ошибку
      // В catch попадают и «наши» брошенные ошибки, и исключения источника.
      // Если поток бросил из-за abort (источник отреагировал на сигнал),
      // превращаем абстрактный обрыв в конкретный run-таймаут: у abort-
      // сигнала нет своего текста ошибки, а потребителю нужен category.
      if (abort?.signal.aborted && runMs !== null) {
        await cleanupIterator();
        throw makeRunTimeoutError(runMs);
      }
      throw error;
    }
  }

  // Минимальная реализация AsyncIterableIterator: next, return и
  // self-итератор. Метод throw() в типе опционален и не реализуется:
  // ошибка из for-await «снаружи» всё равно приходит в return(), а наша
  // внутренняя логика об ошибках уже обслужена в next().
  const wrapped: AsyncIterableIterator<T> = {
    next,
    async return() {
      // Ранний выход потребителя (break в for-await, throw из тела цикла):
      // обязательно гасим таймеры, иначе живой run-таймер переживёт цикл.
      cleanup();
      await cleanupIterator();
      // Формальный done. В двойном касте `as unknown as T` нет злого умысла:
      // при done:true поле value по контракту не читается, а система типов
      // требует, чтобы оно «имело тип T» - unknown прокладывает путь между
      // этими двумя требованиями.
      return { value: undefined as unknown as T, done: true };
    },
    [Symbol.asyncIterator]() {
      // Возврат самого себя: обёртка становится iterable, и for await
      // корректно вызовет return() при досрочном выходе.
      return wrapped;
    },
  };

  return wrapped;
}

/* ------------------------------------------------------------------ */
/*  2. Обёртка таймаута процесса                                       */
/* ------------------------------------------------------------------ */

export interface ProcessTimeoutResult {
  /**
   * Снимает все таймеры. Обязателен при нормальном выходе процесса
   * или когда учёт таймаутов больше не нужен вызывающему.
   */
  // cleanup обязателен к вызову: незакрытый setTimeout удерживает event
  // loop (тот же урок, что и в shared/withTimeout), и процесс висит после
  // уже завершившегося CLI.
  cleanup: () => void;

  /**
   * Разрешается в `true`, если процесс убит из-за start-таймаута.
   * Разрешается в `false`, если процесс выдал данные до конца стартового окна.
   * Вызывающий проверяет после закрытия процесса, чтобы решить — повторять ли.
   */
  // Promise, а не boolean: момент истины наступает в обработчике 'close',
  // который может случиться и до, и после срабатывания таймера. Промис
  // гарантирует, что вызывающий дождётся решения в любом порядке.
  startTimedOut: Promise<boolean>;

  /**
   * Убит ли процесс общим run-таймаутом.
   * Проверять после события 'close' процесса.
   */
  // А вот тут - synchronous getter, не промис: к моменту 'close' значение
  // уже финально, а readonly в типе запрещает потребителю подменить флаг.
  readonly runTimedOut: boolean;
}

/**
 * Навешивает start- и run-таймауты на дочерний процесс.
 *
 * - **startTimeoutMs**: убивает процесс (SIGKILL), если ни stdout, ни
 *   stderr не дадут данных в окно. Промис `startTimedOut` разрешится
 *   `true`, и вызывающий сможет повторить после `startRetryDelayMs`.
 * - **runTimeoutMs**: убивает процесс (SIGKILL) после общего дедлайна.
 *
 * Ответственность вызывающего — проверить `startTimedOut` / `runTimedOut`
 * после закрытия процесса и сконструировать подходящую ошибку.
 *
 * @returns Дескриптор с cleanup и доступом к статусам таймаутов.
 */
// Разделение ответственности: эта функция только решает «когда убить»,
// но не конструирует итоговые ошибки - их строит вызывающий, знающий контекст
// (какая стадия, какой retries уже были). Поэтому наружу отдаются флаги,
// а не исключения.
export function withProcessTimeouts(
  child: ChildProcess,
  intent: TimeoutIntent,
  logger?: TimeoutLogger,
): ProcessTimeoutResult {
  const startMs = positiveMs(intent.startTimeoutMs);
  const runMs = positiveMs(intent.runTimeoutMs);

  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  // Подчёркнутые имена - внутренняя правда, наружу смотрят через геттер
  // и промис: потребителю нечем подделать состояние.
  let _startTimedOut = false;
  let _runTimedOut = false;
  let startResolved = false;

  // Приём «deferred»: resolve захватывается из executor-а промиса в
  // переменную замыкания, чтобы разрешить промис из обработчиков событий
  // процесса. Ванильный Promise не даёт ручного управления - этот костыль
  // стандартный способ его получить.
  let resolveStart!: (value: boolean) => void;
  const startTimedOut = new Promise<boolean>((resolve) => {
    resolveStart = resolve;
  });

  function clearStartTimer(): void {
    if (startTimer !== null) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    // Promise разрешается ровно один раз, повторные resolve() - no-op.
    // Явный guard startResolved документирует инвариант и экономит ложные
    // вызовы: сюда заходят и onData, и cleanup, и сам таймер.
    if (!startResolved) {
      startResolved = true;
      resolveStart(false);
    }
  }

  function cleanup(): void {
    clearStartTimer();
    if (runTimer !== null) {
      clearTimeout(runTimer);
      runTimer = null;
    }
  }

  // Следит за stdout/stderr ради первого вывода
  // Любые данные на любом из двух потоков = процесс жив. stderr считается
  // наравне со stdout: CLI часто пишут прогресс и логи именно туда, и
  // требовать «первого stdout» означало бы убивать болтливые процессы.
  //
  // Слушатели вешаются только при активном start-таймауте: без него некому
  // проверять «ожил ли процесс», и лишние подписки на стримы были бы чистым
  // шумом. Опциональная цепочка ?.on ниже не случайна: при stdio: "ignore"
  // поток может быть null - такие процессы стартуют «немые».
  const onData = (): void => {
    clearStartTimer();
  };

  if (startMs !== null) {
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    startTimer = setTimeout(() => {
      // Порядок присвоений важен: сначала фиксируем состояние и разрешаем
      // промис, и только потом убиваем. kill() может синхронно нарезвить
      // события процесса, и обработчики должны увидеть готовый флаг.
      startTimer = null;
      _startTimedOut = true;
      startResolved = true;
      resolveStart(true);
      logger?.warn?.(
        { startTimeoutMs: startMs, pid: child.pid },
        "Process start timeout reached, killing process",
      );
      // SIGKILL, а не SIGTERM: зависший на логине или TTY процесс не
      // обработает TERM корректно, а KILL не перехватывается и гарантированно
      // завершает процесс.
      // kill() не бросает на уже завершившемся процессе (Node вернёт false):
      // гонка «таймер vs естественный выход» безвредна - победителем
      // останется тот, кто дожил до сигнала, а остальное увидит 'close'.
      child.kill("SIGKILL");
    }, startMs);
  } else {
    // Нет start-таймаута — разрешаем сразу
    // Контракт: startTimedOut разрешается всегда. Если бы в этой ветке его
    // не разрешили, await на close-обработчике вызывающего завис бы навсегда.
    startResolved = true;
    resolveStart(false);
  }

  if (runMs !== null) {
    runTimer = setTimeout(() => {
      // Здесь промиса нет намеренно: run-таймаут не влияет на решение о
      // ретрайте, его читают синхронным геттером после 'close'.
      runTimer = null;
      _runTimedOut = true;
      logger?.warn?.(
        { runTimeoutMs: runMs, pid: child.pid },
        "Process run timeout reached, killing process",
      );
      child.kill("SIGKILL");
    }, runMs);
  }

  // Обёртка сознательно не слушает 'exit'/'close' процесса: единственный
  // источник истины о завершении - вызывающий, который обязан позвать
  // cleanup() после 'close'. Дублирование жизненного цикла внутри обёртки
  // породило бы гонку двух обработчиков одного события.
  return {
    cleanup,
    startTimedOut,
    // Геттер, а не копия значения: интерфейс обещает readonly, а замыкание
    // гарантирует, что читатель всегда видит актуальный флаг.
    get runTimedOut() {
      return _runTimedOut;
    },
  };
}

// Публичные алиасы приватных фабрик: процессная ветка собирает ошибки теми
// же функциями-обёртками, но формат сообщения и category диктует общий
// источник. Две дороги - одна ошибка: ретрай-логика различает их только
// структурно, и расхождение в текстах или маркерах сломало бы её.
/** RuntimeExecutionError при start-таймауте процесса. */
export function makeProcessStartTimeoutError(ms: number): RuntimeExecutionError {
  return makeStartTimeoutError(ms);
}

/** RuntimeExecutionError при run-таймауте процесса. */
export function makeProcessRunTimeoutError(ms: number): RuntimeExecutionError {
  return makeRunTimeoutError(ms);
}
