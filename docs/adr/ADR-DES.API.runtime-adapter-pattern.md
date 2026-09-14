# ADR-DES.API.runtime-adapter-pattern

**Статус:** ПРИНЯТО
**Дата:** 2026-09-14
**Контекст:** Система управляет задачами через AI-конвейер, где разные провайдеры (Claude, OpenAI, OpenRouter) предоставляют доступ к языковым моделям. Каждый провайдер имеет собственный SDK, формат сессий, транспорты и ограничения. Оркестрация не должна зависеть от конкретного провайдера — нужен слой абстракции, позволяющий подключать новых провайдеров без изменения координатора, API и UI.

**Требование-источник:** `vision.md` §1.2 P8 (vendor lock-in), `vision.md` §1.4 HF-8, `.ai-factory/ARCHITECTURE.md`, `docs/architecture.md` §Runtime Registry

**Решение:** Единый пакет `@aif/runtime` с интерфейсом `RuntimeAdapter`, контрактами (`RuntimeRunInput`, `RuntimeRunResult`), реестром адаптеров (`registry.ts`) и профильной системой резолвинга (`resolution.ts`, `capabilities.ts`). Каждый адаптер реализует `RuntimeAdapter`: декларирует дескриптор (id, провайдер, транспорты, capability flags) и методы `run()`, `resume()`, `forkSession()`, `listModels()`, `validateConnection()`, `diagnoseError()`. Потребители (агент, API) работают через реестр — получают адаптер по runtimeId и вызывают метод, не зная внутренностей. Встроенные адаптеры: Claude (SDK/CLI), Codex (SDK/CLI/API/App Server), OpenRouter (API), OpenCode. Внешние адаптеры подключаются через `AIF_RUNTIME_MODULES`.

**Рассмотренные альтернативы:**

- **Прямые SDK-вызовы в координаторе** — координатор агента напрямую вызывает Claude/OpenAI SDK. Отвергнуто: vendor lock-in, дублирование логики управления сессиями и лимитами.
- **Единый адаптер с conditional switching** — один класс, переключающий транспорт по конфигурации. Отвергнуто: нарушение OCP, раздувание адаптера, сложность поддержки.
- **Adapter-per-provider без реестра** — отдельные адаптеры, но без централизованного реестра и resolution. Отвергнуто: неясно, как выбирать адаптер и профиль.

**Последствия:**

- **Положительные:** провайдер-нейтральная оркестрация; единый контракт ошибок через `RuntimeExecutionError` с категориями (`rate_limit`, `auth`, `timeout` и т.д.); capability checks предотвращают вызов неподдерживаемых методов; профильная система (task → project → system → env fallback) отделяет конфигурацию от кода.
- **Отрицательные:** интерфейс `RuntimeAdapter` — минимальный общий знаменатель; специфичные возможности провайдера могут не помещаться в абстракцию; адаптеры API-транспорта (OpenRouter) не поддерживают resume и forkSession.
- **Смягчение:** capability flags (`supportsResume`, `supportsSessionFork` и т.д.) позволяют потребителям проверять поддержку до вызова; adapter-specific hooks (`hooks._trustToken`, `hooks.settings`) передаются через `RuntimeExecutionIntent.hooks` без загрязнения общего интерфейса.
