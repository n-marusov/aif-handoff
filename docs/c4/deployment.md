# Deployment — AIF Handoff: развёртывание по окружениям

Диаграммы уровня Deployment показывают физическое размещение контейнеров и зависимостей
для окружений проекта. Это **as-is** снимок по текущим `docker-compose.yml`,
`docker-compose.production.yml` и режимам транспорта MCP.

Источники: [docker-compose.yml](../../docker-compose.yml),
[docker-compose.production.yml](../../docker-compose.production.yml),
[docs/mcp-sync.md](../mcp-sync.md), [.docker/angie.production.conf](../../.docker/angie.production.conf).

## 1) Development — Docker Compose

```mermaid
C4Deployment
  title Deployment — Development (docker-compose.yml)

  Deployment_Node(host, "Developer Host", "Docker Engine + Browser") {
    Deployment_Node(browserRuntime, "Web Browser", "Chrome/Firefox/Edge") {
      Container(webSpaDev, "web-spa", "React SPA", "Runs inside browser runtime")
    }

    Deployment_Node(composeNet, "Compose network", "bridge") {
      Container(web, "web-server service", "Angie serving built web", "Host WEB_PORT -> container :80")
      Container(api, "api service", "Node.js + Hono", "Host PORT -> container :3009")
      Container(agent, "agent service", "Node.js + node-cron", "Internal :3010 (expose)")
      Container(mcp, "mcp service", "Node.js + MCP SDK", "Host MCP_PORT -> container :3100")
    }

    Deployment_Node(volumes, "Docker volumes/mounts", "persistent data") {
      ContainerDb(dbData, "db-data", "SQLite volume", "/data/aif.sqlite")
      Container(projectsMount, "projects", "Bind mount", "PROJECTS_DIR -> PROJECTS_MOUNT")
      Container(claudeAuth, "claude-auth", "Volume", "/home/node/.claude")
      Container(codexAuth, "codex-auth", "Volume", "/home/node/.codex")
    }
  }

  Rel(web, webSpaDev, "Serves SPA static assets", "HTTP(S)")
  Rel(webSpaDev, api, "REST + WebSocket /ws", "HTTP(S)")
  Rel(web, api, "Reverse proxy /api + /ws", "http://api:3009")
  Rel(api, agent, "AGENT_INTERNAL_URL", "http://agent:3010")
  Rel(agent, api, "broadcast + VCS sync endpoints", "http://api:3009")
  Rel(mcp, api, "task broadcast endpoint", "http://api:3009")

  Rel(api, dbData, "reads/writes", "SQLite /data/aif.sqlite")
  Rel(agent, dbData, "reads/writes", "SQLite /data/aif.sqlite")
  Rel(mcp, dbData, "reads/writes", "SQLite /data/aif.sqlite")
  Rel(agent, projectsMount, "git worktrees", "PROJECTS_MOUNT")
  Rel(api, projectsMount, "repository prep helpers", "PROJECTS_MOUNT")
  Rel(api, claudeAuth, "provider auth", "filesystem")
  Rel(agent, claudeAuth, "provider auth", "filesystem")
  Rel(api, codexAuth, "provider auth + index", "filesystem")
  Rel(agent, codexAuth, "provider auth", "filesystem")
```

## 2) Production — Hardened Docker Compose

