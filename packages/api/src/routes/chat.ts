/**
 * Маршруты интерактивного чата (@aif/api).
 *
 * Тонкий HTTP-контроллер: парсит и валидирует вход, зовёт application use case
 * (`runChatTurn`) или сервисы сессий, инжектирует WebSocket-порты и формирует
 * HTTP-ответ. Вся бизнес-логика хода чата (выбор адаптера и профиля, стриминг,
 * персистенция, usage, abort) живёт в packages/api/src/use-cases/runChatTurn.ts.
 *
 * Почему файл устроен именно так:
 * - Ответ отдается по двум каналам сразу: JSON в HTTP-ответе и delta-события в
 *   WebSocket. Use case возвращает { status, body }, а маршрут только отдаёт
 *   это наружу.
 * - WS-порты (sendToClient, broadcast) инжектируются в `runChatTurn`, чтобы use
 *   case остался транспортно-нейтральным.
 * - Небольшие операции сессий (CRUD, история, вложения) остаются здесь, потому
 *   что они уже являются прямыми вызовами @aif/data и сервисов без бизнес-правил.
 */
import { Hono } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { z } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { resolveAdapterCapabilities, RuntimeTransport } from "@aif/runtime";
import {
  logger,
  getEnv,
  toChatMessageResponse,
  toChatSessionResponse,
  toRuntimeProfileResponse,
  type ChatSession,
} from "@aif/shared";
import {
  createChatSession,
  deleteChatSession,
  findChatSessionById,
  findProjectById,
  findRuntimeProfileById,
  listChatMessages,
  listChatSessions,
  listCodexSessionsByProjectRoot,
  updateChatSession,
} from "@aif/data";
import { chatRequestSchema, createChatSessionSchema, updateChatSessionSchema } from "../schemas.js";
import { readAttachment } from "../services/attachmentStorage.js";
import { broadcast, sendToClient } from "../ws.js";
import {
  getCached,
  sessionCacheKey,
  setCached,
  shouldUseSessionCacheForRuntime,
} from "../services/sessionCache.js";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";
import {
  abortChatRun,
  buildContextAppend,
  formatVirtualRuntimeSessionId,
  getAdapterForRuntimeId,
  isLocalCodexRuntimeId,
  loadIndexedCodexRuntimeMessages,
  loadIndexedCodexVirtualSession,
  mapRuntimeEventsToChatMessages,
  mergeRuntimeAndDbMessages,
  parseOptionalQueryParam,
  parseVirtualRuntimeSessionId,
  resolveChatRuntimeAdapter,
  resolveVirtualSessionLookupContext,
  runChatTurn,
  runtimeSourceFromTransport,
} from "../use-cases/runChatTurn.js";

const log = logger("chat-route");

type CreateChatSessionPayload = z.infer<typeof createChatSessionSchema>;
type UpdateChatSessionPayload = z.infer<typeof updateChatSessionSchema>;
type ChatRequestPayload = z.infer<typeof chatRequestSchema>;

export const chatRouter = new Hono();

// ── CRUD сессий ───────────────────────────────────────────────────────────────

