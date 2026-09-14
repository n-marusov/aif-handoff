[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-runtime.override.override-profile-for-task: Переопределение runtime-профиля для задачи

**Приоритет:** P1

**Ключевая функция:** HF3.2 Переопределение профиля для конкретного изменения

**Источник:** [UC-runtime.override.override-profile-for-task](../use-cases/UC-runtime.override.override-profile-for-task.md), BR-fact.project.runtime-profiles

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (TaskSettings) / API (REST)

**Описание:** Разработчик переопределяет runtime-профиль для конкретной задачи, выбирая другого провайдера или модель. Переопределение действует только для этой задачи. Cascade resolution: `runtimeProfileId` задачи → `default*RuntimeProfileId` проекта → системный дефолт.

**Критерии приёмки:**

1. Пользователь открывает TaskSettings в детальном просмотре задачи.
2. UI показывает текущий Effective Runtime Profile (на основе cascade resolution).
3. Пользователь выбирает другой профиль из доступных для проекта.
4. API устанавливает `runtimeProfileId` на задаче (`PUT /api/tasks/:id { runtimeProfileId }`).
5. Cascade resolution использует: `runtimeProfileId` задачи → `default*RuntimeProfileId` проекта → системный дефолт.
6. Можно переопределить только модель (`modelOverride`), не меняя профиль.
7. Сброс `runtimeProfileId` в null возвращает к дефолту проекта.
8. При следующем запуске Coordinator использует указанный профиль.

## See Also

- [REQ-FR-runtime.profile.configure-project-runtime](REQ-FR-runtime.profile.configure-project-runtime.md) — настройка профилей
- [REQ-FR-runtime.external-adapter.register-external-module](REQ-FR-runtime.external-adapter.register-external-module.md) — внешние адаптеры
