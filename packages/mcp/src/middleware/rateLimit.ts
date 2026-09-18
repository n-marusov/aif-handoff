import { logger } from "@aif/shared";

const log = logger("mcp:rate-limit");

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterConfig {
  /** Максимум запросов в минуту */
  rpm: number;
  /** Максимальный размер всплеска (ёмкость корзины) */
  burst: number;
}

/**
 * Ограничитель частоты на токеной корзине для MCP-инструментов.
 * У каждой категории инструментов (read/write) своя корзина.
 */
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly readConfig: RateLimiterConfig;
  private readonly writeConfig: RateLimiterConfig;

  constructor(readConfig: RateLimiterConfig, writeConfig: RateLimiterConfig) {
    this.readConfig = readConfig;
    this.writeConfig = writeConfig;
  }

  /**
   * Проверяет, разрешён ли вызов инструмента. true — разрешён, false — лимит исчерпан.
   */
  check(toolName: string, category: "read" | "write"): boolean {
    const config = category === "read" ? this.readConfig : this.writeConfig;
    const key = `${category}:${toolName}`;
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: config.burst, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Пополняем токены исходя из истёкшего времени
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = (elapsed / 60_000) * config.rpm;
    bucket.tokens = Math.min(config.burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    log.debug(
      { toolName, category, tokens: bucket.tokens.toFixed(2), burst: config.burst },
      "Token bucket state",
    );

    if (bucket.tokens < 1) {
      log.warn({ toolName, category, tokens: bucket.tokens.toFixed(2) }, "Rate limit hit");
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }
}
