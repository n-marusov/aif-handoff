# Фитнес-функции архитектуры (Architectural Fitness Functions) — Reference

> Source: книги — «Building Evolutionary Architectures» (N. Ford, R. Parsons, P. Kua, O'Reilly, 2017); «Continuous Architecture in Practice» (M. Erder, P. Pureur, E. Woods, Addison-Wesley, 2021); «Software Architecture Metrics» (O'Reilly, 2022, гл. 2 R. Weiss, гл. 8 N. Ford, гл. 9 C. Lilienthal); статья «Fitness function-driven development» (P. Paul, R. Wang, ThoughtWorks, 2019); ArchUnit (TNG, GitHub)
> Created: 2026-08-27
> Updated: 2026-08-27

## Overview

Фитнес-функция архитектуры (architectural fitness function) — это механизм, который даёт **объективную оценку целостности одной или нескольких архитектурных характеристик** системы (производительность, безопасность, масштабируемость, сопровождаемость и т.п.). Концепция заимствована из эволюционных вычислений (генетические алгоритмы), где fitness function определяет, насколько близко каждое поколение решения к целевой цели. В программной архитектуре фитнес-функции превращают размытые «-ilities» (атрибуты качества) в **измеримые, автоматизируемые проверки**, которые защищают важные характеристики системы по мере её эволюции.

Три ключевые идеи из книг:

1. **Building Evolutionary Architectures** (2017) — первоисточник концепции. Эволюционная архитектура = управляемое (guided) инкрементальное изменение + фитнес-функции + подходящая связанность (appropriate coupling). Определение: «An architectural fitness function provides an objective integrity assessment of some architectural characteristic(s)».
2. **Continuous Architecture in Practice** (2021) — фитнес-функции как механизм **петель обратной связи** (feedback loops) в процессе разработки. Рекомендуется определять их как можно раньше, автоматизировать и тестировать; они связывают четыре ключевые деятельности архитектуры: фокус на атрибутах качества, архитектурные решения, технический долг и обратную связь.
3. **Software Architecture Metrics** (2022) — связывает фитнес-функции с метриками: «An architecture fitness function is any mechanism that provides objective evaluation criteria for architecture characteristic(s)». Вводит «пирамиду тестирования фитнес-функций» (Fitness Function Testing Pyramid) и полный каталог категорий (обязательные и опциональные).

Фитнес-функции объединяют под одной «крышей» то, что раньше делалось разрозненно: юнит-тесты, проверяющие архитектуру, метрики кода, мониторинг продакшена, chaos engineering, ручные проверки соответствия требованиям. Не все тесты — фитнес-функции, но любой тест, который проверяет целостность архитектурных характеристик, — это фитнес-функция.

## Core Concepts

### Определения

| Источник | Определение |
|----------|-------------|
| BEA, гл. 2 | «An architectural fitness function provides an objective integrity assessment of some architectural characteristic(s)» — фитнес-функция архитектуры даёт объективную оценку целостности архитектурной характеристики(к) |
| BEA, гл. 1 | «A fitness function is an objective function used to summarize how close a prospective design solution is to achieving the set aims» — объективная функция, показывающая, насколько решение близко к целям |
| Software Architecture Metrics, гл. 8 | «An architecture fitness function is any mechanism that provides objective evaluation criteria for architecture characteristic(s)» — любой механизм, дающий объективные критерии оценки архитектурных характеристик |

### Архитектурные характеристики («-ilities»)

Архитектурные характеристики (a.k.a. нефункциональные требования, cross-cutting requirements, quality attributes) — это недедоменные требования к дизайну: производительность, масштабируемость, эластичность, доступность, безопасность, сопровождаемость и др. Доменные требования уже хорошо покрыты юнит/функциональными/приёмочными тестами; фитнес-функции закрывают пробел валидации архитектурных характеристик, которая раньше была ad hoc (проверки на этапе сборки, мониторинг продакшена, forensic logging).

**Композитные характеристики:** некоторые характеристики слишком широки (например, надёжность = доступность + целостность данных + ...). Если архитектор не может определить, как измерить характеристику, вероятно, она композитная и подлежит декомпозиции на измеримые части.

### Systemwide fitness function (системная фитнес-функция)

Системная фитнес-функция — это совокупность фитнес-функций, где каждая соответствует одному или нескольким измерениям архитектуры. Она позволяет сравнивать разные характеристики (яблоки и апельсины) и осознанно принимать tradeoff-решения, когда отдельные функции конфликтуют (классика: производительность vs безопасность из-за стоимости шифрования). Архитекторы, как правило, не «вычисляют» её численно — она задаёт приоритеты для будущих решений.

