/**
 * Реэкспорт хелперов веток и worktree для кода агента.
 *
 * Реализация живёт в @aif/shared; здесь только фасад, чтобы импортные пути внутри
 * агента не расползались по разным модулям. При переносе логики меняется один
 * файл, а не десятки вызовов по пакету.
 */

// Список реэкспорта поддерживается вручную: собственной логики у файла нет.
export {
  BranchIsolationError,
  assertCurrentBranch,
  assertWorkingTreeClean,
  branchExists,
  buildBranchName,
  buildProjectWorktreeSegment,
  buildTaskWorktreePath,
  describeDirtyWorkingTree,
  ensureFeatureBranch,
  ensureTaskWorktree,
  getCurrentBranch,
  isBranchIsolationError,
  isGitRepo,
  isWorktreeUsable,
  listChangedFiles,
  listCommitFiles,
  listWorktrees,
  projectSupportsTaskWorktrees,
  projectUsesSharedBranchIsolation,
  pruneWorktrees,
  removeWorktreeForce,
  resolveWorktreeRoot,
  restorePersistedBranch,
  slugifyTitle,
  validateBranchName,
  workingTreeClean,
  type BuildTaskWorktreePathInput,
  type EnsureFeatureBranchInput,
  type EnsureFeatureBranchResult,
  type EnsureTaskWorktreeInput,
  type EnsureTaskWorktreeResult,
  type RestorePersistedBranchInput,
  type WorktreeEntry,
} from "@aif/shared";
