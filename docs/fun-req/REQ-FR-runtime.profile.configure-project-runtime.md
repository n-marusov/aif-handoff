[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-runtime.profile.configure-project-runtime: Настройка runtime-профиля для проекта

**Приоритет:** P0

**Ключевая функция:** HF3.1 Настройка runtime-профиля для проекта

**Источник:** [UC-runtime.profile.configure-project-runtime](../use-cases/UC-runtime.profile.configure-project-runtime.md), BR-fact.project.runtime-profiles

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (ProjectRuntimeSettings) / API (REST)

**Описание:** Администратор настраивает runtime-профили проекта: выбирает AI-провайдера для каждой стадии конвейера (планирование, реализация, ревью, чат). Runtime-профиль определяет, какой адаптер (Claude, Codex, OpenRouter, OpenCode) и какая модель используется для задач проекта. Cascade resolution: задача → проект → система → окружение.

**Критерии приёмки:**

1. Пользователь с ролью `admin` открывает ProjectRuntimeSettings.
2. UI загружает список runtime-профилей проекта (`GET /api/runtime-profiles?projectId=X`).
3. Для каждого профиля отображаются: имя, runtimeId (claude/codex/opencode/openrouter), модель, транспорт (SDK/CLI/API/APP_SERVER), usage (токены, стоимость).
4. Пользователь создаёт/редактирует профиль: указывает `runtimeId`, `providerId`, `transport`, `baseUrl`, `defaultModel`, опциональные `headers` и `options`.
5. Профиль привязывается к стадиям проекта: `defaultTaskRuntimeProfileId`, `defaultPlanRuntimeProfileId`, `defaultReviewRuntimeProfileId`, `defaultChatRuntimeProfileId`.
6. APIKey указывается как переменная окружения (`apiKeyEnvVar`).
7. Если для проекта не указан профиль, используется системный по умолчанию через `getAppDefaultRuntimeProfileId`.
8. Глобальные профили (без `projectId`) доступны всем проектам.
9. UI может показать список доступных моделей через `createRuntimeModelDiscoveryService`.

## See Also

- [REQ-FR-runtime.override.override-profile-for-task](REQ-FR-runtime.override.override-profile-for-task.md) — переопределение для задачи
- [REQ-FR-runtime.external-adapter.register-external-module](REQ-FR-runtime.external-adapter.register-external-module.md) — внешние адаптеры
- [REQ-FR-accounting.tracking.record-runtime-call](REQ-FR-accounting.tracking.record-runtime-call.md) — учёт usage
