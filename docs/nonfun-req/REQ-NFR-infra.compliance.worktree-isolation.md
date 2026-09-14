[← REQ-NFR-ops.observability.activity-log-batching](REQ-NFR-ops.observability.activity-log-batching.md) · [Back to README](README.md)

# REQ-NFR-infra.compliance.worktree-isolation

**Приоритет:** P2
**Статус:** implemented
**Класс:** as is
**Источник:** G4 (изоляция изменений — параллельное выполнение); §2.6 (ограничение 5 — максимальное параллельное выполнение); `BR-constraint.git.worktree-isolation`
**Ключевая функция:** HF4, HF4.1
**Домен L1:** pipeline

## Описание

Каждое выполнение задачи изолировано в отдельном git-worktree (или shared branch с блокировкой). Изоляция предотвращает конфликты между параллельными изменениями. Рабочее дерево задачи определяется веткой; при отсутствии worktree-изоляции проект обрабатывается эксклюзивно.

## Критерии приёмки

| Метрика                      | Целевое значение                                               | Способ проверки                                    |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Изоляция worktree            | Разные задачи в одном проекте используют разные worktree/ветки | Интеграционный тест: две параллельные задачи       |
| Очистка worktree             | Worktree удаляется после завершения задачи                     | Тест: завершение задачи, проверка файловой системы |
| Эксклюзивность shared branch | Проект без worktree обрабатывается последовательно             | Тест: вторая задача ждёт первую                    |
| Конфигурируемость            | Worktree включается/выключается feature-флагом                 | Проверка: AIF_TASK_WORKTREES_ENABLED               |

## Связанные требования

- `BR-constraint.git.worktree-isolation`
- `BR-constraint.automation.concurrency`
- `BR-constraint.git.operation-lock`
- `REQ-NFR-infra.performance.concurrency-limits`

## See Also

- [REQ-NFR-infra.performance.concurrency-limits](REQ-NFR-infra.performance.concurrency-limits.md)
- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [REQ-NFR-api.performance.coordinator-polling-latency](REQ-NFR-api.performance.coordinator-polling-latency.md)
