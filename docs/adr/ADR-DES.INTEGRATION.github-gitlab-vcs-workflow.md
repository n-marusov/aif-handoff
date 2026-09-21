# ADR-DES.INTEGRATION.github-gitlab-vcs-workflow

**Статус:** ПРИНЯТО
**Дата:** 2026-09-14
**Контекст:** Задачи AIF Handoff могут быть связаны с Issues на GitHub или GitLab. Пользователь хочет, чтобы изменение проходило полный цикл: Issue → ветка → коммиты → PR/MR → ревью → merge — без ручного создания веток, коммитов и PR. При этом VCS остаётся единственным источником истины для merge и финального approval, а система не хранит VCS-токены в git.

**Требование-источник:** `vision.md` §1.4 HF-5, `docs/architecture.md` §GitHub Issue-to-PR Workflow, §GitLab Issue-to-MR Workflow

**Решение:** Асинхронная двунаправленная синхронизация с VCS через REST API:

- **Импорт Issue:** API периодически сканирует Issues проекта (GithubRepository/GitlabRepository), идемпотентно маппит `(projectId, issue_number/iid)` → задача. Тайтл, тело, лейблы, assignees, milestone — refreshable snapshot.
- **Ветка и PR/MR:** каждая задача создаёт ветку `feature/github-issue-<N>` или `feature/gitlab-issue-<N>` (из RULES-конвенции). После реализации — коммит + пуш. PR/MR создаётся/обновляется через API: тело включает маркер `<!-- aif:pr-mode=plan_review -->` / `<!-- aif:mr-mode=plan_review -->` для plan-review, и `<!-- aif:pr-mode=implementation -->` после реализации.
- **Plan Review Gate (optional):** `AIF_PLAN_REVIEW_PR_ENABLED=true` — после планирования публикуется plan-only PR/MR; implementation начинается только после approval в VCS.
- **Асинхронная синхронизация состояния:** API читает состояние PR/MR (approvals, review comments, merge status) при каждом синхро-цикле. Approved → `implementing`, changes requested → `improve` (plan_review) или `implementing` (реализация), merged → `verified`, closed unmerged → pause.
- **Pull vs Push:** PR/MR создаётся и обновляется по REST; git push — через Git credentials (не токен). API key для GitHub/GitLab API — отдельно, в проектных настройках.

**Рассмотренные альтернативы:**

- **GitHub Actions / GitLab CI** — пайплайн внутри VCS через webhooks. Отвергнуто: Handoff — основная система; VCS — внешняя интеграция; webhooks ненадёжны, сложнее отладка.
- **Webhook-only синхронизация** — события от VCS триггерят Handoff. Отвергнуто: webhooks могут быть потеряны, не работают в локальном dev; poll-цикл — надёжный fallback.
- **GitHub App / GitLab App** — полноценная VCS-интеграция. Отвергнуто: избыточно; установка App требует дополнительных разрешений; REST API + poll достаточны для текущей функциональности.

**Последствия:**

- **Положительные:** полный cycle Issue → PR/MR → merge без ручных операций; plan-review gate разделяет планирование и реализацию; один VCS провайдер активен за раз (`GIT_PROVIDER=github|gitlab`).
- **Отрицательные:** poll-based sync — latency до 30s; PR creation может задублироваться на restart race (lookup by branch); GitLab Free tier не отдаёт `requested_changes` в MR API — детектится через system note body.
- **Смягчение:** fingerprint на review comments (GitHub: body fingerprint, GitLab: `<!-- aif-gitlab-review -->`); PR/MR creation idempotent через branch lookup; GitLab Free tier — fallback на парсинг notes API.
