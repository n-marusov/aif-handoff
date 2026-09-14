# Software Requirements Engineering (Wiegers & Beatty) Reference

> Source: Karl Wiegers, Joy Beatty — "Software Requirements, Third Edition" (Microsoft Press, 2013)
> Path: `books/Карл И. Вигерс, Джой Битти – Разработка требований к программному обеспечению_eng.pdf`
> Created: 2026-08-24
> Updated: 2026-08-24

## Overview

Эталонное руководство по инженерии требований. Книга описывает **полный жизненный цикл работы с требованиями**: от бизнес-целей через выявление, анализ, спецификацию и валидацию — до управления изменениями и улучшения процессов. Охватывает как традиционные (waterfall, phased), так и agile-подходы. Более 50 good practices, сгруппированных в 7 категорий.

Ключевая идея: разработка требований — итеративный, а не линейный процесс (принцип **progressive refinement of detail**).

---

## Core Concepts

**Requirement (определение):** "Specification of what should be implemented — descriptions of how the system should behave, or of a system property or attribute" (Sommerville & Sawyer). Alternate: "anything that drives design choices" (Lawrence).

**Три уровня требований:**

| Уровень | Определение | Документ | Аудитория |
|---------|-------------|----------|-----------|
| **Business requirement** | Высокоуровневая бизнес-цель организации, создающей продукт | Vision and Scope Document | Менеджеры, маркетинг, заказчики |
| **User requirement** | Цели и задачи, которые пользователи должны иметь возможность достичь с помощью продукта | Use Cases, User Stories, User Requirements Doc | Пользователи, BA, проектировщики |
| **Functional / Nonfunctional requirement** | Поведение системы, её свойства и ограничения | Software Requirements Specification (SRS) | Разработчики, тестировщики |

**Пять поддисциплин Requirements Engineering:**

```
┌──────────────────────────────────────────────────┐
│          REQUIREMENTS ENGINEERING                │
│  ┌──────────────────────┐ ┌──────────────────┐  │
│  │   REQUIREMENTS       │ │  REQUIREMENTS    │  │
│  │   DEVELOPMENT        │ │  MANAGEMENT      │  │
│  │                      │ │                  │  │
│  │ • Elicitation        │ │ • Version Ctrl   │  │
│  │ • Analysis           │ │ • Change Mgmt    │  │
│  │ • Specification      │ │ • Traceability   │  │
│  │ • Validation         │ │ • Status Track   │  │
│  └──────────────────────┘ └──────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Типы требований (полная таксономия):**
- **Business requirement** — бизнес-цель организации
- **Business rule** — политика, стандарт, регуляция (не требование к ПО, но источник требований)
- **Constraint** — ограничение на выбор разработчика (дизайн, платформа, язык)
- **External interface requirement** — связь с пользователем, другой системой или устройством
- **Functional requirement** — действие, которое должна выполнять система
- **Nonfunctional requirement (Quality attribute)** — свойство качества (производительность, безопасность, юзабилити...)
- **User requirement** — цель пользователя при работе с системой

---

## Requirements Development Process Framework

**Базовый постулат:** требования не разрабатываются линейно. Четыре активности (Elicitation → Analysis → Specification → Validation) **переплетены, инкрементальны и итеративны**.

### 17-шаговый процесс (Figure 3-2)

**Шаги 1–7: Выполняются однократно в начале проекта**

1. **Define product vision and project scope** — документ Vision & Scope
2. **Identify user classes and personas** — классификация пользователей
3. **Select product champions** — назначение представителей пользователей
4. **Identify user requirements** — выделение use cases или user stories
5. **Identify system events and responses** — внешние события и реакция системы
6. **Hold elicitation interviews / workshops** — интервью и фасилитированные встречи
7. **Analyze requirements for quality attributes and business rules** — выявление нефункциональных требований и бизнес-правил

**Шаги 8–17: Выполняются для каждого релиза/итерации**

8. **Analyze feasibility** — анализ реализуемости
9. **Prioritize requirements** — приоритизация (ценность, стоимость, риск)
10. **Create prototypes / models** — прототипирование и моделирование
11. **Specify functional requirements in SRS** — детальная спецификация
12. **Review requirements (formal inspection)** — рецензирование/инспекция
13. **Test the requirements** — тестирование требований (написание тестов)
14. **Define acceptance criteria** — критерии приёмки
15. **Baseline the requirements** — установка базовой линии
16. **Manage changes (change control process)** — управление изменениями
17. **Trace requirements** — трассировка (backward к источнику, forward к реализации)

> После шага 17 для любой порции требований — готовность к началу конструирования этой части системы. Повтор шагов 8–17 для следующего набора требований.

### Базовая модель итерации (Figure 3-1):

```
                ┌─────────── Elicitation ─────┐
                │           │                 │
                │           v                 │
                │      Analysis ◄─────────────┤
                │           │                 │
                │           v                 │
                │   Specification ◄───────────┤
                │           │                 │
                │           v                 │
                │     Validation ◄────────────┘
                │           │
                └───────────┴──→ Next iteration
