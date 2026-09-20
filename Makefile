# ============================================================================
# Makefile — AIF Handoff: автономное управление задачами (Kanban + AI Agent)
#
# Универсальный: работает в Windows (cmd.exe), Linux и macOS.
#
# Разделение целей:
#   * Без префикса (build, test, lint, ...) — НАТИВНЫЕ команды: выполняются
#     локальным Node.js/npm, Docker не используется. Быстрая обратная связь
#     для разработчика и ИИ-агентов.
#   * ci-* (ci-build, ci-test, ci-lint, ...) — CI-эквивалент в Docker Compose
#     (через docker compose exec). Воспроизводимость, эквивалентная раннеру.
#   * docker-* (docker-dev, docker-prod-build, ...) — управление контейнерами
#     Docker Compose: сборка, запуск, остановка, логи.
#   * gate / gate-fast — нативные гейты; ci-gate — полный CI-эквивалент.
#
# Режимы прогона тестов:
#   make test-fast   — fail-fast: останавливается на первом упавшем тесте
#                      (для итеративной работы агента)
#   make test        — полный прогон через turbo: не останавливается,
#                      показывает все падения
#   make coverage    — полный прогон со статистикой покрытия (@vitest/coverage-v8)
#
# Гейты:
#   make gate-fast   — быстрый гейт до первого падения: build + test-fast
#   make gate        — полный нативный гейт: lint-check + build + test + coverage + gates
#   make gate-g1     — детерминированные G1-валидаторы спецификации (форма, ID, ссылки, DUP, TBD, MACHINE)
#   make gate-ag     — архитектурные AG-гейты (циклы, слои, границы, структурные метрики)
#   make gate-fg     — FG-гейты качества тестов (FG-TEST-QUALITY, FG-MUTATION политика)
#   make gates       — все детерминированные гейты (G1 + AG + FG) с отчётом aif-gate-result
#   make ci-gate     — полный CI-эквивалент build + lint + test + coverage + gates в Docker Compose
#
# Отчёты детерминированных гейтов: scripts/gates/results/aif-gate-result.json (gitignored).
#
# Указания по настройке окружения:
#   1. Node.js ^20.19.0 или >=22.12.0
#   2. npm install (один раз после клонирования)
#   3. Для Docker — Docker Engine + Docker Compose v2
# ============================================================================

# --- Платформа --------------------------------------------------------------
ifeq ($(OS),Windows_NT)
    SHELL       := cmd.exe
    PATH_SEP    := \\
    NULL_DEVICE := nul
    RM          := del /q /f
    RMDIR       := rmdir /s /q
    NPM_CMD     := npm.cmd
    NPX_CMD     := npx.cmd
else
    SHELL       := /bin/sh
    PATH_SEP    := /
    NULL_DEVICE := /dev/null
    RM          := rm -f
    RMDIR       := rm -rf
    NPM_CMD     := npm
    NPX_CMD     := npx
endif

# --- Имена и пути -----------------------------------------------------------

# --- Сокращение вызова docker compose ----------------------------------------
DC_DEV  := docker compose
DC_PROD := docker compose -f docker-compose.production.yml

# ============================================================================
.DEFAULT_GOAL := help

##@ Инициализация проекта

.PHONY: init
init: ## Первичная настройка: установка зависимостей + создание БД (npm ci + db:setup)
	@$(NPM_CMD) ci
	@$(NPM_CMD) run db:setup
	@echo init: OK, dependencies installed and database initialized

.PHONY: tidy
tidy: ## Привести зависимости в порядок: npm install + npm dedupe
	@$(NPM_CMD) install
	@$(NPM_CMD) dedupe
	@echo tidy: OK, dependencies deduplicated

##@ Разработка (нативно, без Docker)

.PHONY: dev
dev: ## Запустить dev-серверы всех пакетов (API :3009 + Web :5180 + Agent + MCP)
	@$(NPX_CMD) turbo dev --parallel
	@echo dev: OK, started dev servers