### Классификация важности (BEA)

- **Key (ключевые)** — критичны для выбора технологий и дизайна. Пример: для банковского приложения производительность и отказоустойчивость. В них стоит вкладывать больше усилий (spikes, set-based development).
- **Relevant (релевантные)** — учитываются на уровне фич, но не направляют архитектурные решения. Пример: метрики качества кода.
- **Not relevant (нерелевантные)** — не влияют на дизайн. Пример: process metrics (cycle time) — важны процессно, но не для архитектуры.

### Связь с Continuous Architecture

Continuous Architecture — подход из 6 принципов (Principle 2: «Фокус на атрибутах качества, а не на функциональных требованиях») и 4 ключевых деятельностей:
1. Фокус на атрибутах качества
2. Управление архитектурными решениями
3. Управление техническим долгом
4. **Реализация петель обратной связи** (feedback loops)

Петля обратной связи: собрать измерения (включая результаты фитнес-функций) → оценить мультидисциплинарной командой → спланировать инкрементальные изменения → внедрить → снова собрать измерения. Фитнес-функции — инструмент измерения; они должны быть «видны всем заинтересованным сторонам» и непрерывно обновляться (continuous updates to fitness functions).

### Связь с метриками (Software Architecture Metrics)

Фитнес-функция **определяет** целевую метрику и контекст (fitness function context: окружение, определения, ограничения). Архитектурный тест производит метрику и проверяет порог. Метрика становится фитнес-функцией только при **регулярном автоматическом применении с объективными порогами** — иначе это «доказательство задним числом», а не упреждающая сила. Формула: метрики + автоматизация в CI/CD = фитнес-функции = инженерия.

## Категории фитнес-функций

### Категории BEA (Ford, Parsons, Kua)

| Категория | Варианты | Описание |
|-----------|----------|----------|
| Охват (breadth) | **Atomic** — единичный контекст, один аспект архитектуры (пример: юнит-тест на модульную связанность) | **Holistic** — общий контекст, комбинация аспектов (пример: безопасность + масштабируемость: кэширование «портят» свежесть данных) |
| Триггер (cadence) | **Triggered** — запуск по событию (юнит-тест разработчиком, CI, exploratory testing) | **Continual** — постоянная проверка в проде (симуляция транзакции среди реальных; monitoring-driven development) |
| Статичность | **Static** — фиксированный результат (pass/fail, диапазон, вхождение в множество) | **Dynamic** — скользящее определение по контексту (больше масштаб → допустима более низкая производительность, но в пределах) |
| Автоматизация | **Automated** — CI, deployment pipelines | **Manual** — ручные стадии конвейера (юридическая сертификация, ручной failover-тест БД) |
| Время | **Temporal** — проверка «по времени» (напоминание об обновлении библиотеки шифрования, break-upon-upgrade тест для backported фич, проверка изменения лицензии open source библиотек) |
| Происхождение | **Intentional** — определена на старте проекта | **Emergent** — выявлена в процессе разработки |
| Домен | **Domain-specific** — специфичные требования домена (например, стресс-тест по образцу Simian Army для международных денежных переводов) |

### Комбинации (mashups) категорий — BEA, гл. 3

| Комбинация | Пример |
|------------|--------|
| atomic + triggered | Юнит-тест архитектурной целостности (циклические зависимости, цикломатическая сложность) в CI |
| holistic + triggered | Интеграционные тесты: влияние ужесточения безопасности на масштабируемость |
| atomic + continual | Инструмент, постоянно вызывающий REST-эндпоинты как обычный клиент (проверка глаголов, обработки ошибок, метаданных) |
| holistic + continual | Netflix Chaos Monkey / Simian Army; Scientist (GitHub) — постоянно сравнивает старую и новую реализацию |

### Обязательные и опциональные категории (Rene Weiss, Software Architecture Metrics, гл. 2)

**Обязательные (6):**

| Категория | Возможные значения |
|-----------|-------------------|
| Широта обратной связи | atomic или holistic |
| Триггер выполнения | triggered или continuous |
| Место выполнения | CI/CD, тестовая среда, продакшен и др. |
| Тип метрики | true/false, дискретное значение, временной ряд/исторические значения |
| Автоматизация | automated или manual |
| Атрибут качества | атрибуты ISO/IEC 25010: функциональная пригодность, эффективность производительности, совместимость, удобство использования, надёжность, безопасность, сопровождаемость, переносимость |

**Опциональные (4):**

