[← REQ-NFR-data.compliance.task-transactional-consistency](REQ-NFR-data.compliance.task-transactional-consistency.md) · [Back to README](README.md) · [REQ-NFR-api.performance.coordinator-polling-latency →](REQ-NFR-api.performance.coordinator-polling-latency.md)

# REQ-NFR-api.availability.coordinator-resilience

**Приоритет:** P0
**Статус:** implemented
**Класс:** as is
**Источник:** G1 (бесперебойность hand-off-конвейера); G5 (доступность независимой проверки); A3 (непрерывная работа); A5 (стабильность исполнителя)
**Ключевая функция:** HF1, HF1.1
**Домен L1:** pipeline

## Описание

Coordinator должен корректно обрабатывать сценарии сбоев и восстанавливаться без потери контекста задач:

1. **Аварийное завершение** — запущенные задачи не теряются; после перезапуска зависшие блокировки освобождаются, задачи возвращаются в корректное состояние.
2. **Блокировка внешней системы** (VCS, AI-провайдер) — задача переводится в блокированное состояние с сохранением исходной стадии; при retry возвращается на неё.
3. **Таймаут стадии** — при превышении лимита времени задача блокируется с эскалацией.
4. **Stale-таймаут** — отсутствие активности задачи в течение настроенного периода переводит её в блокированное состояние после исчерпания попыток.
5. **Git-операции сериализованы по проекту** — исключение взаимоблокировок при параллельных VCS-операциях.
6. **Per-проектный claim-механизм** — предотвращение параллельной обработки проектов без изоляции.

## Критерии приёмки

| Метрика                                    | Целевое значение                                                                           | Способ проверки                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| Восстановление после аварийного завершения | 100% незавершённых задач восстанавливаются после перезапуска coordinator                   | Интеграционный тест                     |
| Stale-блокировка                           | Задача без активности более установленного таймаута блокируется после N попыток            | Тест: имитация зависшей задачи          |
| Таймаут стадии                             | Превышение лимита времени выполнения блокирует задачу                                      | Тест: имитация долгого выполнения       |
| Блокировка при внешнем сбое                | При недоступности внешней системы задача переходит в blocked с сохранением исходной стадии | Тест: имитация отказа VCS/AI-провайдера |
| Сериализация git-операций                  | Параллельные git-операции на одном проекте не выполняются конкурентно                      | Тест: имитация параллельных вызовов     |

## Связанные требования

- `BR-trigger.automation.failure-recovery`
- `BR-constraint.automation.concurrency`
- `BR-constraint.git.operation-lock`
- `BR-trigger.task-lifecycle.blocked`
- `REQ-NFR-data.compliance.task-state-persistence`
- `REQ-NFR-ops.observability.heartbeat-detection`

## See Also

- [REQ-NFR-api.performance.coordinator-polling-latency](REQ-NFR-api.performance.coordinator-polling-latency.md)
- [REQ-NFR-ops.observability.heartbeat-detection](REQ-NFR-ops.observability.heartbeat-detection.md)
- [REQ-NFR-data.compliance.task-state-persistence](REQ-NFR-data.compliance.task-state-persistence.md)