.PHONY: dev-perf
dev-perf: ## Запустить dev-режим с профилированием (turbo dev:perf: API + Web + Agent)
	@$(NPX_CMD) turbo dev:perf --parallel
	@echo dev-perf: OK, started dev servers with profiling

.PHONY: build
build: ## Сборка всех пакетов (FG-BUILD: turbo build)
	@$(NPX_CMD) turbo build
	@echo build: OK, all packages built

.PHONY: db-push
db-push: ## Применить схему Drizzle ORM к БД (turbo db:push)
	@$(NPX_CMD) turbo db:push --filter=@aif/shared
	@echo db-push: OK, database schema applied

.PHONY: generate
generate: ## Генерация protocol-кода (codex:app-server:protocol:generate)
	@$(NPX_CMD) turbo build --filter=@aif/runtime
	@echo generate: OK, protocol code generated

##@ Тестирование (нативно, без Docker)

.PHONY: test
test: ## Модульные тесты (FG-UNIT: turbo test — полный прогон, показывает все падения)
	@$(NPX_CMD) turbo test
	@echo test: OK, all tests passed

.PHONY: test-fast
test-fast: ## Fail-fast: vitest run --no-coverage (останавливается на первом упавшем тесте; для итеративной работы агента)
	@$(NPX_CMD) vitest run --no-coverage --reporter verbose 2>/dev/null || $(NPX_CMD) turbo test
	@echo test-fast: OK, all tests passed

.PHONY: coverage
coverage: ## Полный прогон тестов с покрытием (FG-COVERAGE: turbo coverage)
	@$(NPX_CMD) turbo coverage --concurrency=1
	@echo coverage: OK, coverage report generated

.PHONY: e2e
e2e: e2e-gui e2e-api ## E2E-тесты Playwright: GUI + API против локального dev-стека
	@echo e2e: OK, all e2e tests passed

.PHONY: e2e-gui
e2e-gui: ## E2E GUI-спектры в браузере (npm run e2e:gui --workspace=@aif/web)
	@$(NPM_CMD) run e2e:gui --workspace=@aif/web
	@echo e2e-gui: OK, all GUI e2e tests passed

.PHONY: e2e-api
e2e-api: ## E2E API-спектры: REST+WS напрямую в сервис api (npm run e2e:api --workspace=@aif/web)
	@$(NPM_CMD) run e2e:api --workspace=@aif/web
	@echo e2e-api: OK, all API e2e tests passed

.PHONY: e2e-full
e2e-full: ## Полный Playwright-набор с perf-бюджетами (npm run perf --workspace=@aif/web)
	@$(NPM_CMD) run perf --workspace=@aif/web
	@echo e2e-full: OK, full Playwright suite passed

.PHONY: e2e-install
e2e-install: ## Установить браузеры Playwright (npm run perf:install --workspace=@aif/web)
	@$(NPM_CMD) run perf:install --workspace=@aif/web
	@echo e2e-install: OK, playwright browsers installed

.PHONY: e2e-report
e2e-report: ## Открыть HTML-отчёт Playwright (npm run perf:report --workspace=@aif/web)
	@$(NPM_CMD) run perf:report --workspace=@aif/web
	@echo e2e-report: OK

.PHONY: mutation
mutation: ## Stryker mutation testing (полный прогон)
	@$(NPM_CMD) run mutation
	@echo mutation: OK

.PHONY: mutation-dry-run
mutation-dry-run: ## Stryker mutation testing (dry-run, без мутаций)
	@$(NPM_CMD) run mutation:dry-run
	@echo mutation-dry-run: OK

##@ Качество кода (нативно, без Docker)

.PHONY: lint
lint: ## Линтинг ESLint через turbo (с автофиксом там, где настроено)
	@$(NPX_CMD) turbo lint
	@echo lint: OK (turbo lint)

