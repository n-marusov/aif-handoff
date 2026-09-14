# ADR-DES.API.hono-websocket-adoption

**Статус:** ПРИНЯТО
**Дата:** 2026-09-14
**Контекст:** API-серверу AIF Handoff требуется обрабатывать REST-запросы (CRUD для задач, проектов, чата) и поддерживать WebSocket для real-time обновлений Kanban и сигналов координатору. Без встроенной поддержки WebSocket пришлось бы комбинировать два разных сервера (Express/koa + ws) или добавлять прослойку-SSE.

**Требование-источник:** `vision.md` §1.3 HF-2 (Kanban), `vision.md` §1.4 HF-9 (пинг/мониторинг), `docs/architecture.md` §Real-Time Updates, `.ai-factory/ARCHITECTURE.md`

**Решение:** Использовать Hono — лёгкий TypeScript-фреймворк со встроенной поддержкой WebSocket через `@hono/hono-ws`. Единый сервер на порту 3009 обслуживает REST-маршруты (`/api/tasks`, `/api/projects`, `/api/chat` и т.д.) и WebSocket (`/ws`) в одном процессе. WebSocket используется для: `task:created/updated/moved/deleted`, `task:qa_started/done/failed`, `agent:wake`, `task:heartbeat`, `project:runtime_limit_updated`. UI подключается через хук `useWebSocket` и инвалидирует React Query на входящие события.

**Рассмотренные альтернативы:**

- **Express + ws module** — де-факто стандартный стек Node.js. Отвергнуто: Express не имеет встроенной WS-поддержки, требуется отдельный сервер-обвязка; типизация middleware слабее.
- **Fastify + @fastify/websocket** — производительнее Express, но тяжелее Hono для нашего объёма запросов. Отвергнуто: избыточно, Hono с родной типизацией Zod через `@hono/zod-validator` даёт лучший DX.
- **SSE вместо WebSocket** — Server-Sent Events. Отвергнуто: однонаправленный канал, нет возможности стримить от клиента (необходимо для будущих интерактивных кейсов).

**Последствия:**

- **Положительные:** единый порт и процесс для REST+WS, middleware (`auth`, `rateLimit`, `zodValidator`) работает для обоих протоколов.
- **Отрицательные:** Hono — менее распространён, чем Express/koa, что может усложнить поиск разработчиков; встроенный WS через `@hono/hono-ws` добавил одну extra-зависимость.
- **Смягчение:** Hono совместим с middleware-экосистемой Express; нестандартность компенсируется отличной документацией и TypeScript-first подходом.
