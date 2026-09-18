# Quality Assurance — AIF Handoff

Матрица трассируемости функциональных требований (FR) → тесты. Каждый FR из каталога `docs/fun-req/` должен иметь хотя бы один ссылающийся тест; покрытие критических (P0) и важных (P1) требований обязательно.

Связи фиксируются в коде через комментарии вида `// REQ-FR-<ID>: <критерий>` и `// REQ-NFR-<ID>: <метрика>`.

## Матрица FR → тесты

| FR-ID                                                     | Приоритет | Тест-файл                                   | Ключевые тесты (критерии)                                                                                                                                                   |
| --------------------------------------------------------- | --------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQ-FR-integration.pr-mr.resolve-review-decision`        | P1        | `packages/api/src/__tests__/gitlab.test.ts` | `maps approvals … to reviewState %s` (criterion 2), `detects the latest approval-revocation note` (criterion 9), `ignores a revoked plan_review approval …` (criteria 3–14) |
| `REQ-NFR-integration.compliance.review-event-idempotency` | P1        | `packages/api/src/__tests__/gitlab.test.ts` | `ignores a revoked plan_review approval …` (все 4 метрики: однократность, ретрай, порядок отметки, наблюдаемость)                                                           |