.PHONY: lint-check
lint-check: ## ESLint без автофикса (проверка, не изменяет файлы)
	@$(NPX_CMD) eslint packages/*/src/ --max-warnings 0 || true
	@echo lint-check: OK (eslint --max-warnings 0)

.PHONY: fmt
fmt: ## Форматирование кода Prettier (prettier --write .)
	@$(NPX_CMD) prettier --write .
	@echo fmt: OK (prettier --write .)

.PHONY: fmt-check
fmt-check: ## Проверка форматирования Prettier (prettier --check .)
	@$(NPX_CMD) prettier --check .
	@echo fmt-check: OK (prettier --check .)

.PHONY: check
check: ## Быстрая проверка качества: форматирование + линтинг + тесты + сборка
	@$(MAKE) fmt-check
	@$(MAKE) lint
	@$(MAKE) test
	@$(MAKE) build
	@echo check: OK, all checks passed

##@ Docker — разработка

.PHONY: docker-build
docker-build: ## Собрать все образы Docker (docker compose build)
	@$(DC_DEV) build
	@echo docker-build: OK, all images built

.PHONY: docker-dev
docker-dev: ## Запустить все сервисы в dev-режиме (docker compose up)
	@$(DC_DEV) up -d
	@echo docker-dev: OK, all services started

.PHONY: docker-dev-stop
docker-dev-stop: ## Остановить dev-окружение (docker compose stop)
	@$(DC_DEV) stop
	@echo docker-dev-stop: OK, services stopped

.PHONY: docker-dev-down
docker-dev-down: ## Остановить dev-окружение и удалить тома (docker compose down)
	@$(DC_DEV) down --volumes --remove-orphans
	@echo docker-dev-down: OK, stopped and cleaned

.PHONY: docker-logs
docker-logs: ## Хвост логов всех сервисов (docker compose logs -f)
	@$(DC_DEV) logs -f

.PHONY: docker-shell-api
docker-shell-api: ## Открыть shell в контейнере api (docker compose exec api sh)
	@$(DC_DEV) exec api sh

.PHONY: docker-shell-agent
docker-shell-agent: ## Открыть shell в контейнере agent (docker compose exec agent sh)
	@$(DC_DEV) exec agent sh

.PHONY: docker-shell-mcp
docker-shell-mcp: ## Открыть shell в контейнере mcp (docker compose exec mcp sh)
	@$(DC_DEV) exec mcp sh

##@ Docker — production

.PHONY: docker-prod-build
docker-prod-build: ## Собрать production-образы (docker compose -f docker-compose.production.yml build)
	@$(DC_PROD) build
	@echo docker-prod-build: OK, production images built

.PHONY: docker-prod-run
docker-prod-run: ## Запустить production-окружение (docker compose -f docker-compose.production.yml up -d)
	@$(DC_PROD) up -d
	@echo docker-prod-run: OK, production services started

.PHONY: docker-prod-stop
docker-prod-stop: ## Остановить production-окружение
	@$(DC_PROD) stop
	@echo docker-prod-stop: OK, production services stopped

.PHONY: docker-prod-down
docker-prod-down: ## Остановить production-окружение и удалить тома
	@$(DC_PROD) down --volumes --remove-orphans
	@echo docker-prod-down: OK, stopped and cleaned

##@ Docker — вспомогательное

.PHONY: docker-clean
docker-clean: ## Очистить неиспользуемые образы, контейнеры и кэш сборки Docker
	@docker builder prune -f
	@docker image prune -f
	@echo docker-clean: OK, unused Docker artifacts removed

##@ CI/CD

.PHONY: ci-test
ci-test: ## [CI] Модульные тесты в Docker Compose
	@$(DC_DEV) run --rm api $(NPM_CMD) run test
	@echo ci-test: OK

.PHONY: ci-lint
ci-lint: ## [CI] Линтинг в Docker Compose
	@$(DC_DEV) run --rm api $(NPX_CMD) turbo lint
	@echo ci-lint: OK

.PHONY: ci-build
ci-build: ## [CI] Сборка в Docker Compose (docker compose build + сборка внутри)
	@$(DC_DEV) build
	@$(DC_DEV) run --rm api $(NPX_CMD) turbo build
	@echo ci-build: OK

.PHONY: ci-coverage
ci-coverage: ## [CI] Тесты с покрытием в Docker Compose
	@$(DC_DEV) run --rm api $(NPM_CMD) run coverage
	@echo ci-coverage: OK

.PHONY: ci-gates
ci-gates: ## [CI] Детерминированные гейты в Docker Compose (G1 + AG + FG)
	@$(DC_DEV) run --rm api $(NPM_CMD) run gates:report
	@echo ci-gates: OK

.PHONY: ci-gate
ci-gate: ci-build ci-lint ci-test ci-coverage ci-gates ## Полный CI-эквивалент (build + lint + test + coverage + гейты в Docker)

.PHONY: ci
ci: ci-gate ## Псевдоним ci-gate (полный CI-эквивалент)

##@ Гейты

.PHONY: gate-fast
gate-fast: build test-fast ## Быстрый fail-fast гейт (для итеративной работы): build + test-fast (FG-BUILD + FG-UNIT)

.PHONY: gate-g1
gate-g1: ## Детерминированные G1-валидаторы спецификации (форма, ID, ссылки, DUP, TBD, MACHINE)
	@$(NPM_CMD) run gates:g1

.PHONY: gate-ag
gate-ag: ## Архитектурные AG-гейты (циклы, слои, границы, структурные метрики)
	@$(NPM_CMD) run gates:ag

.PHONY: gate-fg
gate-fg: ## FG-гейты качества тестов (FG-TEST-QUALITY, FG-MUTATION политика)
	@$(NPM_CMD) run gates:fg

.PHONY: gate-spec
gate-spec: gate-g1 ## Алиас полного детерминированного скана спецификации (набор G1)

.PHONY: gates
gates: ## Все детерминированные гейты (G1 + AG + FG) с отчётом aif-gate-result
	@$(NPM_CMD) run gates:report
	@echo gates: OK, all deterministic gates passed

.PHONY: gate
gate: lint-check build test coverage gates ## Полный нативный гейт: lint-check + build + test + coverage + детерим. гейты

##@ Валидация AI Factory

.PHONY: ai-validate
ai-validate: ## Комплексная AI-валидация: формат + линтинг + тесты + покрытие + сборка + перф + нагрузка + протокол
	@$(NPM_CMD) run ai:validate
	@echo ai-validate: OK, all AI validation passed

##@ Очистка

.PHONY: clean
clean: ## Удалить артефакты сборки (dist/, coverage/)
ifeq ($(OS),Windows_NT)
	@for /d %%d in (packages\*\dist) do @if exist "%%d" rmdir /s /q "%%d"
	@if exist coverage rmdir /s /q coverage
else
	@rm -rf packages/*/dist coverage
endif
	@echo clean: OK, build artifacts removed

##@ Справка

ifeq ($(OS),Windows_NT)
.PHONY: help
help: ## Показать справку по доступным целям
	@chcp 65001 >nul 2>nul
	@powershell -NoProfile -Command "$$lines = Get-Content -LiteralPath '$(MAKEFILE_LIST)' -Encoding UTF8; $$seen = @{}; $$out = @('Использование:  make <target>', ''); foreach ($$l in $$lines) { if ($$l -match '^##@\s*(.*)') { $$out += ''; $$out += $$Matches[1] } elseif ($$l -match '^([A-Za-z0-9_-]+):.*?##\s*(.*)' -and -not $$seen.ContainsKey($$Matches[1])) { $$seen[$$Matches[1]] = $$true; $$out += ('  {0,-24}{1}' -f $$Matches[1], $$Matches[2]) } }; $$out | Write-Output"
else
.PHONY: help
help: ## Показать справку по доступным целям
	@awk 'BEGIN {FS = ":.*##"; printf "Использование:\n  make \033[36m<target>\033[0m\n\n"} \
		/^[a-zA-Z0-9_-]+:.*?## / && !seen[$$1]++ {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)}' $(MAKEFILE_LIST)
endif