/**
 * Безопасная обёртка localStorage с SSR-защитой.
 */

export function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  if (typeof localStorage?.getItem !== "function") return null;
  return localStorage.getItem(key);
}

export function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  if (typeof localStorage?.setItem !== "function") return;
  localStorage.setItem(key, value);
}

export function removeStorage(key: string): void {
  if (typeof window === "undefined") return;
  if (typeof localStorage?.removeItem !== "function") return;
  localStorage.removeItem(key);
}