```

---

## Elicitation (Выявление)

**Цель:** Обнаружить требования из источников — пользователей, документов, систем.

### Техники выявления

| Техника | Когда применять | Сильные стороны |
|---------|----------------|-----------------|
| **Interviews** | Мало пользователей, уникальный опыт | Глубокое погружение, гибкость |
| **Facilitated workshops** | Много стейкхолдеров | Консенсус, быстрая обратная связь |
| **Focus groups** | Маркетиновые исследования | Широкий срез мнений |
| Observations | Сложные аспекты работ | Обнаружение скрытых потребностей |
| **Questionnaires** | Большая распределённая аудитория | Статистическая значимость |
| **System interface analysis** | Интеграция с внешними системами | Полнота интерфейсов |
| **Document analysis** | Есть существующая документация | Быстрый старт без отрыва пользователей |
| **User interface analysis** | Есть существующий UI / прототип | Обратная связь через артефакт |

### Ключевые действия
- Идентификация пользовательских классов и стейкхолдеров
- Понимание задач и целей пользователей + бизнес-целей
- Изучение окружения нового продукта
- Работа с представителями каждого класса пользователей

### Два подхода
- **Usage-centric** — от целей пользователя к функциональности (рекомендуется)
- **Product-centric** — от набора фич, ожидаемо ведущих к успеху (риск: фичи не используются)

---

## Analysis (Анализ)

**Цель:** Углубить понимание каждого требования, представить их в разных формах, выявить пробелы.

### Ключевые действия
- Отделение функциональных требований от целей задач, ожиданий качества, бизнес-правил, предлагаемых решений
- Декомпозиция высокоуровневых требований до нужной детализации
- Вывод функциональных требований из другой информации
- Понимание относительной важности атрибутов качества
- Распределение требований по компонентам архитектуры
- Согласование приоритетов реализации
- Выявление пробелов и избыточности относительно scope

### Модели анализа (Chapter 12)
- **Context Diagram** — границы системы и внешние сущности
- **Swimlane Diagram** — роли и потоки работ между ними
- **State-Transition Diagram / State Table** — состояния и переходы
- **Dialog Map** — навигация между экранами/диалогами
- **Decision Table / Decision Tree** — логика с множеством условий
- **Event-Response Table** — события и реакции системы
- **Data Flow Diagram** — потоки данных между процессами
- **Entity-Relationship Diagram** — связи данных

---

## Specification (Спецификация)

**Цель:** Представить и сохранить требования в постоянной, хорошо организованной форме.

### Основные документы

| Документ | Содержит | Для кого |
|----------|----------|----------|
| **Vision and Scope Document** | Бизнес-требования, scope, контекст | Менеджеры, заказчики |
| **User Requirements Document** | Use cases или user stories | Пользователи, BA |
| **Software Requirements Specification (SRS)** | Функциональные и нефункциональные требования | Разработчики, тестировщики |

### SRS Template (Chapter 10) — ключевые секции:
1. Introduction (цель, audience, scope, definitions)
2. Overall description (product perspective, user classes, operating environment, constraints, assumptions)
3. System features (feature X: description, priority, stimulus/response, functional requirements)
4. Data requirements (logical data model, data dictionary, reports)
5. External interface requirements (user, hardware, software, communications)
6. Quality attributes (performance, security, reliability, usability...)
7. Internationalization and localization requirements
8. Other requirements
— Appendix A: Glossary
— Appendix B: Analysis models

### Правила хорошей спецификации
- Уникальная метка для каждого требования (устойчивая к добавлениям/удалениям)
- TBD (To Be Determined) — стандартный флаг для пробелов
- Хранить бизнес-правила отдельно от проекта (enterprise-level asset)
- Записывать происхождение (origin) каждого требования

---

## Validation (Валидация)

**Цель:** Подтвердить, что набор требований корректен и позволит построить решение, удовлетворяющее бизнес-целям.

> **Важно:** Вы никогда не получите совершенных требований. Цель — накопить разделяемое понимание, **достаточно хорошее** для начала конструирования со приемлемым уровнем риска.

### Основные практики
- **Peer review / Inspection** — одна из самых ценных практик качества ПО
- **Testing the requirements** — написание тестов как альтернативное представление требований
- **Defining acceptance criteria** — критерии приёмки вместе с пользователями
- **Prototyping / Simulation** — проверка понимания через прототип или симуляцию

### Defect checklist (типичные дефекты требований)
- Неполнота, неоднозначность, противоречивость
- Нереализуемость, непроверяемость
- Отсутствие происхождения, отсутствие приоритета
- Золотая плата (gold plating), "игрушечная" функциональность

---

## Requirements Management (Управление требованиями)

**Цель:** Работа с требованиями после того, как они получены.

### Ключевые практики
- **Baseline management** — снимок согласованных требований для релиза/итерации
- **Version control** — контроль версий требований (те же инструменты, что для кода)
- **Change control** — процесс предложения, анализа и разрешения изменений
- **Change Control Board (CCB)** — группа для оценки и принятия решений по изменениям
- **Impact analysis** — анализ влияния предлагаемого изменения
- **Status tracking** — отслеживание статуса каждого требования
- **Traceability** — связи требований с источниками (backward) и реализацией (forward)

### Change Control Process (Chapter 28)
1. Purpose and scope
2. Roles and responsibilities
3. Change request status (proposed → accepted/declined/deferred)
4. Entry criteria
5. Tasks (submit → evaluate → decide → implement → verify)
6. Exit criteria
7. Status reporting
— Appendix: Attributes stored for each request

### Requirement Attributes (Chapter 27)
Для каждого требования рекомендуется хранить:
- Уникальный ID
- Источник (originator)
- Дата создания
- Приоритет
- Статус (proposed, approved, implemented, verified, deleted)
- Версия
- Связанные требования (links)
- Риск / сложность
- Владелец

---

## Characteristics of Excellent Requirements

### Индивидуальное требование должно быть:

| Характеристика | Что это значит |
|----------------|---------------|
| **Complete** | Вся информация для понимания на месте; TBD размечены |
| **Correct** | Описывает реальную потребность, не конфликтует с родителем |
| **Feasible** | Реализуемо в рамках известных ограничений |
| **Necessary** | Есть ответ на вопрос "почему это нужно?" — трассируется до бизнес-цели |
| **Prioritized** | Показывает относительную важность для реализации |
| **Unambiguous** | Одна интерпретация у всех читателей |
| **Verifiable** | Можно объективно проверить (тест, анализ, демонстрация) |

### Набор требований (коллекция) должен быть:

| Характеристика | Что это значит |
|----------------|---------------|
| **Complete** | Ни одно необходимое требование не пропущено |
| **Consistent** | Нет внутренних противоречий |
| **Modifiable** | Каждое требование уникально помечено, изменения отслеживаются |
| **Traceable** | Есть связь с источником и с реализацией |

---

## Best Practices (полный список из 50+)

### Elicitation (13 практик)
1. Define product vision and project scope
2. Identify user classes — не пропустить ни одну группу
3. Select product champions — назначить ответственного представителя пользователя
4. Conduct focus groups — для маркетинговых исследований
5. Identify user requirements — use cases / user stories
6. Identify system events and responses — внешние события
7. Hold elicitation interviews — структурированное интервю
8. Hold facilitated elicitation workshops — jіинт с модератором
9. Observe users performing their jobs — этнографический метод
10. Distribute questionaires — для большой распределённой аудитории
11. Perform document analysis — анализ существующей документации
12. Exаmine problem reports — анализ ошибок и пожеланий
13. Reuse existing requirements — использовать накопленное

### Analysis (7 практик)
1. Model the application environment — context diagram, ecosystem map
2. Create prototypes — UI / technical prototypes
3. Analyze feasibility — техническая и экономическая реализуемость
4. Prioritize requirements — ценность, стоимость, риск
5. Create a data dictionary — единый словарь данных
6. Model the requirements — диаграммы (DFD, ERD, STD...)
7. Analyze interfaces — внешние интерфейсы

### Specification (7 практик)
1. Adopt requirement document templates — стндартные шаблоны
2. Identify requirement origins — запись источника каждого требования
3. Uniquely label each requirement — устойчивые ID
4. Record business rules — отдельно от треований
5. Specify nonfunctional requirements — атрибуты качества, ограничения

### Validation (4 практики)
1. Review the requirements — peer review / inspection
2. Test the requirements — тесты как альтернативное представление
3. Define acceptance criteria — критерии приёмки
4. Simulate the requirements — исполнимые mock-up'и

### Requirements Management (8 практик)
1. Eliminate unnecessary requirements — избегать "игрушечной" функиональности
2. Establish change control process — процесс управления изменениями
3. Perform change impact analysis — анализ влияния изменений
4. Establish baselines and control versions — базовые линии и версионирование
5. Maintain change history — история изменений
6. Track requirements status — статус каждого требования
7. Track requirements issues — проблемы и вопросы по требованиям
8. Maintain a requirements traceability matrix — матрица трассировки
9. Use a requirements management tool — специализированный инструмент

### Knowledge (6 практик)
1. Train business analysts
2. Educate stakeholders about requirements
3. Educate developers about application domain
4. Define a requirements engineering process
5. Create a glossary

### Project Management (9 практик)
1. Select an appropriate life cycle
2. Plan requirements approach
3. Estimate requirements effort
4. Base plans on requirements
5. Identify requirements decision makers
6. Renegotiate commitments
7. Manage requirements risks
8. Track requirements effort
9. Review past lessons learned

---

## Common Pitfalls

| # | Проблема | Описание | Решение |
|---|----------|----------|---------|
| 1 | **Insufficient user involvement** | Пользователи не вовлечены — продукт не соответствует реальным нуждам | Bill of Rights + Bill of Responsibilities, product champion |
| 2 | **Inaccurate planning** | Планы основаны на догадках, а не на требованиях | Оценивать трудоёмкость от требований, а не наоборот |
| 3 | **Creeping requirements (scope creep)** | Постоянные добавления без контроля | Change control process, CCB |
| 4 | **Ambiguous requirements** | Разные читатели — разное понимание | Peer review, inspection, конкретный язык |
| 5 | **Gold plating** | Разработчики добавляют функциональность "на всякий случай" | Строгий priority, трассировка до бизнес-целей |
| 6 | **Overlooked stakeholders** | Не учтены все группы заинтересованных лиц | Systematically identify user classes, ecosystem map |
| 7 | **Analysis paralysis** | Бесконечное уточнение требований без прогресса | Принцип "достаточно хорошо", итерации, timeboxing |
| 8 | **Одна модель для всех** | Один документ требований для всех аудиторий | Разделять Vision & Scope, User Reqs, SRS |
| 9 | **Игнорирование нефункциональных требований** | Фокус только на функциях | Прописывать quality attributes в SRS |

---

## Agile Projects (Chapter 20)

### Ключевые отличия от традиционного подхода
- **User stories** вместо детальной SRS на старте
- **Product backlog** с непрерывной приоритизацией
- **Just-in-time** детализация перед спринтом
- **Product owner** — единый голос пользователя (замена product champion)
- Приёмка — **работающий прототип**, а не подпись документа
- **Acceptance criteria / tests** вместо детальных функциональных требований

### Что НЕ меняется в agile
- Vision & Scope — всё ещё нужны (особенно vision)
- Business rules — хранятся отдельно, enterprise-level
- Quality attributes — должны быть явно определены
- Traceability — остаётся важной (особенно для compliance-проектов)
- Change management — изменения управляются через backlog, а не через CCB

### Распределение усилий по требованиям во времени
```
Водопад:    ████████░░░░░░░░░░░░░░
Итеративно: ██████░░████░░████░░███
Agile:      ██░░██░░██░░██░░██░░██░
```

---

## Процесс улучшения (Chapter 31 — Improving Your Requirements Processes)

### Цикл улучшения
1. **Assess current practices** — оценка текущего состояния (опросы, анализ проблем)
2. **Plan improvement actions** — выбор практик для внедрения
3. **Create, pilot, and roll out processes** — создание, пилот, развёртывание
4. **Evaluate results** — оценка эффекта (метрики: сокращение переделок, рост покрытия)

### Root Cause Analysis
При анализе проблем проекта спросить 5 раз "почему" — корень часто в требованиях.

### Process Assets
- **Requirements Development Process Assets:** шаблоны Vision & Scope, SRS, Use Case; глоссарий; чек-листы; критерии качества
- **Requirements Management Process Assets:** политика управления изменениями, шаблон Impact Analysis, процедура трассировки

---

## Requirements Bill of Rights / Responsibilities (Chapter 2)

### Права заказчика
1. Ожидать, что BA говорит на понятном языке
2. Узнать, почему заказчики участвуют и какую информацию предоставляют
3. Иметь BA, который знает свой инструментарий
4. Получить объяснение практик и артефактов
5. Иметь право на изменения требований
6. Ожидать взаимного уважения
7. Слышать альтернативы и идеи
8. Получать продукт, который удовлетворяет потребности
9. Получать инкрементальные результаты

### Обязанности заказчика
1. Обучиться процессу требований и роли BA
2. Выделить время для участия в работе над требованиями
3. Быть конкретным и принимающим решения
4. Принимать своевременные решения
5. Уважать оценку разработчиков
6. Принимать итеративный процесс открытия
7. Уважать процесс управления изменениями
8. Тщательно рассматривать зафиксированные требования
9. Информировать BA об изменениях в окружении

---

## Источники из книги

- Книга содержит обширную библиографию (Appendix C: References) с указанием ключевых работ по каждому разделу
- Ключевые ссылки: Sommerville & Sawyer (1997), IEEE/ISO/IEEE 29148:2011, IIBA BABOK, Davis (2005), Wiegers (2002, 2006), Gottesdiener (2005)