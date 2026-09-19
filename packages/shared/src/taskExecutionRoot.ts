/**
 * Единое правило «корня исполнения» задачи.
 *
 * Задача, изолированная в git-worktree, исполняется в своём дереве; остальные —
 * в корне проекта. Фраза `task.worktreePath ?? project.rootPath` раньше была
 * размазана по api/agent в ~15 местах; теперь это один хелпер, чтобы ни один
 * вызов не мог выбрать другой корень (например, попасть в общий клон).
 *
 * Типы полей намеренно свободные: сюда можно передать строку БД задачи и проекта
 * (row-типы не входят в публичный контракт доставок).
 */
export interface TaskExecutionRootFields {
  worktreePath?: string | null;
  rootPath: string;
}

/** Корень исполнения: worktree задачи при наличии, иначе корень проекта. */
export function taskExecutionRoot(fields: TaskExecutionRootFields): string {
  return fields.worktreePath ?? fields.rootPath;
}
