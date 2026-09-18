/**
 * Генерирует UUID v4 (RFC 4122), который работает и в небезопасных контекстах браузера.
 *
 * `crypto.randomUUID()` доступен только в безопасном контексте (HTTPS или
 * `http://localhost`). При обычном HTTP на внешнем хосте функция может быть
 * `undefined` и вызов бросит `TypeError`.
 *
 * Поэтому используется резерв: `crypto.getRandomValues()` с ручной сборкой UUID,
 * чтобы сохранить криптостойкую случайность без обязательного HTTPS.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID#secure_context
 */
export function randomUUID(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;

  // Безопасный контекст (https / localhost): используем нативную реализацию.
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }

  // Небезопасный контекст (обычный http на внешнем хосте):
  // если доступен getRandomValues, собираем UUID v4 из 16 случайных байт.
  if (typeof cryptoObj?.getRandomValues === "function") {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Крайний резерв (Web Crypto недоступен): не криптостойкий UUID v4.
  // Для ключей чата/потока этого достаточно и лучше, чем аварийный сбой.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