// Проект обязателен: без него нельзя ни найти корень репозитория, ни выбрать
// профиль рантайма.
// GET /chat/sessions?projectId=...
chatRouter.get("/sessions", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }
  log.debug("GET /chat/sessions projectId=%s", projectId);

  const project = findProjectById(projectId);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  // Список отдается в двух слоях: сначала сохраненные сессии из БД, затем
  // обнаруженные у рантайма.
  const dbRows = listChatSessions(projectId);
  const dbSessions = dbRows.map(toChatSessionResponse);

  // Собираем id внешних runtime-сессий, привязанных в БД, чтобы не дублировать.
  const linkedRuntimeSessionIds = new Set(
    dbRows.map((r) => r.runtimeSessionId ?? r.agentSessionId).filter(Boolean) as string[],
  );

  // Обнаружение сессий у рантайма - вспомогательное: при недоступности
  // провайдера пользователь все равно должен видеть свои сохраненные чаты.
  let runtimeSessions: ChatSession[] = [];
  const systemAppend = buildContextAppend(project.name, null);
  try {
    const { context } = await resolveChatRuntimeAdapter(
      projectId,
      "session-discovery",
      systemAppend,
    );
    const adapter = context.adapter;
    const runtimeId = context.resolvedProfile.runtimeId;
    if (isLocalCodexRuntimeId(runtimeId)) {
      const indexed = listCodexSessionsByProjectRoot({
        projectRoot: project.rootPath,
        limit: 50,
      });
      runtimeSessions = indexed
        .filter((session) => !linkedRuntimeSessionIds.has(session.sessionId))
        .map((session) => ({
          id: formatVirtualRuntimeSessionId(
            runtimeId,
            session.sessionId,
            context.resolvedProfile.transport,
          ),
          projectId,
          title: session.title || session.previewText || "Untitled",
          agentSessionId: null,
          runtimeProfileId: context.resolvedProfile.profileId,
          runtimeSessionId: session.sessionId,
          source: runtimeSourceFromTransport(context.resolvedProfile.transport),
          createdAt: session.sourceCreatedAt ?? session.createdAt,
          updatedAt: session.sourceUpdatedAt ?? session.updatedAt,
        }));

      log.debug(
        {
          projectId,
          runtimeId,
          profileId: context.resolvedProfile.profileId,
          source: "codex_index",
          discovered: indexed.length,
          mergedRuntimeSessions: runtimeSessions.length,
          dbSessions: dbSessions.length,
        },
        "[chat-route] Runtime session discovery completed",
      );
    } else {
      const caps = resolveAdapterCapabilities(adapter, context.resolvedProfile.transport);
      if (!caps.supportsSessionList || !adapter.listSessions) {
        log.warn(
          {
            projectId,
            runtimeId,
            profileId: context.resolvedProfile.profileId,
          },
          "WARN [chat-route] Runtime does not support external session listing; returning DB sessions only",
        );
      } else {
        // Кеш нужен из-за дорогого листинга у провайдера.
        const useCache = shouldUseSessionCacheForRuntime(runtimeId);
        const cacheKey = sessionCacheKey(
          runtimeId,
          context.resolvedProfile.profileId,
          project.rootPath,
        );
        let listed = useCache
          ? getCached<Awaited<ReturnType<NonNullable<typeof adapter.listSessions>>>>(cacheKey)
          : undefined;
        if (!listed) {
          listed = await adapter.listSessions({
            runtimeId,
            providerId: context.resolvedProfile.providerId,
            profileId: context.resolvedProfile.profileId,
            projectRoot: project.rootPath,
            transport: context.resolvedProfile.transport,
            limit: 50,
            options: {
              ...context.resolvedProfile.options,
              ...(context.resolvedProfile.baseUrl
                ? { baseUrl: context.resolvedProfile.baseUrl }
                : {}),
            },
            headers: context.resolvedProfile.headers,
          });
          if (useCache) {
            setCached(cacheKey, listed);
          }
        }

        runtimeSessions = listed
          .filter((session) => !linkedRuntimeSessionIds.has(session.id))
          .map((session) => ({
            id: formatVirtualRuntimeSessionId(
              runtimeId,
              session.id,
              context.resolvedProfile.transport,
            ),
            projectId,
            title: session.title || "Untitled",
            agentSessionId: null,
            runtimeProfileId: context.resolvedProfile.profileId,
            runtimeSessionId: session.id,
            source: runtimeSourceFromTransport(context.resolvedProfile.transport),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          }));

        log.debug(
          {
            projectId,
            runtimeId,
            profileId: context.resolvedProfile.profileId,
            source: "runtime_adapter",
            cacheEnabled: useCache,
            discovered: listed.length,
            mergedRuntimeSessions: runtimeSessions.length,
            dbSessions: dbSessions.length,
          },
          "[chat-route] Runtime session discovery completed",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err, projectId },
      "WARN [chat-route] Failed runtime session discovery; returning DB sessions only",
    );
  }

  // Слияние, сортировка по updatedAt DESC, не более 20.
  const all = [...dbSessions, ...runtimeSessions]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);

  return c.json(all);
});

