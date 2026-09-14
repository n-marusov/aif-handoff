[← REQ-NFR-infra.performance.concurrency-limits](REQ-NFR-infra.performance.concurrency-limits.md) · [Back to README](README.md) · [REQ-NFR-ops.observability.activity-log-batching →](REQ-NFR-ops.observability.activity-log-batching.md)

# REQ-NFR-infra.performance.implementation-commit-latency

**Приоритет:** P1
**Статус:** proposed
**Класс:** to be
**Источник:** G1 (бесперебойность hand-off-конвейера); BR-constraint.automation.implementation-commit; реверс-инжиниринг кода (`packages/agent/src/autoQueueCommit.ts`)
**Ключевая функция:** HF1.4, HF4.1
**Домен L1:** pipeline

## Описание

Операция коммита изменений реализации (создание git-коммита после работы implementer-субагента) должна выполняться с минимальной задержкой, чтобы не замедлять прохождение задачи по конвейеру.

Требования к производительности:

1. **aif-commit:** субагент `/aif-commit` генерирует conventional commit message и через `shell_exec` выполняет `git add -A && git commit`. Вся операция не должна занимать более 60 секунд с учётом network latency.
2. **Shell-команды:** непосредственное выполнение git-команд через `shell_exec` не должно добавлять более 5 секунд к общему времени коммита.
3. **Общий лимит:** полный цикл implementer → коммит → push не должен превышать 120 секунд для типовой задачи.

## Критерии приёмки

| Метрика                                   | Целевое значение                      | Способ проверки                         |
| ----------------------------------------- | ------------------------------------- | --------------------------------------- |
| aif-commit subagent (генерация сообщения) | ≤ 60 секунд с учётом network latency  | Интеграционный тест                     |
| shell_exec: git add + git commit          | ≤ 5 секунд для типового набора файлов | Тест: имитация коммита через shell_exec |
| Полный цикл: implementer → коммит → push  | ≤ 120 секунд для типовой задачи       | E2E-тест                                |

## Связанные требования

- `BR-constraint.automation.implementation-commit`
- `REQ-FR-pipeline.implementation.create-workspace-files`
- `REQ-FR-pipeline.implementation.execute-change-in-isolation`
- `REQ-NFR-api.performance.coordinator-polling-latency`

## See Also

- [REQ-NFR-api.performance.coordinator-polling-latency](REQ-NFR-api.performance.coordinator-polling-latency.md)
- [REQ-FR-pipeline.implementation.create-workspace-files](../fun-req/REQ-FR-pipeline.implementation.create-workspace-files.md)
