// Уведомления в Telegram о смене статуса задачи.
//
// Отправка best-effort: отсутствие токена - не ошибка, а выключенная интеграция,
// поэтому функция просто возвращает управление. Провал HTTP-запроса тоже не
// пробрасывается наружу: уведомление не должно ронять обработку задачи.
//
// Токены читаются из process.env в момент вызова, а не через кэшированный getEnv():
// так работают тестовые подстановки, и необязательная настройка Telegram не
// заставляет валидировать всё окружение целиком.

import { getEnv } from "./env.js";
import { logger } from "./logger.js";

const log = logger("telegram");

/**
 * Экранирует спецсимволы для режима разборки Telegram MarkdownV2.
 */
// MarkdownV2 требует экранировать каждый служебный символ, а не только открывающий:
// лишняя или незакрытая звёздочка приводит к тому, что Telegram отклоняет всё
// сообщение целиком, а не только испорченный фрагмент.
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export interface TelegramNotificationOptions {
  taskId: string;
  projectName?: string;
  resolveProjectName?: () => string | undefined;
  title?: string;
  fromStatus?: string;
  toStatus?: string;
}

/**
 * Отправляет уведомление о смене статуса задачи по принципу best-effort.
 * Молча возвращается, если TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID не настроены.
 *
 * Токены читаются напрямую из process.env в момент вызова (а не через кэшированный getEnv()),
 * чтобы работали тестовые подстановки (vi.stubEnv) и чтобы необязательная конфигурация
 * Telegram не требовала валидации всего окружения.
 */
export async function sendTelegramNotification(
  options: TelegramNotificationOptions,
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const userId = process.env.TELEGRAM_USER_ID;
  // Базовый URL настраивается для прокси и тестовых серверов; хвостовые слэши
  // срезаются, иначе в итоговом адресе появится двойной слэш.
  const apiBaseUrl = (process.env.TELEGRAM_BOT_API_URL ?? "https://api.telegram.org")
    .trim()
    .replace(/\/+$/, "");
  // Не сконфигурировано - молча выходим: интеграция необязательна.
  if (!botToken || !userId) return;

  // Короткий префикс идентификатора используется как замена заголовку: полный UUID
  // занял бы всю строку уведомления и вытеснил информацию о статусе.
  const displayTitle = options.title ?? options.taskId.slice(0, 8);
  const transition =
    options.fromStatus && options.toStatus
      ? `${options.fromStatus} → ${options.toStatus}`
      : (options.toStatus ?? "updated");

  let projectName: string | undefined;
  if (getEnv().AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED) {
    projectName = options.projectName;
    if (projectName === undefined && options.resolveProjectName) {
      try {
        projectName = options.resolveProjectName();
        log.debug(
          { taskId: options.taskId, projectResolved: projectName !== undefined },
          "Telegram project lookup completed",
        );
      } catch (err) {
        // Ошибка поиска имени проекта не критична: уведомление уйдёт без названия
        // проекта, но с задачей и переходом статуса.
        log.debug({ taskId: options.taskId, err }, "Telegram project lookup failed");
      }
    }
  }

  const escapedTitle = escapeMarkdown(displayTitle);
  const text = projectName
    ? `📁 *${escapeMarkdown(projectName)}*\n📋 ${escapedTitle}\n${escapeMarkdown(transition)}`
    : `📋 *${escapedTitle}*\n${escapeMarkdown(transition)}`;

  try {
    const res = await fetch(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: userId, text, parse_mode: "MarkdownV2" }),
    });

    // Уровень debug, а не warn: недоступность Telegram не влияет на ход задачи, и
    // такие записи не должны шуметь в обычном режиме логирования.
    if (!res.ok) {
      log.debug({ taskId: options.taskId, status: res.status }, "Telegram notification failed");
    }
  } catch (err) {
    // Сетевые ошибки гасятся здесь же: наружу функция не бросает ничего.
    log.debug({ taskId: options.taskId, err }, "Telegram notification request failed");
  }
}