// POST /chat/sessions
chatRouter.post("/sessions", jsonValidator(createChatSessionSchema), async (c) => {
  const body = c.req.valid("json") as CreateChatSessionPayload;
  log.debug("POST /chat/sessions projectId=%s title=%s", body.projectId, body.title);
  // Проверяем, что выбранный профиль действительно принадлежит проекту.
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: body.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    return c.json(runtimeValidation, 400);
  }

  const row = createChatSession({
    projectId: body.projectId,
    title: body.title,
    runtimeProfileId: body.runtimeProfileId,
    runtimeSessionId: body.runtimeSessionId,
  });
  if (!row) {
    return c.json({ error: "Failed to create chat session" }, 500);
  }
  const session = toChatSessionResponse(row);
  broadcast({ type: "chat:session_created", payload: session });
  return c.json(session, 201);
});

// GET /chat/sessions/:id
chatRouter.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  log.debug("GET /chat/sessions/%s", id);

  // Виртуальный id означает сессию рантайма без строки в БД.
  const virtual = parseVirtualRuntimeSessionId(id);
  if (virtual) {
    const queryProjectId = parseOptionalQueryParam(c.req.query("projectId"));
    const queryRuntimeProfileId = parseOptionalQueryParam(c.req.query("runtimeProfileId"));
    if (isLocalCodexRuntimeId(virtual.runtimeId)) {
      const indexedSession = await loadIndexedCodexVirtualSession({
        virtualId: id,
        projectId: queryProjectId,
        runtimeProfileId: queryRuntimeProfileId,
        runtimeSessionId: virtual.sessionId,
      });
      if (indexedSession) {
        return c.json(indexedSession);
      }
      log.debug(
        {
          runtimeId: virtual.runtimeId,
          runtimeSessionId: virtual.sessionId,
          source: "codex_index",
        },
        "[chat-route] Indexed Codex session lookup missed; falling back to adapter",
      );
    }

    try {
      const adapter = await getAdapterForRuntimeId(virtual.runtimeId);
      if (!adapter.getSession) {
        return c.json({ error: "Runtime does not support session details" }, 404);
      }
      const lookupContext = await resolveVirtualSessionLookupContext({
        runtimeId: virtual.runtimeId,
        adapter,
        projectId: queryProjectId,
        runtimeProfileId: queryRuntimeProfileId,
      });
      const info = await adapter.getSession({
        runtimeId: virtual.runtimeId,
        providerId: lookupContext.providerId,
        profileId: lookupContext.profileId,
        projectRoot: lookupContext.projectRoot,
        transport: lookupContext.transport as RuntimeTransport | undefined,
        sessionId: virtual.sessionId,
        options: lookupContext.options,
        headers: lookupContext.headers,
      });
      if (!info) {
        return c.json({ error: "Chat session not found" }, 404);
      }
      const session: ChatSession = {
        id,
        projectId: "",
        title: info.title || "Untitled",
        agentSessionId: null,
        runtimeProfileId: lookupContext.runtimeProfileId,
        runtimeSessionId: info.id,
        source: runtimeSourceFromTransport(lookupContext.transport ?? RuntimeTransport.API),
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
      };
      return c.json(session);
    } catch (err) {
      log.warn({ err, runtimeId: virtual.runtimeId }, "Failed to get runtime session info");
      return c.json({ error: "Chat session not found" }, 404);
    }
  }

  const row = findChatSessionById(id);
  if (!row) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  return c.json(toChatSessionResponse(row));
});