| Категория | Возможные значения |
|-----------|-------------------|
| Временность | temporary (для периода рефакторинга, потом удаляется) или permanent |
| Статичность | static (фиксированный порог) или dynamic (диапазон относительно другой величины, например, время ответа 50–100 мс при 10–100 тыс. пользователей) |
| Целевая аудитория | разработчики, операции, продакт-менеджеры и др. (влияет на визуализацию) |
| Область применения | одна система/подсистема/сервис; ограничение по технологии (JS-фронтенд vs Java-бэкенд) |

### Пирамида тестирования фитнес-функций (Fitness Function Testing Pyramid, Rene Weiss)

Аналог пирамиды тестов (Martin Fowler), но для архитектурных проверок. Два определяющих слои фактора: широта обратной связи (atomic/holistic) и триггер (triggered/continuous).

- **Нижний слой** — triggered + atomic: дёшево и просто (покрытие кода, статический анализ, цикломатическая сложность, простые перф-тесты). Рекомендуется широкая база.
- **Средний слой** — triggered + holistic (интеграционные тесты, симуляция отказа частей системы или третьих сторон) ИЛИ continuous + atomic (мониторинг времени транзакции, время загрузки страниц).
- **Верхний слой** — holistic (обычно continuous): самые сложные и дорогие, но дают лучшую картину для конечного пользователя (выручка/мин, чекауты/мин, логины/мин в коридоре; chaos engineering). Таких тестов должно быть немного.

Пирамида помогает сбалансировать портфель архитектурных тестов по стоимости и уверенности. В исключительных случаях пирамида может «переворачиваться» — зависит от контекста.

## Методология разработки фитнес-функций

### 7-шаговый процесс (Rene Weiss, гл. 2 Software Architecture Metrics)

Интегрируется в итеративный процесс (например, Scrum):

1. **Согласовать атрибуты качества с заинтересованными сторонами.** Определить и задокументировать главные архитектурные цели. Это избегает создания тестов, не приносящих ценности.
2. **Сформулировать черновики фитнес-функций и целевых метрик.** Общий список/бэклог, задокументировать предвидимые категории.
3. **Приоритизировать и отобрать** важные, полезные и реализуемые сейчас функции. Учесть слои пирамиды; на старте — что-то простое из нижнего слоя.
4. **Финализировать определения** выбранных функций с полной классификацией по категориям и слою пирамиды.
5. **Разработать автоматический тест**, производящий метрику и проверяющий её порог. Автоматизация по умолчанию; ручные — только для очень специфичных метрик.
6. **Визуализировать результаты** — дашборд для команды и заинтересованных сторон.
7. **Регулярно итерировать**: выводить из эксплуатации ненужные функции, ужесточать или смягчать пороги.

### Рекомендации BEA (гл. 2)

- **Определять фитнес-функции как можно раньше** — в рамках первичного понимания архитектурных озабоченностей; также рано определить системную фитнес-функцию.
- Риски без раннего выявления: неверные дизайн-решения; затраты на ненужные решения; невозможность эволюции системы.
- Классифицировать по Key/Relevant/Not relevant для приоритизации.
- **Fitness function review** — встреча бизнес- и техзаинтересованных сторон для обновления функций: обзор существующих, проверка релевантности, изменение масштаба, поиск лучших способов измерения, открытие новых функций. Проводить **не реже раза в год**.
- Держать результаты выполнения функций на видном месте (shared space), чтобы разработчики помнили о них.
- Для системных функций уровня предприятия: архитекторы предприятия задают enterprise-wide фитнес-функции и встраивают их в шаблоны deployment pipelines всех проектов (пример: 62 критерия платформы PenultimateWidgets, проверка «пять девяток» доступности оставлена командам сервисов).

### Методология из Continuous Architecture (гл. 2)

- Определять фитнес-функции как можно раньше — это помогает команде выявить релевантные атрибуты качества.
- Автоматизация и тестирование фитнес-функций позволяет **проверять варианты архитектурных решений** до их принятия («каждое архитектурное решение — это утверждение, которое надо проверить»).
- Фитнес-функции — часть непрерывной работы архитектора на протяжении всего жизненного цикла: непрерывные обновления фитнес-функций, ревью рисков, threat modeling, ревью метрик мониторинга (включаются в ревью спринтов и создание бэклога).
- Петля обратной связи: не начинать со сложного дашборда; собрать небольшое число значимых измерений → оценить → спланировать инкрементально → внедрить.

### Методология fitness function-driven development (ThoughtWorks, 2019)

