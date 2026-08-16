/**
 * Loop-detection classification: which tool calls count as "read-only" for the
 * read-only-burst guard. A burst of read-only calls with no intervening write
 * is treated as a probable runaway loop (e.g. an agent re-running
 * `git diff <sha>^ <sha> -- <file>` hundreds of times without mutating anything).
 */

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

/** Prefix-anchored read-only shell command patterns. */
export const READ_ONLY_BASH_PATTERNS =
  /(?:^|\s)(?:git\s+(?:show|diff|status|log|grep|ls-files)|cat\s|sed\s|rg\s|ls\s|head\s|tail\s|wc\s|find\s|grep\s)/;

export function isReadOnlyToolCall(toolName: string, detail: string | undefined): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (toolName === "Bash" && detail) {
    return READ_ONLY_BASH_PATTERNS.test(detail);
  }
  return false;
}