// GET /chat/sessions/:id/messages
chatRouter.get("/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  log.debug("GET /chat/sessions/%s/messages", id);

  const virtual = parseVirtualRuntimeSessionId(id);
  if (virtual) {
    const queryProjectId = parseOptionalQueryParam(c.req.query("projectId"));
    const queryRuntimeProfileId = parseOptionalQueryParam(c.req.query("runtimeProfileId"));
    if (isLocalCodexRuntimeId(virtual.runtimeId)) {
      const indexedMessages = await loadIndexedCodexRuntimeMessages({
        runtimeSessionId: virtual.sessionId,
        chatSessionId: id,
      });
      if (indexedMessages) {
        return c.json(indexedMessages);
      }
      log.debug(
        {
          runtimeId: virtual.runtimeId,
          runtimeSessionId: virtual.sessionId,
          source: "codex_index",
        },
        "[chat-route] Indexed Codex session-message lookup missed; falling back to adapter",
      );
    }

    try {
      const adapter = await getAdapterForRuntimeId(virtual.runtimeId);
      if (!adapter.listSessionEvents) {
        return c.json({ error: "Runtime does not support session message listing" }, 404);
      }
      const lookupContext = await resolveVirtualSessionLookupContext({
        runtimeId: virtual.runtimeId,
        adapter,
        projectId: queryProjectId,
        runtimeProfileId: queryRuntimeProfileId,
      });

      const runtimeEvents = await adapter.listSessionEvents({
        runtimeId: virtual.runtimeId,
        providerId: lookupContext.providerId,
        profileId: lookupContext.profileId,
        projectRoot: lookupContext.projectRoot,
        transport: lookupContext.transport as RuntimeTransport | undefined,
        sessionId: virtual.sessionId,
        options: lookupContext.options,
        headers: lookupContext.headers,
      });

      const messages = mapRuntimeEventsToChatMessages(runtimeEvents, id, adapter);

      return c.json(messages);
    } catch (err) {
      log.warn(
        { err, runtimeId: virtual.runtimeId, runtimeSessionId: virtual.sessionId },
        "Failed to get runtime session messages",
      );
      return c.json({ error: "Chat session not found" }, 404);
    }
  }

  const session = findChatSessionById(id);
  if (!session) {
    return c.json({ error: "Chat session not found" }, 404);
  }

  // Основной путь: сессия есть в БД. К ее сообщениям добавляются события
  // рантайма, чтобы UI видел и то, что сохранил сервер, и то, что успел
  // начитать провайдер.
  const dbMessages = listChatMessages(id).map(toChatMessageResponse);
  const project = findProjectById(session.projectId);
  const linkedRuntimeSessionId = session.runtimeSessionId ?? session.agentSessionId;

  if (linkedRuntimeSessionId && project) {
    let runtimeId = getEnv().AIF_DEFAULT_RUNTIME_ID;
    let providerId = getEnv().AIF_DEFAULT_PROVIDER_ID;
    let profileId = session.runtimeProfileId ?? null;
    let profileOptions: Record<string, unknown> | undefined;
    let profileHeaders: Record<string, string> | undefined;
    let profileBaseUrl: string | null = null;
    let profileTransport: RuntimeTransport | undefined;

    if (session.runtimeProfileId) {
      const profileRow = findRuntimeProfileById(session.runtimeProfileId);
      if (profileRow) {
        const profile = toRuntimeProfileResponse(profileRow);
        runtimeId = profile.runtimeId;
        providerId = profile.providerId;
        profileId = profile.id;
        profileOptions = profile.options;
        profileHeaders = profile.headers;
        profileBaseUrl = profile.baseUrl ?? null;
        profileTransport = (profile.transport ?? undefined) as RuntimeTransport | undefined;
      }
    }

    try {
      if (isLocalCodexRuntimeId(runtimeId)) {
        const indexedRuntimeMessages = await loadIndexedCodexRuntimeMessages({
          runtimeSessionId: linkedRuntimeSessionId,
          chatSessionId: id,
        });
        if (indexedRuntimeMessages) {
          if (indexedRuntimeMessages.length === 0 && dbMessages.length > 0) {
            log.debug(
              {
                sessionId: id,
                runtimeId,
                runtimeSessionId: linkedRuntimeSessionId,
                dbMessageCount: dbMessages.length,
              },
              "[chat-route] Indexed Codex runtime events were empty; falling back to DB messages",
            );
            return c.json(dbMessages);
          }
          return c.json(mergeRuntimeAndDbMessages(indexedRuntimeMessages, dbMessages));
        }
      }

      const adapter = await getAdapterForRuntimeId(runtimeId);
      if (adapter.listSessionEvents) {
        const runtimeEvents = await adapter.listSessionEvents({
          runtimeId,
          providerId,
          profileId,
          projectRoot: project.rootPath,
          transport: profileTransport,
          sessionId: linkedRuntimeSessionId,
          options: {
            ...(profileOptions ?? {}),
            ...(profileBaseUrl ? { baseUrl: profileBaseUrl } : {}),
          },
          headers: profileHeaders,
        });

        const runtimeMessages = mapRuntimeEventsToChatMessages(runtimeEvents, id, adapter);

        // Пустой ответ рантайма не стирает историю.
        if (runtimeMessages.length === 0 && dbMessages.length > 0) {
          log.debug(
            {
              sessionId: id,
              runtimeId,
              runtimeSessionId: linkedRuntimeSessionId,
              dbMessageCount: dbMessages.length,
            },
            "[chat-route] Runtime session events were empty; falling back to DB messages",
          );
          return c.json(dbMessages);
        }

        return c.json(mergeRuntimeAndDbMessages(runtimeMessages, dbMessages));
      }
    } catch (err) {
      log.warn(
        { err, runtimeId, runtimeSessionId: linkedRuntimeSessionId },
        "WARN [chat-route] Failed runtime session event load, falling back to DB messages",
      );
    }
  }

  return c.json(dbMessages);
});