- Рассматривать архитектуру как продукт с пользовательскими сценариями; собрать от стейкхолдеров (бизнес, комплаенс, операции, безопасность, инфраструктура, разработка) топ-5–6 атрибутов, сгруппировать в темы (resilience, operability, stability).
- Выявленные конфликты (стабильность vs гибкость; MTTR vs MTBF) — предмет осознанного приоритизации.
- Черновики фитнес-функций оформить в тестовом фреймворке; включить в delivery pipelines как gatekeepers (автоматизированные, не блокирующие поток вручную).
- Регулярные ревью фитнес-функций фокусируют архитектурные усилия на измеримых результатах и предотвращают architectural drift.

## Каталог фитнес-функций

Сводный каталог по областям применения. Формулировки и пороги — из книг и статьи ThoughtWorks; пороги адаптируются под конкретную систему.

### Производительность (Performance)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Все вызовы сервиса отвечают ≤ 100 мс; тест падает при превышении | triggered, atomic | BEA |
| Транзакция выполняется < 10 с (полный round-trip) | triggered, atomic | ThoughtWorks |
| Ошибок < 10% на 10 000 транзакций | triggered, atomic | ThoughtWorks |
| Время ответа в диапазоне 50–100 мс при 10–100 тыс. активных пользователей (dynamic) | continual, dynamic | Weiss |
| Допустимая производительность «скользит» с масштабом: больше масштаб → медленнее допустимо, но в пределах | continual, dynamic | BEA |
| Производительность при сетевой задержке: транзакция < 10 с, ошибок < 5% при латентности | triggered, holistic | ThoughtWorks |
| Ошибок = 0% при латентности 10 с к третьей стороне; выполняется не дольше 2× стандартного времени | triggered, CI/CD + test env | Weiss (пример 2-4) |

### Масштабируемость и доступность (Scalability & Availability)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Автоматические тесты масштабируемости (нагрузка) в отдельной стадии pipeline | triggered, atomic | BEA (кейс invoicing) |
| «Пять девяток» (99,999%) доступности сервиса (порог задаёт команда сервиса) | continual, atomic | BEA (кейс enterprise) |
| Одновременные пользователи в пределах латентности (проверка кэширования) | holistic | BEA |

### Надёжность и отказоустойчивость (Reliability & Resiliency)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Chaos Monkey / Simian Army: постоянное внесение хаоса в инфраструктуру (латентность, отказы) | continual, holistic | BEA, Weiss |
| Новый деплой: ошибок < 1% во время раскатки | continual, holistic | ThoughtWorks |
| Интеграционные тесты, симулирующие отказ частей системы/третьих сторон | triggered, holistic | Weiss |
| Ручной тест failover БД при жёстком отказе | manual, triggered | BEA |
| Доступность и корректность системы во время rolling update: регрессионный набор из 5 ключевых пользовательских сценариев при деплое в 01:00, ответ < 100 мс | triggered, holistic, production | Weiss (пример 2-6) |

### Безопасность (Security)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Пентест (security penetration testing) в отдельной стадии pipeline | triggered, atomic | BEA (кейс invoicing) |
| Только корпоративно одобренные библиотеки | triggered, atomic | ThoughtWorks |
| Нет ни одной уязвимости из OWASP Top 10 | triggered, atomic (SAST) | ThoughtWorks |
| Нет секретов в открытом виде в кодовой базе | triggered, atomic | ThoughtWorks, pipeline-гейты |
| Нет библиотек и контейнерных образов с известными CVE | triggered, atomic (SCA/сканирование образов) | ThoughtWorks |
| Zero-day проверка: тест на версию фреймворка/библиотеки; при обнаружении опасной версии — fail build и уведомление security-команды | triggered, atomic; «слот» security в каждом pipeline | Ford (гл. 8) |
| Проверка свежести данных (staleness) при включённом кэшировании | holistic | BEA |
| Проверка смены лицензии open source библиотеки (по строке лицензии) | temporal | BEA (кейс legality) |

### Сопровождаемость и качество кода (Maintainability & Code Quality)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Покрытие юнит-тестами > 90%; покрытие интеграционными тестами > 50% | triggered, atomic, CI/CD | Weiss (примеры 2-1, 2-2), ThoughtWorks |
| Цикломатическая сложность ≤ заданного порога (напр., Modified CC ≤ 15) | triggered, atomic | BEA, Lilienthal |
| Maintainability Level ≥ 75% | triggered, atomic | Lilienthal |
| Relative Cyclicity ≤ 4% на уровне компонентов, 0% на уровне пакетов/неймспейсов | triggered, atomic | Lilienthal |
| Structural Debt Index < 100 (низкие сотни) для компонентов | triggered, atomic | Lilienthal |
| Доля сложных файлов < 10% кода (сложный = средняя вложенность > 3, или сложность > 10, или > 800 LoC) | triggered, atomic | Lilienthal |
| Размер файла ≤ 800 LoC (soft threshold), максимальная вложенность ≤ 4 | triggered, atomic, soft | Lilienthal |
| Рейтинг сопровождаемости B или выше | triggered, atomic | ThoughtWorks |
| Нет циклических зависимостей: пакеты без циклов; группы циклов < 5 элементов | triggered, atomic | BEA (JDepend), Ford (ArchUnit), Lilienthal |
| Нет дублирования кода (copy-paste) | triggered, atomic | Lilienthal |

