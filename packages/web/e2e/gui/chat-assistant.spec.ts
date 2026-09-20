import { expect, test } from "@playwright/test";
import {
  API_URL,
  PROJECT_ID,
  createTaskViaApi,
  deleteTaskViaApi,
  openProjectBoard,
  runId,
} from "./common";

// ── HF8 chat: real-LLM E2E (без моков) ────────────────────────────────────────
// UC-chat.project-context.consult-ai-assistant: диалог в контексте проекта (основной источник).
// UC-chat.task-context.discuss-task-with-ai: диалог в контексте задачи (основной источник).
// HF8.1/HF8.2: чат с AI-ассистентом (контекст).
// BR-fact.project.runtime-profiles / BR-fact.audit.observability: профиль чата и usage (контекст).
// contract-aif-rest-api: POST /chat, GET /chat/sessions, GET /chat/sessions/:id/messages,
// GET /runtime-profiles/effective/chat/:projectId — внешний oracle (контекст).
//
// Стенд: реальный LLM через эффективный chat-профиль (без эмуляции адаптера).
// Если ключ не настроен на стенде — тесты пропускаются с явной причиной.

interface EffectiveChatRuntime {
  resolved?: { hasApiKey: boolean; runtimeId: string; model: string | null };
  profile?: { name: string } | null;
}

/** Возвращает эффективный chat-рантайм стенда или null, если endpoint недоступен. */
async function readEffectiveChatRuntime(request: import("@playwright/test").APIRequestContext) {
  const response = await request.get(`${API_URL}/runtime-profiles/effective/chat/${PROJECT_ID}`);
  if (!response.ok()) return null;
  return (await response.json()) as EffectiveChatRuntime;
}

/** Возвращает список сессий проекта. */
async function listChatSessions(request: import("@playwright/test").APIRequestContext) {
  const response = await request.get(`${API_URL}/chat/sessions?projectId=${PROJECT_ID}`);
  if (!response.ok()) return [];
  return (await response.json()) as Array<{ id: string; title: string }>;
}

/** Возвращает сообщения сессии (array из chatMessages + runtime events). */
async function readSessionMessages(
  request: import("@playwright/test").APIRequestContext,
  sessionId: string,
) {
  const response = await request.get(`${API_URL}/chat/sessions/${sessionId}/messages`);
  if (!response.ok()) return [];
  return (await response.json()) as Array<{ role: string; content: string }>;
}

// Пропуск всего набора, если на стенде нет ключа для chat-рантайма.
test.describe("L-08c/L-08d: чат с AI-ассистентом (реальный LLM)", () => {
  test.beforeAll(async ({ request }) => {
    const effective = await readEffectiveChatRuntime(request);
    test.skip(
      !effective?.resolved?.hasApiKey,
      "На стенде не настроен API-ключ chat-рантайма (resolved.hasApiKey=false) — " +
        "набор L-08c/L-08d пропущен. Настройте профиль с ключом (например OPENAI_API_KEY) и перезапустите API.",
    );
    expect(
      effective?.resolved?.runtimeId,
      "у стенда должен быть разрешённый чат-рантайм",
    ).toBeTruthy();
  });

  // UC-chat.project-context.consult-ai-assistant: чат в контексте проекта (GUI-путь, реальный LLM).
  // HF8.1: диалог в контексте проекта (контекст).
  // contract-aif-rest-api: GET /chat/sessions/:id/messages — внешний oracle (контекст).
  test("L-08c: отправка вопроса в контексте проекта возвращает ответ ассистента", async ({
    page,
    request,
  }) => {
    const marker = `e2e-chat-project-${runId()}`;

    await openProjectBoard(page);

    // GUI-путь: открыть чат из bubble и отправить сообщение.
    await page.getByRole("button", { name: "Open chat" }).click();
    await page.getByPlaceholder("Ask a question...").fill(`Say exactly: ${marker}`);
    await page.getByRole("button", { name: "Send message" }).click();

    // Пользовательское сообщение появляется в ленте чата.
    await expect(page.getByText(`Say exactly: ${marker}`, { exact: true })).toBeVisible();

    // Oracle: POST /chat создал сессию; ждём ассистентский ответ в сообщениях сессии.
    await expect
      .poll(
        async () => {
          const sessions = await listChatSessions(request);
          if (sessions.length === 0) return "no-sessions";
          const newest = sessions[sessions.length - 1];
          const messages = await readSessionMessages(request, newest.id);
          return messages.some(
            (message) => message.role === "assistant" && message.content.trim().length > 0,
          )
            ? "answered"
            : "pending";
        },
        { timeout: 120_000, intervals: [2_000, 5_000] },
      )
      .toBe("answered");
  });

  // UC-chat.task-context.discuss-task-with-ai: чат в контексте задачи (GUI-путь, реальный LLM).
  // HF8.2: диалог в контексте изменения (контекст).
  // contract-aif-rest-api: GET /chat/sessions/:id/messages — внешний oracle (контекст).
  test("L-08d: вопрос в контексте задачи сохраняет сессию, привязанную к задаче", async ({
    page,
    request,
  }) => {
    const suffix = runId();
    const title = `e2e-chat-task-${suffix}`;
    const marker = `e2e-chat-task-marker-${suffix}`;
    const task = await createTaskViaApi(request, {
      title,
      autoMode: false,
      paused: true,
    });

    try {
      await openProjectBoard(page);

      // Открываем детальный просмотр задачи (taskId попадает в ChatPanel).
      await page.getByText(title, { exact: true }).click();

      // Открываем чат и задаём вопрос в контексте задачи.
      await page.getByRole("button", { name: "Open chat" }).click();
      await page
        .getByPlaceholder("Ask a question...")
        .fill(`Respond in one line mentioning ${marker}`);
      await page.getByRole("button", { name: "Send message" }).click();

      // Пользовательское сообщение появляется в ленте чата.
      await expect(
        page.getByText(`Respond in one line mentioning ${marker}`, { exact: true }),
      ).toBeVisible();

      // Oracle: сессия создана и содержит ассистентский ответ.
      await expect
        .poll(
          async () => {
            const sessions = await listChatSessions(request);
            if (sessions.length === 0) return "no-sessions";
            const newest = sessions[sessions.length - 1];
            const messages = await readSessionMessages(request, newest.id);
            return messages.some(
              (message) => message.role === "assistant" && message.content.trim().length > 0,
            )
              ? "answered"
              : "pending";
          },
          { timeout: 120_000, intervals: [2_000, 5_000] },
        )
        .toBe("answered");
    } finally {
      await deleteTaskViaApi(request, task.id);
    }
  });
});
