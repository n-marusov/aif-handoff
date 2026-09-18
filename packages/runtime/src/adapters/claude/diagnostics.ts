/**
 * Человекочитаемая диагностика ошибок Claude: превращает сырые stderr и коды
 * выхода в объяснение «что случилось и что делать».
 *
 * Важное отличие от errors.ts: тот модуль принимает решения (category,
 * adapterCode), а этот только сочиняет текст. Поэтому здешний матчинг по строкам
 * не нарушает правило о структурной классификации: по его результату программа не
 * ветвится, он лишь помогает человеку понять отказ. И даже для текста приоритет у
 * структурного признака: explainFailure сначала смотрит на err.category и лишь
 * при «unknown» спускается к фразам.
 *
 * Модуль обязан не бросать и не подменять исходную ошибку: diagnoseClaudeError
 * возвращает только строку для логов и уведомлений, а исключение остаётся в стеке
 * вызывающего; диагностика — наблюдатель, а не участник обработки отказа.
 */

// Импорты минимальны: spawn для probe'а и тип ошибки для распознавания уже
// классифицированных случаев. Никаких адаптерных модулей — диагностика должна
// пережить даже частично сломанную сборку адаптера.
import { spawn } from "node:child_process";
import type { RuntimeDiagnoseErrorInput } from "../../types.js";
import { RuntimeExecutionError } from "../../errors.js";

// Локальный двойник хелпера из errors.ts, оставленный намеренно: диагностический
// модуль должен быть самостоятельным и не тянуть за собой иерархию ошибок — его
// вызывают в момент разбора аварии, и лишние зависимости здесь только добавляют
// риск сломать сам путь диагностики.
function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function explainFailure(err: unknown, stderrTail: string): string {
  const baseMessage = messageFromUnknown(err);
  const stderr = stderrTail.trim();
  // stderr приоритетнее сообщения об ошибке: там обычно лежит настоящая причина
  // (принт CLI), тогда как message часто бывает общим («process exited...»).
  const detail = stderr || baseMessage;

  // Основной путь: развилка по структурной category, когда она доступна
  if (err instanceof RuntimeExecutionError && err.category !== "unknown") {
    // Проверка на "unknown" — не формальность: это как раз случай, когда
    // структуры нет и говорить нечего, поэтому его обрабатывает текстовый
    // fallback ниже. Для всех остальных категорий текст уже известен по смыслу.
    switch (err.category) {
      // Все ветки возвращают текст сразу: каждая описывает одну типовую беду и
      // что с ней делать, и продолжение разбора ниже уже не нужно.
      case "auth":
        return `Runtime not logged in or authentication failed. Run claude /login. ${detail}`;
      case "rate_limit":
        return `Runtime usage limit reached. ${detail}`;
      case "stream":
        return `Runtime stream interrupted during execution. ${detail}`;
      case "timeout":
        return `Runtime request timed out. ${detail}`;
      case "permission":
        return `Runtime permission denied. ${detail}`;
      case "transport":
        return `Runtime connection failed. ${detail}`;
    }
  }

  // Резерв: сопоставление строк для неклассифицированных ошибок или plain Error
  // (например, вывод CLI в stderr, исключения вне RuntimeExecutionError)
  // Спуск к тексту разрешён именно здесь, потому что ничего лучшего не осталось:
  // у неклассифицированной ошибки нет ни category, ни adapterCode. Проверки
  // только пополняют текст и не меняют управление; всё это в одном месте, чтобы
  // новые догадки не расползались по коду угадываний.
  const combinedLower = `${baseMessage} ${stderr}`.toLowerCase();

  if (combinedLower.includes("not logged in") || combinedLower.includes("/login")) {
    return `Runtime not logged in. Run claude /login. ${detail}`;
  }

  if (
    combinedLower.includes("rate limit") ||
    // Столько синонимов потому, что «лимит» в разных сборках CLI называется по-разному
    // (usage/quota/credits/extra usage) и формулировки меняются без предупреждения;
    // перечень здесь — единственное место, где это приходится знать.
    combinedLower.includes("usage limit") ||
    combinedLower.includes("extra usage") ||
    combinedLower.includes("out of extra usage") ||
    combinedLower.includes("quota") ||
    combinedLower.includes("credits")
  ) {
    return `Runtime usage limit reached. ${detail}`;
  }

  if (combinedLower.includes("stream closed") || combinedLower.includes("error in hook callback")) {
    // Сорванный поток чаще всего — следствие исключения внутри хука: SDK не
    // переживает throw из колбэка и обрывает итерацию. Поэтому сюда полезно
    // смотреть после правок в hooks.ts.
    return `Runtime stream interrupted during execution. ${detail}`;
  }

  if (stderr) {
    // Есть stderr, но он не узнан — самое честное: показать его как есть после
    // общего сообщения. Подсказок тут нет намеренно: выдуманная гипотеза при
    // наличии точных данных только сбивает с толку.
    return `${baseMessage}. Runtime stderr: ${stderr}`;
  }

  if (baseMessage.toLowerCase().includes("exited with code 1")) {
    // Самая дорогая в отладке ситуация: процесс умер, но ничего не сказал ни в
    // stderr, ни в stdout. Это ветка-памятка: перечислить самые частые причины
    // (логин, лимит, отказ настроек) и напомнить про версионного стража, чтобы
    // человек не искал причину в самом таске. Проверка про версию идёт последней —
    // именно её чаще всего упускают.
    return `${baseMessage}. No stderr/stdout captured from the SDK. Likely causes: auth or usage-limit, or Claude Code rejected a settings value — e.g. a build older than 2.1.191 rejects the empty attribution strings used to suppress Co-Authored-By trailers. The adapter pre-checks the Claude Code version (>= 2.1.191) before each run, reading the exact binary \`query()\` launches (an explicit override or the one bundled with @anthropic-ai/claude-agent-sdk). If this still fires, upgrade @anthropic-ai/claude-agent-sdk (SDK transport) or run \`npm i -g @anthropic-ai/claude-code@latest\` (CLI/explicit-binary transport).`;
  }

  // Ничего не совпало — отдаём сырое сообщение: лучше необъяснённый, но точный
  // исходный текст, чем выдуманная интерпретация, которая уведёт от реальной
  // причины.
  return baseMessage;
}