// PUT /chat/sessions/:id
chatRouter.put("/sessions/:id", jsonValidator(updateChatSessionSchema), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json") as UpdateChatSessionPayload;
  log.debug("PUT /chat/sessions/%s title=%s", id, body.title);
  const existing = findChatSessionById(id);
  if (!existing) {
    return c.json({ error: "Chat session not found" }, 404);
  }

  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: existing.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    return c.json(runtimeValidation, 400);
  }

  const row = updateChatSession(id, {
    title: body.title,
    runtimeProfileId: body.runtimeProfileId,
    runtimeSessionId: body.runtimeSessionId,
  });
  return c.json(row ? toChatSessionResponse(row) : null);
});

// DELETE /chat/sessions/:id
chatRouter.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  log.debug("DELETE /chat/sessions/%s", id);
  const existing = findChatSessionById(id);
  if (!existing) {
    return c.json({ error: "Chat session not found" }, 404);
  }
  deleteChatSession(id);
  broadcast({ type: "chat:session_deleted", payload: { id } });
  return c.body(null, 204);
});

// GET /chat/sessions/:sessionId/attachments/:filename — скачать вложение чата
chatRouter.get("/sessions/:sessionId/attachments/:filename", async (c) => {
  const { sessionId, filename } = c.req.param();
  const session = findChatSessionById(sessionId);
  if (!session) return c.json({ error: "Chat session not found" }, 404);

  const project = findProjectById(session.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const messages = listChatMessages(sessionId);
  const decodedFilename = decodeURIComponent(filename);

  // Вложение ищется перебором сообщений сессии: путь к файлу хранится только в
  // БД, а не в URL.
  for (const msg of messages) {
    const response = toChatMessageResponse(msg);
    const attachment = response.attachments?.find((a) => a.name === decodedFilename);
    if (attachment?.path) {
      try {
        const buffer = await readAttachment(project.rootPath, attachment.path);
        c.header("Content-Type", attachment.mimeType || "application/octet-stream");
        c.header("Content-Disposition", `attachment; filename="${attachment.name}"`);
        c.header("Content-Length", String(buffer.length));
        return new Response(new Uint8Array(buffer), { headers: c.res.headers });
      } catch {
        return c.json({ error: "Attachment file not found on disk" }, 404);
      }
    }
  }

  return c.json({ error: "Attachment not found" }, 404);
});

// POST /chat/:conversationId/abort — прервать выполняющийся запуск чата.
chatRouter.post("/:conversationId/abort", async (c) => {
  const conversationId = c.req.param("conversationId");
  const aborted = abortChatRun(conversationId);
  if (!aborted) {
    log.debug(
      { conversationId },
      "[chat-route] abort requested for unknown or completed conversation",
    );
    return c.json({ error: "Conversation not found or already completed" }, 404);
  }
  return c.body(null, 204);
});

// POST /chat — выполнить ход чата (тонкий контроллер над runChatTurn).
chatRouter.post("/", jsonValidator(chatRequestSchema), async (c) => {
  const body = c.req.valid("json") as ChatRequestPayload;
  const result = await runChatTurn(
    {
      projectId: body.projectId,
      message: body.message,
      clientId: body.clientId,
      conversationId: body.conversationId,
      explore: body.explore,
      taskId: body.taskId,
      attachments: body.attachments,
      inputSessionId: body.sessionId,
    },
    {
      sendToClient: (clientId, event) => {
        sendToClient(clientId, event);
      },
      broadcast: (event) => {
        broadcast(event);
      },
    },
  );
  log.debug(
    {
      route: "POST /chat",
      useCase: "runChatTurn",
      outcome: result.status === 200 ? "ok" : `http_${result.status}`,
    },
    "Chat turn delegated to use case",
  );
  return c.json(result.body, result.status as ContentfulStatusCode);
});