### Связанность и структура (Coupling & Structure)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Отсутствие циклов между компонентами: `slices().matching("com.myapp.(*)..").should().beFreeOfCycles()` (ArchUnit) | triggered, atomic | Ford (пример 8-1) |
| Слоистая архитектура: Controller не доступен ниоткуда, Service — не из Controller, Persistence — не из Service (ArchUnit) | triggered, atomic | Ford (пример 8-2) |
| Модульная связанность: юнит-тест на ограничение зависимостей модулей | triggered, atomic | BEA |
| Микросервисы: доменные сервисы общаются только с оркестратором (проверка логов вызовов за 24 ч) | triggered/continual, holistic | Ford (пример 8-3) |
| Проверка REST-эндпоинтов: корректные глаголы, обработка ошибок, метаданные | continual, atomic | BEA |
| Контракты интеграций не ломаются (contract testing) | triggered, holistic | BEA (кейс invoicing) |

### Наблюдаемость (Observability)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Приложение стримит метрики в сервис метрик | triggered/continual, atomic | ThoughtWorks |
| Логи парсятся и потребляются лог-агрегатором; нет PII в логах | triggered, atomic | ThoughtWorks |
| Есть health endpoint | triggered, atomic | ThoughtWorks |
| Есть correlation/tracing ID в логах | triggered, atomic | ThoughtWorks |

### Эксплуатируемость (Operability)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| У сервиса есть runbook, README, алерты, tracing IDs | triggered, atomic | ThoughtWorks |
| Структурированные логи в новом коде (логгирование не «после факта») | triggered, atomic | ThoughtWorks |
| Все build-джобы экспортируют логи по завершении | pipeline-гейт | ThoughtWorks |

### Комплаенс и регуляторика (Compliance)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Нет PII в логах | triggered, atomic | ThoughtWorks |
| GDPR: отчёт о типах обрабатываемых персональных данных; аудит проведён за последние 365 дней | triggered, manual/auto | ThoughtWorks |
| Аудит изменений налогового кода независимым бухгалтером | manual, triggered (стадия pipeline) | BEA (кейс invoicing) |
| Юридическая сертификация изменений | manual | BEA |
| Проверка изменения лицензии библиотек | temporal | BEA |

### Конвейер поставки и процесс (Pipeline & Process)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Качество кода > 90% для продвижения на следующую стадию | triggered, atomic | ThoughtWorks |
| UAT-версия отклоняется от продакшена не более чем на 2 версии | triggered, atomic | ThoughtWorks |
| Всегда есть стадия security-тестирования | pipeline-гейт | ThoughtWorks |
| Никогда не деплоить с сервисной учётной записью другого приложения | pipeline-гейт | ThoughtWorks |
| Два утверждающих (approvers) перед продакшеном | pipeline-гейт, manual | ThoughtWorks |
| Cycle time конвейера < 4 часов (иначе алерт) | continual, atomic | BEA |
| Нет секретов в открытом виде в репозитории | pipeline-гейт | ThoughtWorks |

### Фидэлити и миграции (Fidelity)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Scientist-эксперимент: новая реализация сравнивается со старой на 1% запросов; результаты, тайминги и исключения публикуются на дашборд; переход после 24 ч без расхождений | continual, holistic | BEA, Ford (пример 8-4), GitHub case study |

### Бизнес-метрики (Business)

| Фитнес-функция | Категории | Источник |
|----------------|-----------|----------|
| Выручка в минуту в коридоре по времени суток (таблица порогов по часам) | continual, holistic, dynamic, production | Weiss (пример 2-5) |
| Checkout rate/мин, revenue/мин, logins/мин в ожидаемом диапазоне | continual, holistic | Weiss |

## Инструменты реализации

