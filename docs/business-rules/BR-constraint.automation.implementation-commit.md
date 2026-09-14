# BR-constraint.automation.implementation-commit — Автоматический коммит изменений реализации

> Все изменения, созданные или модифицированные implementer-субагентом в ходе выполнения задачи, автоматически коммитятся в ветку задачи перед публикацией в VCS (GitHub/GitLab).

[← Каталог правил](README.md)

| Поле          | Значение                                         |
| ------------- | ------------------------------------------------ |
| **ID**        | `BR-constraint.automation.implementation-commit` |
| **Тип**       | `constraint`                                     |
| **Домен**     | `automation`                                     |
| **Статус**    | Принято                                          |
| **Приоритет** | Высокий                                          |

## Правило

После завершения работы implementer-субагента все изменения в worktree задачи (новые файлы, модифицированные файлы, удалённые файлы) должны быть закоммичены до выполнения `git push` или публикации PR/MR. Коммит выполняется через субагент `/aif-commit`, который использует workspace tool `shell_exec` для выполнения shell-команд (включая git) в worktree задачи.

## Детализация

- **Порядок:** имплементация → коммит → push → публикация PR/MR.
- **Механизм:** `ensureAutoQueueTaskCommit` запускает субагент `/aif-commit` через `executeSubagentQuery`.
- **Инструмент:** субагент использует workspace tool `shell_exec` (определён в `workspaceTools.ts`) для выполнения shell-команд, включая `git add -A`, `git diff --cached`, `git commit -m ...`.
- **Промпт:** `buildAutoQueueCommitPrompt` (в `commitWorkflow.ts`) предписывает модели коммитить без подтверждения и использовать `shell_exec` вместо bash.
- **Верификация:** после завершения субагента проверяется, что worktree чист и HEAD сдвинулся ровно на один коммит.
- **Отсутствие избыточности:** если в worktree нет изменений, коммит не создаётся.
- **Блокировка:** если субагент не смог создать чистый коммит, задача переводится в `blocked_external` для ручного вмешательства.

## Обоснование

Без автоматического коммита изменения, созданные implementer-субагентом через `write_file` или `apply_patch`, остаются незакоммиченными в worktree. `publishGitHubTask` не может выполнить push ветки без коммита. Workspace tool `shell_exec` даёт LLM-субагенту возможность выполнять git-команды через API-транспорт, где нет shell/bash.

## Трассируемость

| Артефакт     | Ссылка                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Документация | [`docs/architecture.md`](../architecture.md) (Auto-queue commit gate, Workspace Tools), [`docs/vision.md`](../vision.md) §2.2 (HF4)                                                                               |
| Реализация   | `packages/agent/src/autoQueueCommit.ts` (функция `ensureAutoQueueTaskCommit`), `packages/agent/src/workspaceTools.ts` (`shell_exec` tool), `packages/shared/src/commitWorkflow.ts` (`buildAutoQueueCommitPrompt`) |

## Связанные правила

- [`BR-trigger.automation.completion-commit`](BR-trigger.automation.completion-commit.md) — коммит перед завершающим статусом
- [`BR-constraint.automation.workspace-tool-capability`](BR-constraint.automation.workspace-tool-capability.md) — полнота операций workspace tools
- [`BR-constraint.automation.verify-no-loop`](BR-constraint.automation.verify-no-loop.md) — запрет циклических перезапусков Verify
- [`BR-constraint.git.operation-lock`](BR-constraint.git.operation-lock.md) — сериализация Git-операций
