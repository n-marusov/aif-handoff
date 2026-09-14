[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.independent-verification.verify-independently: Независимая верификация после гейтов

**Приоритет:** P1

**Ключевая функция:** HF5.4 Независимая верификация

**Источник:** [UC-pipeline.independent-verification.verify-independently](../use-cases/UC-pipeline.independent-verification.verify-independently.md), BR-automation.qa

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter → AI provider, lightweight model)

**Описание:** После прохождения формального гейта и перед ревью Coordinator запускает независимую верификацию (verify-sidecar). Верификатор действует независимо от реализатора: использует отдельный runtime-профиль (lightweight-модель), read-only доступ и собственный agent definition.

**Критерии приёмки:**

1. Coordinator выбирает задачу в статусе `verify`.
2. Запускает `runVerifier` с отдельным runtime-профилем (`reviewRuntimeProfileId`).
3. Верификатор использует lightweight-модель (lightModel конфигурации).
4. Выполняет read-only проверку изменения в Git worktree.
5. Результат: `pass` → переход в `review`; `fail` → возврат в `implementing` с `reworkRequested=true`.
6. Верификатор сохраняет результат проверки в `AutoReviewState`.
7. Если `runPostVerify=false`, задача переходит из `implementing` в `review` минуя верификацию (для human-owner).
8. Для human-owner задачи человек вызывает `pass_verification` или `fail_verification` через UI.

## See Also

- [REQ-FR-pipeline.verification.verify-change-result](REQ-FR-pipeline.verification.verify-change-result.md) — верификация
- [REQ-FR-pipeline.sidecar.run-read-only-review](REQ-FR-pipeline.sidecar.run-read-only-review.md) — sidecar-агенты
- [REQ-FR-pipeline.review-loop.iterate-review-feedback](REQ-FR-pipeline.review-loop.iterate-review-feedback.md) — цикл доработки