```mermaid
C4Deployment
  title Deployment — Production (docker-compose.production.yml)

  Deployment_Node(userDeviceProd, "User Device", "Desktop/Laptop/Mobile") {
    Deployment_Node(browserProd, "Web Browser", "Chrome/Safari/Firefox/Edge") {
      Container(webSpaProd, "web-spa", "React SPA", "Runs inside browser runtime")
    }
  }

  Deployment_Node(prodHost, "Trusted zone host", "Docker Engine") {
    Deployment_Node(net, "Compose network", "private bridge") {
      Container(webProd, "web service", "Angie reverse proxy + static", "Public :80/:443")
      Container(apiProd, "api service", "Node.js + Hono", "Bound to 127.0.0.1:3009")
      Container(agentProd, "agent service", "Node.js + node-cron", "No published ports")
      Container(mcpProd, "mcp service", "Node.js + MCP SDK", "Bound to 127.0.0.1:3100")
    }

    Deployment_Node(sec, "Security posture", "runtime hardening") {
      Container(readOnly, "read_only containers", "api + mcp", "Immutable FS + tmpfs")
      Container(noPrivEsc, "no-new-privileges", "all services", "Privilege escalation blocked")
      Container(hc, "healthchecks", "api/web/mcp", "Startup ordering + recovery")
    }

    Deployment_Node(prodVolumes, "Persistent storage", "volumes") {
      ContainerDb(dbProd, "db-data", "SQLite volume", "/data/aif.sqlite")
      Container(projectsProd, "projects", "Volume", "Target repos/worktrees")
      Container(sslCerts, "ssl-certs", "Volume", "TLS certs for Angie")
      Container(claudeAuthProd, "claude-auth", "Volume", "Provider auth")
      Container(codexAuthProd, "codex-auth", "Volume", "Provider auth")
    }
  }

  Rel(webProd, webSpaProd, "Serves SPA static assets", "HTTPS :443")
  Rel(webSpaProd, apiProd, "REST + WebSocket /ws", "HTTPS :443")
  Rel(webProd, apiProd, "proxy /api + /ws", "http://api:3009")
  Rel(apiProd, agentProd, "internal prepare/cleanup", "http://agent:3010")
  Rel(agentProd, apiProd, "broadcast + VCS sync endpoints", "http://api:3009")
  Rel(mcpProd, apiProd, "task broadcast endpoint", "http://api:3009")

  Rel(apiProd, dbProd, "reads/writes", "SQLite")
  Rel(agentProd, dbProd, "reads/writes", "SQLite")
  Rel(mcpProd, dbProd, "reads/writes", "SQLite")
  Rel(agentProd, projectsProd, "git worktrees", "filesystem")
  Rel(webProd, sslCerts, "serves TLS certs", "filesystem")
```

## 3) Дополнение: MCP stdio как клиентский режим (не отдельное окружение)

```mermaid
C4Deployment
  title MCP stdio client mode (client-side process)

  Deployment_Node(devMachine, "Developer Machine", "Windows/macOS/Linux") {
    Deployment_Node(client, "MCP client", "Claude Code/Codex/IDE") {
      Container(mcpStdio, "@aif/mcp (stdio)", "Node.js process", "Spawned by client, no listening port")
    }

    Deployment_Node(targetProject, "Project workspace", "filesystem") {
      ContainerDb(sqliteFile, "aif.sqlite", "SQLite file", "DATABASE_URL")
      Container(projectsDir, "PROJECTS_DIR", "Git worktrees", "Task worktrees")
    }
  }

  Rel(mcpStdio, sqliteFile, "handoff_* via @aif/data", "in-process SQLite")
  Rel(mcpStdio, projectsDir, "project metadata/worktree reads", "filesystem")
```

## Примечания по соответствию коду

- **Dev-окружение проекта — Docker Compose.** Основная dev-схема соответствует `docker-compose.yml`.
- `api` публикуется наружу на `3009` в dev compose и привязан к `127.0.0.1:3009` в production.
- `agent` внутренний: порт `3010` не публикуется наружу (в dev `expose`, в production без `ports`).
- `mcp` в compose работает как HTTP-сервис (`:3100`), а stdio — это отдельный клиентский режим запуска.
- БД — SQLite файл на общем томе (`db-data`), а не отдельный сетевой DB-сервис.
- В production активирован hardening: `read_only`, `tmpfs`, `no-new-privileges`, healthchecks,
  и лимиты ресурсов в `deploy.resources.limits`.

## Связанные артефакты

- [Container](container.md) — логические контейнеры и их связи
- [System Context](context.md) — внешние акторы и системы
- [Configuration](../configuration.md) — env-переменные и порты
- [MCP Sync](../mcp-sync.md) — stdio/http режимы MCP и auth
