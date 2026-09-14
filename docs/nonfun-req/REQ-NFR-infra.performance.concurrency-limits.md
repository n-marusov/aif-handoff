[← REQ-NFR-integration.availability.runtime-provider-fallback](REQ-NFR-integration.availability.runtime-provider-fallback.md) · [Back to README](README.md) · [REQ-NFR-data.compliance.database-migration-integrity →](REQ-NFR-data.compliance.database-migration-integrity.md)

# REQ-NFR-infra.performance.concurrency-limits

**Приоритет:** P2
**Статус:** implemented
**Класс:** as is
**Источник:** G1 (производительность конвейера); §2.6 (ограничение 5 — максимальное параллельное выполнение); `BR-constraint.automation.concurrency`
**Ключевая функция:** HF1, HF4
**Домен L1:** pipeline

## Описание

Параллельное выполнение задач coordinator ограничено на нескольких уровнях: общее количество одновременно обрабатываемых задач (COORDINATOR_MAX_CONCURRENT_TASKS), лимит задач на проект (COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT), количество одновременно обслуживаемых проектов (COORDINATOR_MAX_CONCURRENT_PROJECTS), лимит worker'ов на задачу (AIF_IMPLEMENT_MAX_WORKERS). Все лимиты конфигурируются через переменные окружения.

## Критерии приёмки

| Метрика           | Целевое значение                                                        | Способ проверки                                       |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Общий лимит задач | Не более COORDINATOR_MAX_CONCURRENT_TASKS (12 по умолчанию) параллельно | Нагрузочный тест: создание N задач, проверка счётчика |
| Лимит на проект   | Не более COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT (3 по умолчанию)  | Нагрузочный тест                                      |
| Лимит проектов    | Не более COORDINATOR_MAX_CONCURRENT_PROJECTS (4 по умолчанию)           | Нагрузочный тест                                      |
| Worker-лимит      | Не более AIF_IMPLEMENT_MAX_WORKERS worker'ов на задачу                  | Проверка: значение по умолчанию                       |
| Конфигурируемость | Все лимиты изменяются через переменные окружения                        | Проверка: установка, подтверждение                    |

## Связанные требования

- `BR-constraint.automation.concurrency`
- `REQ-NFR-api.performance.coordinator-polling-latency`
- `REQ-NFR-api.availability.coordinator-resilience`
- `REQ-NFR-infra.compliance.worktree-isolation`

## See Also

- [REQ-NFR-api.performance.coordinator-polling-latency](REQ-NFR-api.performance.coordinator-polling-latency.md)
- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [REQ-NFR-infra.compliance.worktree-isolation](REQ-NFR-infra.compliance.worktree-isolation.md)