| Инструмент | Назначение | Платформа | Примечания |
|------------|------------|-----------|------------|
| **ArchUnit** | Тестирование архитектуры: зависимости пакетов/классов, слои, срезы (slices), циклы | Java (JUnit) | Apache 2.0, ~3.8k звёзд, версия 1.5.0; английский DSL, Hamcrest-матчеры; работает на уровне байткода |
| **NetArchTest** | Аналогично ArchUnit | .NET | упомянут в гл. 8 (Ford) |
| **JDepend** | Анализ зависимостей Java-пакетов; API для структурных тестов (циклы) | Java | BEA, пример 4-1 |
| **SonarQube** | Качество кода: покрытие, сложность, уязвимости (SAST), метрики | Кроссплатформенный | Бесплатен для ряда языков; подключается в сборку |
| **Sonargraph (-Explorer/-Enterprise)** | Структурный анализ: циклы, метрики сопровождаемости, тренды | Java, C#, Python (Explorer) | Sonargraph-Explorer бесплатен; Sonargraph-Enterprise — коммерческий с кастомными графиками |
| **Lattix, Sotograph/SotoArc, Structure101, TeamScale** | Сравнение «фактическая архитектура vs целевая», структурные метрики | Java и др. | упомянуты в гл. 4 и 9 (Lilienthal) |
| **Scientist** | Фидэлити-эксперименты: `use` (старое) vs `try` (новое), рандомизация порядка, сравнение результатов, тайминги | Ruby (оригинал), порты на другие языки | Open source от GitHub; пример: рефакторинг merge-функциональности |
| **Chaos Monkey / Simian Army** | Chaos engineering: постоянная проверка отказоустойчивости (Chaos Monkey, Conformity Monkey и др.) | AWS-экосистема | Netflix, open source; holistic continual |
| **JMeter, Gatling, k6, Locust** | Нагрузочное и перф-тестирование (как фитнес-функции производительности) | Кроссплатформенный | Запуск в CI/CD |
| **Prometheus, Grafana, Datadog, ELK, OpenTelemetry/Jaeger** | Мониторинг, метрики, логи, трейсинг (continual фитнес-функции) | Кроссплатформенный | Источники continual-метрик |
| **Snyk, Trivy, OWASP Dependency-Check, SonarQube Security** | Сканирование зависимостей и образов на CVE, секреты | Кроссплатформенный | Security-фитнес-функции |
| **Jenkins, GitHub Actions, GitLab CI, GoCD, Azure DevOps** | Deployment pipelines как хост для фитнес-функций (стадии, ручные гейты) | Кроссплатформенный | Ключевой механизм автоматизации |
| **archfit** | Валидация «фитнеса» AWS-решений по готовым правилам | AWS | Open source (mikaelvesavuori) |

При отсутствии готового инструмента архитектор может собрать фитнес-функцию «вручную» из стандартных средств (логи, мониторы, скрипты) — пример псевдокода проверки коммуникации оркестратора (гл. 8 Ford).

## Примеры кода

### 1. Проверка циклов с JDepend (BEA, пример 4-1)

```java
public class CycleTest extends TestCase {
    private JDepend jdepend;
    protected void setUp() throws IOException {
        jdepend = new JDepend();
        jdepend.addDirectory("/path/to/project/util/classes");
        jdepend.addDirectory("/path/to/project/web/classes");
        jdepend.addDirectory("/path/to/project/thirdpartyjars");
    }
    // Проверяет, что один пакет не содержит циклов зависимостей
    public void testOnePackage() {
        jdepend.analyze();
        JavaPackage p = jdepend.getPackage("com.xyz.thirdpartyjars");
        assertEquals("Cycle exists: " + p.getName(), false, p.containsCycle());
    }
    // Проверяет, что циклы отсутствуют во всех пакетах
    public void testAllPackages() {
        Collection packages = jdepend.analyze();
        assertEquals("Cycles exist", false, jdepend.containsCycles());
    }
}
```

### 2. Проверка циклов с ArchUnit (Software Architecture Metrics, пример 8-1)

```java
public class CycleTest {
    @Test
    public void test_for_cycles() {
        slices().
          matching("com.myapp.(*)..").
          should().beFreeOfCycles()
    }
}
```

### 3. Валидация слоистой архитектуры с ArchUnit (пример 8-2)

```java
layeredArchitecture()
  .layer("Controller").definedBy("..controller..")
  .layer("Service").definedBy("..service..")
  .layer("Persistence").definedBy("..persistence..")

  .whereLayer("Controller").mayNotBeAccessedByAnyLayer()
  .whereLayer("Service").mayNotBeAccessedByAnyLayer("Controller")
  .whereLayer("Persistence").mayNotBeAccessedByAnyLayer("Service")
```

### 4. Фидэлити-эксперимент с Scientist (пример 8-4 / пример 3-3)

