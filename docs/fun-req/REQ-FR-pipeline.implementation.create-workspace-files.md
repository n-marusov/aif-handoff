[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.implementation.create-workspace-files: Создание новых файлов при реализации изменений

**Приоритет:** P1

**Ключевая функция:** HF1.4 Реализация изменения AI, HF4.1 Изолированное выполнение

**Источник:** [UC-pipeline.implementation.execute-change-in-isolation](../use-cases/UC-pipeline.implementation.execute-change-in-isolation.md), BR-constraint.automation.workspace-tool-capability, BR-constraint.automation.implementation-commit

**Статус:** proposed

**Класс:** to be

**Канал:** Agent (runtime adapter → AI provider, workspace tools)

**Описание:** Workspace tools implementer-субагента должны включать инструмент создания новых файлов. При выполнении плана задачи, содержащего создание новых артефактов (файлы конфигурации, документация, тесты, исходный код), реализатор использует `write_file` для записи файла по указанному относительному пути. Родительские директории создаются автоматически. Для существующих файлов приоритетным инструментом остаётся `apply_patch`.

**Критерии приёмки:**

1. Workspace tool `write_file` определён в `WORKSPACE_TOOL_DEFINITIONS` и экспортирован как часть набора инструментов.
2. `write_file` принимает параметры `path` (строка, относительный путь) и `content` (строка, полное содержимое файла).
3. При вызове `write_file` с корректными аргументами создаётся новый файл по указанному пути; если родительская директория не существует — она создаётся рекурсивно.
4. При вызове `write_file` с путём к существующему файлу содержимое файла перезаписывается.
5. Возвращаемое значение содержит количество записанных символов и имя файла.
6. Пути за пределами рабочей директории или содержащие зарезервированные имена (`.git`, `node_modules`, `.env`, `.llm-backup`) отклоняются с ошибкой.
7. План задачи может включать создание новых файлов (например, `hello.md`, `test/hello_file_test.go`), и реализатор способен выполнить этот шаг без ошибок инструмента.
8. `apply_patch` не используется для создания файлов — модель направляется к `write_file` через описание инструмента.
9. Набор workspace tools включает инструмент `shell_exec` для выполнения shell-команд (включая git) в worktree задачи, что позволяет субагенту `/aif-commit` работать через API-транспорт.
10. После завершения работы реализатора все созданные и изменённые файлы автоматически коммитятся в ветку задачи перед публикацией в VCS.

## See Also

- [REQ-FR-pipeline.implementation.execute-change-in-isolation](REQ-FR-pipeline.implementation.execute-change-in-isolation.md) — реализация изменения в изолированном контексте
- [REQ-FR-pipeline.plan.generate-plan-from-context](REQ-FR-pipeline.plan.generate-plan-from-context.md) — генерация плана изменения
- [BR-constraint.automation.workspace-tool-capability](../business-rules/BR-constraint.automation.workspace-tool-capability.md) — полнота операций workspace tools
- [BR-constraint.automation.implementation-commit](../business-rules/BR-constraint.automation.implementation-commit.md) — автоматический коммит изменений реализации
