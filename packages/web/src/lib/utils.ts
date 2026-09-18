import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Нормализует ввод репозитория к виду `namespace/name` для подключений
 * GitHub/GitLab. Принимает полный clone URL, ssh URL и короткий путь:
 *   https://gitlab.com/group/subgroup/repo.git  -> group/subgroup/repo
 *   git@gitlab.com:group/repo.git               -> group/repo
 *   group/repo/                                 -> group/repo
 * Если путь не распознан, возвращается исходное значение.
 */
export function normalizeRepositoryPath(value: string): string {
  let path = value.trim();
  if (!path) return path;

  // Убираем схему и хост из https://host/... и http://host/...
  const httpMatch = path.match(/^https?:\/\/[^/]+\/(.+)$/i);
  if (httpMatch) path = httpMatch[1];
  else {
    // Убираем префикс ssh в формате scp: git@host:path
    const sshMatch = path.match(/^[^@]+@[^:]+:(.+)$/);
    if (sshMatch) path = sshMatch[1];
    // Убираем префикс ssh://git@host/...
    const sshUrlMatch = path.match(/^ssh:\/\/[^/]+\/(.+)$/i);
    if (sshUrlMatch) path = sshUrlMatch[1];
  }

  // Убираем завершающий суффикс .git и хвостовые слэши
  path = path.replace(/\.git$/i, "").replace(/\/+$/g, "");
  return path;
}

/** Форматирует дату в относительное время (например, "2m ago"). */
export function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