```ruby
def create_merge_commit(author, base, head, options = {})
  commit_message = options[:commit_message] || "Merge #{head} into #{base}"
  now = Time.current
  science "create_merge_commit" do |e|
    e.context :base => base.to_s, :head => head.to_s, :repo => repository.nwo
    e.use { create_merge_commit_git(author, now, base, head, commit_message) }
    e.try { create_merge_commit_rugged(author, now, base, head, commit_message) }
  end
end
```

### 5. Проверка коммуникации микросервисов с оркестратором (псевдокод, пример 8-3)

```ruby
def ensure_domain_services_communicate_only_with_orchestrator
  list_of_services = List.new()
                        .add("orchestrator")
                        .add("order placement")
                        .add("payment")
                        .add("inventory")
  list_of_services.each { |service|
    service.import_logsFor(24.hours)
    calls_from(service).each { |call|
      unless call.destination.equals("orchestrator")
          raise FitnessFunctionFailure.new()
    }
   }
end
```

### 6. Определение фитнес-функции с контекстом (Weiss, примеры 2-1…2-4)

```text
// Пример 2-1. Фитнес-функция
Unit Test Coverage > 0.9;
Execute on each CI Build; Fail when below target coverage

// Пример 2-2. Фитнес-функция
Integration Test Coverage > 0.5;
Execute on each nightly integration test build;
Fail when below target coverage

// Пример 2-3. Фитнес-функция
Integration test errors = 0% (when network latency is 10s for third-party API call);
Execute on each nightly integration test build; Fail when integration test fails

// Пример 2-5. Фитнес-функция (онлайн-магазин)
Measure revenue per minute throughout the day. Fail when revenue per minute,
based on current time, is out of the corridor provided by the table
(например, 09:01–11:30 → min €900/мин; 17:31–19:30 → min €1500/мин и т.д.)
```

### 7. Примеры в стиле RSpec (ThoughtWorks, 2019)

```ruby
describe "Code Quality" do
  it "has test coverage above 90%" do
    expect(quality.get_test_coverage()).to > .9
  end
  it "has maintainability rating of .1 or higher (B)" do
    expect(quality.get_maintainability_rating()).to < .1
  end
end

describe "Resiliency" do
  describe "New Deployment" do
    it "has less than 1% error rate for new deployment" do
      expect(new_deployment.get_error_rate()).to < .01
    end
  end
  describe "Network Latency" do
    it "has less than 5% error rate even if there is network latency" do
      expect(network_tests.get_error_rate()).to < .05
    end
    it "completes a transaction under 10 seconds even if there is network latency" do
      expect(network_tests.get_transaction_time()).to < 10
    end
  end
end

describe "Security - Code Analysis" do
  it "should not have plaintext secrets in codebase" do
    expect(code.has_secrets_in_codebase()).to_not be(true)
  end
  it "should not use libraries with known vulnerabilities" do
    expect(libraries.have_no_cves()).to be(true)
  end
end

describe "Operability Standards" do
  describe "Operations Check" do
    it "should have a service runbook" do
      expect(service.has_runbook()).to be(true)
    end
    it "should have alerts" do
      expect(service.has_alerts()).to be(true)
    end
    it "should have tracing IDs" do
      expect(service.has_tracing_ids()).to be(true)
    end
  end
end
```

### 8. Базовый ArchUnit-тест (README проекта ArchUnit)

```java
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;

public class MyArchitectureTest {
    @Test
    public void some_architecture_rule() {
        JavaClasses importedClasses = new ClassFileImporter().importPackages("com.myapp");
        ArchRule rule = classes()... // правило
        rule.check(importedClasses);
    }
}
```

## Best Practices

