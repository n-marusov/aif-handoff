import { NON_COMMIT_PATH_PATTERNS } from "./constants.js";

const NEVER_STAGE_PATTERNS = NON_COMMIT_PATH_PATTERNS;
const NEVER_STAGE_NOTE = `Do NOT stage or commit infrastructure directories: ${NEVER_STAGE_PATTERNS.join(", ")}. These are local tooling artifacts and must not appear in the repository.`;

export function buildCommitPrompt(shouldPush: boolean): string {
  const pushLine = shouldPush
    ? "5. After committing, run `git push` on the current branch. Do not force-push."
    : "5. Do NOT push. The project is configured with `git.skip_push_after_commit: true` — commit only.";

  return [
    "You are running the aif-commit workflow. Follow these steps exactly:",
    "",
    "1. Run `git status` to see the current working tree.",
    `2. Stage all changes, excluding infrastructure directories. Run: git add -A && git reset -- ${NEVER_STAGE_PATTERNS.map((p) => `${p}`).join(" ")}`,
    `   ${NEVER_STAGE_NOTE}`,
    "3. Analyze the staged diff (`git diff --cached`) and draft ONE conventional commit message (feat/fix/chore/docs/refactor/test/perf, optional scope, short subject, body if helpful).",
    "4. Create the commit with `git commit -m ...`. Create exactly one commit. Do not amend.",
    pushLine,
    "",
    "Hard rules:",
    "- Never skip git hooks (no --no-verify).",
    "- Never rewrite history (no rebase, no reset --hard, no amend).",
    "- Never add the `Co-Authored-By` trailer.",
    "- If there are no changes to commit, report that and stop — do NOT create an empty commit.",
  ].join("\n");
}

/**
 * Non-interactive auto-queue commit prompt.
 *
 * Unlike {@link buildCommitPrompt}, this variant:
 * 1. Instructs the model to use the `shell_exec` workspace tool instead of running
 *    commands directly in bash — this works with API transport where only workspace
 *    tools are exposed.
 * 2. Omits the confirmation step — the model commits automatically without asking
 *    the user.
 * 3. Is used by {@link ensureAutoQueueTaskCommit} when the runtime transport
 *    does not provide native shell/git access (e.g., API transport).
 */
export function buildAutoQueueCommitPrompt(): string {
  const resetPathList = NEVER_STAGE_PATTERNS.join(" ");
  return [
    "You are running the auto-queue commit workflow. Commit all changes without questions.",
    "",
    "Available workspace tools: read_file, list_dir, write_file, apply_patch, shell_exec.",
    "Use the `shell_exec` tool to run ALL shell commands — including git commands.",
    "",
    "Follow these steps exactly:",
    "",
    '1. Run `git status --porcelain` via shell_exec: {"command": "git status --porcelain"}.',
    "   If there are no changes, report that nothing to commit and stop.",
    `2. Stage all changes, excluding infrastructure directories: {"command": "git add -A && git reset -- ${resetPathList}"}.`,
    `   ${NEVER_STAGE_NOTE}`,
    '3. Analyze the staged diff: {"command": "git diff --cached"}.',
    "4. Draft ONE conventional commit message (feat/fix/chore/docs/refactor/test/perf, optional scope, short subject, body if helpful).",
    '5. Create the commit: {"command": "git commit -m <subject> -m <body>"}. Use exactly one commit. Do not amend.',
    "",
    "Hard rules:",
    "- Never skip git hooks (no --no-verify flag for git commit).",
    "- Never rewrite history (no rebase, no reset --hard, no amend).",
    "- Never add the `Co-Authored-By` trailer.",
    "- If there are no changes to commit, report that and stop — do NOT create an empty commit.",
    "- Do NOT ask the user for confirmation. Commit immediately.",
    "- Do NOT push. The auto-queue flow will push the branch after the commit.",
  ].join("\n");
}