// Обрезка технического текста до журнальной длины: \s+ схлопывает переводы строк
// и отступы (многострочный стек не должен «разъезжаться» в логе), а лимит мешает
// одному абзацу заглушить остальные записи.
function trimForLog(text: string, maxLen = 1200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

// Последний рубеж диагностики: когда stderr пуст, а причина нужна, запускаем
// минимальный запрос к CLI и смотрим, как он отреагирует. Это именно «проверка
// живости», а не полноценный ран: маленький промпт, текстовый вывод, жёсткий
// таймаут. Промис разрешается всегда и никогда не реджектится — диагностика не
// имеет права бросить свою ошибку вместо исходной.
async function probeCliHealth(projectRoot: string, cliPath: string): Promise<string> {
  const cmd = cliPath || "claude";
  // Запрос намеренно тривиальный: он проверяет, что бинарник запускается и
  // отвечает, а не качество модели.
  const args = ["-p", "Reply with OK only", "--output-format", "text"];

  // Обёртка над событийным spawn в промис: вызывающему не нужен callback-стиль —
  // диагностика читается как линейное «получить ответ у CLI». Промис разрешается
  // ровно один раз, и все ветки ниже завершаются resolve, а не reject: бросок из
  // диагностики подменил бы исходную ошибку собственной.
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      // cwd проекта важен: CLI читает настройки/контекст от каталога, в котором
      // его запустили, и без него проверка шла бы по чужому профилю.
      cwd: projectRoot,
      // env наследуется целиком: credentials/подписки CLI живут в окружении и
      // файлах профиля, и обрезанное env дало бы ложное «not logged in».
      env: process.env,
      // stdin закрыт: probe не интерактивен и не должен ждать ввода — иначе он
      // повиснет до таймаута на каждом вызове.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    // Оба потока собираются: CLI может писать объяснение ошибки в любой из них,
    // а пустой stderr — не приговор. Разбирается склейка в обработчике close.
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      // Сбой запуска — тоже ответ для человека: именно он чаще всего и нужен
      // (бинарника нет / нет прав), поэтому обычным текстом, без throw.
      resolve(`Failed to execute CLI: ${err.message}`);
    });

    // Жёсткий потолок: probe не должен держать диагностику дольше разумного, а
    // SIGTERM — попытка убить процесс аккуратно, до SIGKILL'а дело не доходит.
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve("Timed out while probing CLI");
    }, 15000);

    child.on("close", (code) => {
      // Таймер снимается всегда: иначе он бы досрочно «убивал» уже завершённый
      // процесс и держал event loop (тот же урок, что в withTimeout.ts).
      clearTimeout(timeout);
      if (code === 0) {
        // Успех — пустая строка, а не «OK»: вызывающий код трактует пустоту как
        // «дополнительных сведений нет», и «OK только» не попадает в текст ошибки.
        resolve("");
        return;
      }

      // Избыточный вывод лучше пустого объяснения, а многострочность для
      // человека всё равно нормализует trimForLog.
      const merged = [stderr, stdout].filter(Boolean).join("\n");
      resolve(trimForLog(merged || `CLI exited with code ${code}`));
    });
  });
}

// Точка входа для вызывающего кода. Probe запускается только когда нет stderr и
// есть каталог проекта: без этих условий либо уже есть что сказать, либо нет
// места, где запускать CLI. Порядок защиты — сначала дешёвый источник (stderr).
export async function diagnoseClaudeError(
  input: RuntimeDiagnoseErrorInput,
  cliPath?: string,
): Promise<string> {
  let detail = input.stderrTail?.trim() ?? "";
  if (!detail && input.projectRoot) {
    detail = await probeCliHealth(input.projectRoot, cliPath ?? "claude");
  }
  return explainFailure(input.error, detail);
}
