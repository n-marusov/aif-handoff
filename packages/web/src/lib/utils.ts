import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Normalize a repository input into `namespace/name` form for GitHub/GitLab
 * connections. Accepts full clone URLs, ssh URLs, and bare paths:
 *   https://gitlab.com/group/subgroup/repo.git  → group/subgroup/repo
 *   git@gitlab.com:group/repo.git               → group/repo
 *   group/repo/                                 → group/repo
 * Returns the input unchanged if it cannot be parsed as a path.
 */
export function normalizeRepositoryPath(value: string): string {
  let path = value.trim();
  if (!path) return path;

  // Strip scheme+host from https://host/... and http://host/...
  const httpMatch = path.match(/^https?:\/\/[^/]+\/(.+)$/i);
  if (httpMatch) path = httpMatch[1];
  else {
    // Strip ssh scp-style git@host:path
    const sshMatch = path.match(/^[^@]+@[^:]+:(.+)$/);
    if (sshMatch) path = sshMatch[1];
    // Strip ssh://git@host/...
    const sshUrlMatch = path.match(/^ssh:\/\/[^/]+\/(.+)$/i);
    if (sshUrlMatch) path = sshUrlMatch[1];
  }

  // Strip trailing .git suffix and trailing slashes
  path = path.replace(/\.git$/i, "").replace(/\/+$/g, "");
  return path;
}

/** Format a date string to relative time (e.g., "2m ago") */
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