1. **Определяйте фитнес-функции рано** (на старте проекта) — как часть понимания архитектурных озабоченностей; затем классифицируйте Key/Relevant/Not relevant (BEA).
2. **Стартуйте с малого и простого** — с нижнего слоя пирамиды фитнес-функций, затем расширяйте по мере изучения системы (Weiss).
3. **Автоматизируйте по умолчанию**; фитнес-функция без регулярного автоматического запуска с объективными порогами — это не фитнес-функция, а «доказательство задним числом» (Ford).
4. **Встраивайте в deployment pipelines** — как стадии, включая ручные гейты (security review, аудит, два approver'а). Конвейеры дают «слот» для enterprise-проверок и zero-day реакций (Ford).
5. **Балансируйте портфель** по пирамиде: широкая база triggered+atomic, немного среднего слоя, единицы верхнего holistic (Weiss).
6. **Согласуйте атрибуты качества со стейкхолдерами** до определения метрик — иначе тесты не приносят ценности (Weiss, ThoughtWorks).
7. **Визуализируйте результаты** (дашборды) и держите их на видном месте; трекайте метрики во времени (ежедневные автоматические сборы, тренды) (Weiss, Lilienthal).
8. **Проводите fitness function review не реже раза в год**; обновляйте функции при изменении бизнеса, регуляторики, технологий (BEA, Continuous Architecture).
9. **Используйте фитнес-функции для проверки архитектурных решений** до их принятия («решение как утверждение, которое нужно проверить») (Continuous Architecture).
10. **Для сложных характеристик декомпозируйте** композитные атрибуты на измеримые части (Ford).
11. **Отдавайте приоритет не более чем 3 характеристикам + сопровождаемость** — избегайте избыточной сложности (Lilienthal).
12. **Избегайте перебора**: не стройте «неприступную башню» из тысяч переплетённых функций, раздражающих команды (Ford, гл. 8).

## Common Pitfalls

- **Автоматизация ради автоматизации** — тесты, не привязанные к ключевым атрибутам качества, не добавляют ценности (Weiss).
- **Метрики без порогов и регулярности** — остаются пассивными отчётами, а не гейтами (Ford).
- **Игнорирование конфликтов характеристик** — производительность и безопасность часто противоречат друг другу; без системной фитнес-функции tradeoff-решения принимаются вслепую (BEA).
- **Слишком много holistic-тестов** — они дороги, недетерминированы, сложно изолировать первопричину; держите их количество малым (Weiss).
- **Жёсткие пороги без контекста** — blanket-политики (например, «пять девяток всем сервисам») ведут к оверинжинирингу; пороги должны быть контекстными (BEA, кейс enterprise).
- **Забывают про manual-функции** — юридические и регуляторные проверки нельзя автоматизировать; их всё равно нужно явно определять как фитнес-функции и включать в конвейер (BEA).
- **Не обновляют функции** — фитнес-функции устаревают вместе с требованиями; без регулярных ревью они становятся шумом (BEA, Continuous Architecture).
- **Проверка только сборки** — continual-функции (мониторинг продакшена, chaos engineering) часто игнорируются, хотя дают самую ценную обратную связь (BEA).

## Version Notes

- Концепция введена в 2017 в книге «Building Evolutionary Architectures» (Ford, Parsons, Kua).
- 2019 — статья ThoughtWorks «Fitness function-driven development» (Paul, Wang) формализует подход FFDD с примерами в RSpec-стиле.
- 2021 — «Continuous Architecture in Practice» (Erder, Pureur, Woods) встраивает фитнес-функции в петли обратной связи и непрерывную деятельность архитектора.
- 2022 — «Software Architecture Metrics» (O'Reilly): Rene Weiss вводит пирамиду тестирования фитнес-функций и полный каталог категорий; Neal Ford описывает кейсы Coupling, Zero-Day Security Check, Fidelity Fitness Functions; Carola Lilienthal — сопровождаемость.
- Инструменты эволюционируют: ArchUnit (Java) — стабильная версия 1.5.0; появляются аналоги для других платформ (NetArchTest для .NET, ArchUnitRuby и др.) и специализированные решения (archfit для AWS).
- Перспективные направления (BEA, гл. 8): фитнес-функции на основе ИИ (поиск аномального поведения), generative testing (свойство-тесты + статистический анализ результатов).

## Источники

1. Neal Ford, Rebecca Parsons, Patrick Kua — «Building Evolutionary Architectures» (O'Reilly, 2017) — локальные файлы: `books/Building Evolutionary Architectures.pdf` (гл. 1–4, 7–8)
2. Murat Erder, Pierre Pureur, Eoin Woods — «Continuous Architecture in Practice» (Addison-Wesley, 2021) — локальный файл: `books/AW.Continuous.Architecture.in.Practice.pdf` (гл. 1–2, 9)
3. «Software Architecture Metrics» (O'Reilly, 2022): гл. 2 Rene Weiss, гл. 8 Neal Ford, гл. 9 Carola Lilienthal — локальный файл: `books/Software Architecture Metrics Case.pdf`
4. Paula Paul, Rosemary Wang — «Fitness function-driven development», ThoughtWorks, 11.01.2019 — https://www.thoughtworks.com/insights/blog/fitness-function-driven-development (архивная копия: web.archive.org)
5. TNG ArchUnit — https://github.com/TNG/ArchUnit (README, примеры, лицензия Apache 2.0)
6. Сайт сообщества эволюционной архитектуры — https://evolutionaryarchitecture.com/
