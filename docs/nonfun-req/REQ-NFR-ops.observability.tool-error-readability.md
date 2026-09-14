[← REQ-NFR-ops.observability.activity-log-batching](REQ-NFR-ops.observability.activity-log-batching.md) · [Back to README](README.md)

# REQ-NFR-ops.observability.tool-error-readability

**Приоритет:** P1
**Статус:** proposed
**Класс:** to be
**Источник:** G1 (бесперебойность hand-off-конвейера); G6 (качество результата); реверс-инжиниринг кода (`packages/agent/src/workspaceTools.ts`, `packages/agent/src/subagentQuery.ts`)
**Ключевая функция:** HF1.4, HF4.1
**Домен L1:** pipeline

## Описание

Ошибки выполнения workspace tools, возвращаемые модели AI через механизм tool-результатов, должны быть сформулированы в форме, понятной языковой модели, чтобы модель могла самостоятельно исправить вызов без потери контекста задачи.

Основные требования:

1. **ZodError** (ошибка валидации аргументов) не передаётся модели в сыром JSON-формате. Вместо этого формируется структурированное текстовое сообщение с указанием:
   - Какое поле не прошло валидацию
   - Почему (пустая строка, неверный тип, неизвестный ключ)
   - Что ожидается вместо переданного значения (подсказка)
2. **ENOENT / file not found** — ошибка чтения несуществующего файла должна содержать подсказку об использовании `write_file` для создания нового файла.
3. **Прочие ошибки** — сообщение передаётся модели как текст с префиксом `ERROR:` (через механизм `.catch()` в `subagentQuery.ts`).
4. **Самовосстановление** — модель должна иметь возможность на следующем шаге вызвать корректный инструмент на основе полученного сообщения об ошибке, без ручного вмешательства.

## Критерии приёмки

| Метрика                                        | Целевое значение                                                                     | Способ проверки                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| ZodError → читаемое сообщение                  | 100% ошибок ZodError преобразуются в текст с указанием проблемного поля и подсказкой | Модульный тест workspaceTools                  |
| Несуществующий файл → подсказка про write_file | Сообщение об отсутствии файла содержит фразу "use write_file to create new files"    | Модульный тест workspaceTools                  |
| Самовосстановление модели (интеграционный)     | Модель после получения ошибки `apply_patch` на новом файле вызывает `write_file`     | Интеграционный тест: симуляция цикла tool-call |

## Связанные требования

- `BR-constraint.automation.workspace-tool-capability`
- `REQ-FR-pipeline.implementation.create-workspace-files`
- `REQ-FR-pipeline.implementation.execute-change-in-isolation`
- `REQ-NFR-ops.observability.error-categorization`

## See Also

- [REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md)
- [REQ-FR-pipeline.implementation.create-workspace-files](../fun-req/REQ-FR-pipeline.implementation.create-workspace-files.md)
