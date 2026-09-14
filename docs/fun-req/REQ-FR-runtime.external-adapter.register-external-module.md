[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-runtime.external-adapter.register-external-module: Подключение внешнего runtime-адаптера

**Приоритет:** P2

**Ключевая функция:** HF3.3 Подключение внешних адаптеров

**Источник:** [UC-runtime.external-adapter.register-external-module](../use-cases/UC-runtime.external-adapter.register-external-module.md), BR-project.runtime-profiles

**Статус:** proposed

**Класс:** as is

**Канал:** API (env var AIF_RUNTIME_MODULES)

**Описание:** Администратор подключает внешний runtime-адаптер через переменную окружения `AIF_RUNTIME_MODULES` без изменения кода системы. Модуль загружается динамически через `resolveRuntimeModuleRegistrar` и регистрируется в `RuntimeRegistry`.

**Критерии приёмки:**

1. Администратор устанавливает переменную окружения `AIF_RUNTIME_MODULES` с путём к модулю.
2. При старте системы `bootstrapRuntimeRegistry` вызывает `resolveRuntimeModuleRegistrar`.
3. Модуль импортируется динамически через `require()`.
4. Модуль вызывает `registerRuntimeModule(module)` с фабрикой адаптера, runtimeId, providerId, capabilities.
5. Адаптер регистрируется в `RuntimeRegistry` и становится доступным для выбора в runtime-профилях.
6. Если модуль не найден — `RuntimeModuleLoadError`, система логирует ошибку и продолжает работу.
7. При ошибке валидации — `RuntimeModuleValidationError`, модуль загружен, но не соответствует контракту.
8. `AIF_RUNTIME_MODULES` поддерживает разделение путей через запятую (несколько модулей).

## See Also

- [REQ-FR-runtime.profile.configure-project-runtime](REQ-FR-runtime.profile.configure-project-runtime.md) — настройка профилей
- [REQ-FR-runtime.override.override-profile-for-task](REQ-FR-runtime.override.override-profile-for-task.md) — переопределение
