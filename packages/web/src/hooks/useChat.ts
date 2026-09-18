import { useState, useCallback, useEffect, useRef } from "react";
import type {
  ChatMessage,
  ChatAttachment,
  ChatMessageAttachment,
  ChatStreamTokenPayload,
  ChatDonePayload,
  ChatErrorPayload,
  RuntimeLimitSnapshot,
} from "@aif/shared/browser";
import { api, ApiError } from "@/lib/api";
import { randomUUID } from "@/lib/uuid";
import { getWsClientId } from "./useWebSocket";

interface SessionStreamState {
  conversationId: string;
  accumulator: string;
  messages: ChatMessage[];
  errorHandled: boolean;
}

const WS_CLIENT_ID_WAIT_TIMEOUT_MS = 500;
const WS_CLIENT_ID_POLL_INTERVAL_MS = 50;

async function waitForWsClientId(
  timeoutMs = WS_CLIENT_ID_WAIT_TIMEOUT_MS,
  pollIntervalMs = WS_CLIENT_ID_POLL_INTERVAL_MS,
): Promise<string | null> {
  const existing = getWsClientId();
  if (existing) return existing;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const clientId = getWsClientId();
    if (clientId) return clientId;
  }

  return getWsClientId();
}

export function useChat(
  projectId: string | null,
  sessionId: string | null = null,
  taskId: string | null = null,
  onSessionResolved?: (sessionId: string) => void,
  sessionRuntimeProfileId: string | null = null,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [explore, setExplore] = useState(false);
  const [chatErrorCode, setChatErrorCode] = useState<string | null>(null);
  const [chatRuntimeLimitSnapshot, setChatRuntimeLimitSnapshot] =
    useState<RuntimeLimitSnapshot | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

  // Состояние потокового ответа по сессиям: conversationId -> streamKey
  // (sessionId или conversationId).
  const activeStreamsRef = useRef<Map<string, string>>(new Map());
  // Данные потокового ответа по сессиям: streamKey -> state.
  const sessionStreamsRef = useRef<Map<string, SessionStreamState>>(new Map());
  // Храним conversationId для случая без sessionId (для сопоставления событий).
  const conversationIdForNoSession = useRef<string | null>(null);
  // Исключаем двойную обработку одной и той же ошибки из WS и HTTP.
  const handledErrorConversationsRef = useRef<Set<string>>(new Set());
  // Таймеры HTTP-резерва и принудительной остановки по каждому conversationId.
  const fallbackTimersRef = useRef<Map<string, number>>(new Map());
  const forcedStopTimersRef = useRef<Map<string, number>>(new Map());

  const clearConversationTimers = useCallback((conversationId: string) => {
    const fallbackTimer = fallbackTimersRef.current.get(conversationId);
    if (fallbackTimer !== undefined) {
      window.clearTimeout(fallbackTimer);
      fallbackTimersRef.current.delete(conversationId);
    }

    const forcedStopTimer = forcedStopTimersRef.current.get(conversationId);
    if (forcedStopTimer !== undefined) {
      window.clearTimeout(forcedStopTimer);
      forcedStopTimersRef.current.delete(conversationId);
    }
  }, []);

  const clearAllConversationTimers = useCallback(() => {
    const conversationIds = new Set([
      ...fallbackTimersRef.current.keys(),
      ...forcedStopTimersRef.current.keys(),
    ]);
    for (const conversationId of conversationIds) {
      clearConversationTimers(conversationId);
    }
  }, [clearConversationTimers]);

  // Проверяет, идёт ли сейчас потоковый ответ для указанной сессии.
  const isSessionStreaming = useCallback((sid: string | null) => {
    if (!sid) return false;
    for (const [, streamSid] of activeStreamsRef.current) {
      if (streamSid === sid) return true;
    }
    return false;
  }, []);

  // true, если `streamKey` относится к сессии, которую пользователь видит сейчас.
  // Все завершения потока должны проходить через эту проверку,
  // иначе фоновая сессия может испортить состояние текущей вкладки.
  const isCurrentStream = useCallback((streamKey: string) => {
    return (
      currentSessionIdRef.current === streamKey ||
      (!currentSessionIdRef.current && streamKey === conversationIdForNoSession.current)
    );
  }, []);

  const prevSessionIdRef = useRef<string | null>(null);
  // Загружает сообщения при смене sessionId.
  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;

    if (!sessionId) {
      if (prevSessionId !== null) {
        console.debug("[useChat] Session cleared, resetting messages");
        currentSessionIdRef.current = null;
        queueMicrotask(() => {
          setMessages([]);
          setChatErrorCode(null);
          setChatRuntimeLimitSnapshot(null);
          setIsStreaming(false);
          setIsLoadingMessages(false);
        });
      }
      return;
    }

    if (sessionId === currentSessionIdRef.current) return;

    currentSessionIdRef.current = sessionId;

    // Если в сессии идёт поток, восстанавливаем промежуточные сообщения.
    const streamState = sessionStreamsRef.current.get(sessionId);
    if (streamState) {
      console.debug("[useChat] Restoring streaming session %s", sessionId);
      setMessages(streamState.messages);
      setIsStreaming(true);
      setChatErrorCode(null);
      setChatRuntimeLimitSnapshot(null);
      setIsLoadingMessages(false);
      return;
    }

    // Иначе загружаем с сервера: очищаем устаревшие данные и показываем индикатор загрузки.
    queueMicrotask(() => {
      setIsStreaming(false);
      setMessages([]);
      setChatErrorCode(null);
      setChatRuntimeLimitSnapshot(null);
      setIsLoadingMessages(true);
    });
    console.debug("[useChat] Loading session messages sessionId=%s", sessionId);

    api
      .getChatSessionMessages(sessionId, {
        projectId,
        runtimeProfileId: sessionRuntimeProfileId,
      })
      .then((msgs) => {
        if (currentSessionIdRef.current !== sessionId) return;
        if (isSessionStreaming(sessionId)) {
          console.debug("[useChat] Skipping session load — streaming in progress");
          setIsLoadingMessages(false);
          return;
        }
        console.debug("[useChat] Session changed, loaded %d messages", msgs.length);
        setMessages(
          msgs.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.attachments?.length ? { attachments: m.attachments } : {}),
          })),
        );
        setChatErrorCode(null);
        setChatRuntimeLimitSnapshot(null);
        setIsLoadingMessages(false);
      })
      .catch((err) => {
        console.error("[useChat] Failed to load session messages:", err);
        if (currentSessionIdRef.current === sessionId) {
          setIsLoadingMessages(false);
        }
      });
  }, [projectId, sessionId, sessionRuntimeProfileId, isSessionStreaming]);

  // Подписка на потоковые события чата, отправляемые из useWebSocket.
  useEffect(() => {
    const handleToken = (e: Event) => {
      const { conversationId, token } = (e as CustomEvent<ChatStreamTokenPayload>).detail;
      const streamKey = activeStreamsRef.current.get(conversationId);
      if (!streamKey) return;

      clearConversationTimers(conversationId);

      const state = sessionStreamsRef.current.get(streamKey);
      if (!state) return;

      state.accumulator += token;
      const accumulated = state.accumulator;

      const last = state.messages[state.messages.length - 1];
      if (last?.role === "assistant") {
        state.messages = [
          ...state.messages.slice(0, -1),
          { role: "assistant", content: accumulated },
        ];
      } else {
        state.messages = [...state.messages, { role: "assistant", content: accumulated }];
      }

      if (isCurrentStream(streamKey)) {
        setMessages(state.messages);
      }
    };

    const handleDone = (e: Event) => {
      const { conversationId, runtimeLimitSnapshot } = (e as CustomEvent<ChatDonePayload>).detail;
      const streamKey = activeStreamsRef.current.get(conversationId);
      if (!streamKey) return;

      console.debug("[useChat] Stream done for %s conversation %s", streamKey, conversationId);
      clearConversationTimers(conversationId);
      activeStreamsRef.current.delete(conversationId);
      sessionStreamsRef.current.delete(streamKey);

      if (isCurrentStream(streamKey)) {
        setIsStreaming(false);
        setChatRuntimeLimitSnapshot(runtimeLimitSnapshot ?? null);
      }
      handledErrorConversationsRef.current.delete(conversationId);
    };

    const handleError = (e: Event) => {
      const { conversationId, message, code, runtimeLimitSnapshot } = (
        e as CustomEvent<ChatErrorPayload>
      ).detail;
      const streamKey = activeStreamsRef.current.get(conversationId);
      if (!streamKey) return;

      const state = sessionStreamsRef.current.get(streamKey);
      if (state) state.errorHandled = true;
      handledErrorConversationsRef.current.add(conversationId);

      console.debug("[useChat] Stream error for %s", streamKey);
      clearConversationTimers(conversationId);
      activeStreamsRef.current.delete(conversationId);
      sessionStreamsRef.current.delete(streamKey);

      if (isCurrentStream(streamKey)) {
        setIsStreaming(false);
        setChatErrorCode(code ?? null);
        setChatRuntimeLimitSnapshot(runtimeLimitSnapshot ?? null);
        // Пользовательский abort показываем через banner (chatErrorCode),
        // без искусственного сообщения ассистента. Частичный текст уже виден
        // в транскрипте через handleToken.
        if (code !== "aborted") {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: message || "Chat request failed" },
          ]);
        }
      }
    };

    window.addEventListener("chat:token", handleToken);
    window.addEventListener("chat:done", handleDone);
    window.addEventListener("chat:error", handleError);
    return () => {
      window.removeEventListener("chat:token", handleToken);
      window.removeEventListener("chat:done", handleDone);
      window.removeEventListener("chat:error", handleError);
      clearAllConversationTimers();
    };
  }, [clearAllConversationTimers, clearConversationTimers, isCurrentStream]);

  const sendMessage = useCallback(
    async (text: string, attachments?: ChatAttachment[], forceNewSession?: boolean) => {
      if (!projectId || !text.trim() || isStreaming) return;

      const clientId = await waitForWsClientId();
      if (!clientId) {
        console.debug("[useChat] No clientId available, proceeding with HTTP fallback");
      }

      // При смене runtime запускаем новую сессию вместо продолжения старой.
      if (forceNewSession) {
        currentSessionIdRef.current = null;
      }

      const newConversationId = randomUUID();
      const effectiveSessionId = forceNewSession
        ? null
        : (sessionId ?? currentSessionIdRef.current);
      // В качестве stream key используем sessionId или conversationId
      // (если сессия ещё не создана).
      const streamKey = effectiveSessionId ?? newConversationId;

      const messageAttachments: ChatMessageAttachment[] | undefined = attachments?.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      }));
      const userMessage: ChatMessage = {
        role: "user",
        content: text.trim(),
        ...(messageAttachments?.length ? { attachments: messageAttachments } : {}),
      };
      // При принудительном запуске новой сессии не переносим старые сообщения.
      const newMessages = forceNewSession ? [userMessage] : [...messages, userMessage];

      // Регистрируем активный поток ответа.
      if (!effectiveSessionId) {
        conversationIdForNoSession.current = newConversationId;
      }
      activeStreamsRef.current.set(newConversationId, streamKey);
      sessionStreamsRef.current.set(streamKey, {
        conversationId: newConversationId,
        accumulator: "",
        messages: newMessages,
        errorHandled: false,
      });

      setMessages(newMessages);
      setIsStreaming(true);
      setChatErrorCode(null);
      setChatRuntimeLimitSnapshot(null);
      if (explore) setExplore(false);

      console.debug("[useChat] Sending message:", {
        projectId,
        conversationId: newConversationId,
        sessionId: effectiveSessionId,
        explore,
      });

      try {
        const result = await api.sendChatMessage({
          projectId,
          message: text.trim(),
          conversationId: newConversationId,
          sessionId: effectiveSessionId ?? undefined,
          explore,
          ...(clientId ? { clientId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(attachments?.length ? { attachments } : {}),
        });

        if (result.sessionId) {
          const resolvedId = result.sessionId;
          // Переносим состояние потока на подтверждённый ключ,
          // чтобы входящие WS-события продолжали корректно сопоставляться.
          if (streamKey !== resolvedId) {
            const state = sessionStreamsRef.current.get(streamKey);
            if (state) {
              sessionStreamsRef.current.delete(streamKey);
              sessionStreamsRef.current.set(resolvedId, state);
            }
            activeStreamsRef.current.set(newConversationId, resolvedId);
          }

          // Перепривязываем отображаемую сессию только если пользователь
          // всё ещё в этом потоке, иначе фоновое завершение уведёт его на другую сессию.
          if (isCurrentStream(streamKey)) {
            currentSessionIdRef.current = resolvedId;
            if (resolvedId !== effectiveSessionId) {
              onSessionResolved?.(resolvedId);
            }
          }
          // Обновление боковой панели не зависит от текущего просмотра.
          window.dispatchEvent(
            new CustomEvent("chat:session_created", { detail: { id: resolvedId } }),
          );
        }

        // Обновляем вложения пользовательского сообщения путями,
        // подтверждёнными сервером (для ссылок скачивания).
        if (result.attachments?.length) {
          const resolvedAttachments = result.attachments;
          const activeStreamKey = activeStreamsRef.current.get(newConversationId) ?? streamKey;
          const state = sessionStreamsRef.current.get(activeStreamKey);
          if (state) {
            // Также обновляем промежуточное состояние потока,
            // чтобы при возврате в сессию вложения остались актуальными.
            state.messages = state.messages.map((m) =>
              m.role === "user" &&
              m.content === userMessage.content &&
              m.attachments &&
              !m.attachments[0]?.path
                ? { ...m, attachments: resolvedAttachments }
                : m,
            );
          }
          if (isCurrentStream(activeStreamKey)) {
            setMessages((prev) =>
              prev.map((m) => (m === userMessage ? { ...m, attachments: resolvedAttachments } : m)),
            );
          }
        }

        const assistantMessage = result.assistantMessage;
        if (assistantMessage?.trim()) {
          const fallbackTimer = window.setTimeout(() => {
            const activeStreamKey = activeStreamsRef.current.get(newConversationId);
            if (!activeStreamKey) {
              clearConversationTimers(newConversationId);
              return;
            }

            const state = sessionStreamsRef.current.get(activeStreamKey);
            if (!state) {
              clearConversationTimers(newConversationId);
              return;
            }

            if (state.accumulator.length > 0) {
              clearConversationTimers(newConversationId);
              return;
            }

            console.debug(
              "[useChat] Applying HTTP assistant fallback for conversation %s",
              newConversationId,
            );
            clearConversationTimers(newConversationId);
            state.messages = [...state.messages, { role: "assistant", content: assistantMessage }];
            activeStreamsRef.current.delete(newConversationId);
            sessionStreamsRef.current.delete(activeStreamKey);
            // Меняем UI только для просматриваемой сессии,
            // иначе фоновая сессия может подменить текущий транскрипт.
            if (isCurrentStream(activeStreamKey)) {
              setMessages(state.messages);
              setIsStreaming(false);
            }
          }, 100);
          fallbackTimersRef.current.set(newConversationId, fallbackTimer);
        }

        const forcedStopTimer = window.setTimeout(() => {
          const activeStreamKey = activeStreamsRef.current.get(newConversationId);
          if (!activeStreamKey) {
            clearConversationTimers(newConversationId);
            return;
          }

          const state = sessionStreamsRef.current.get(activeStreamKey);
          if (state?.accumulator.length) {
            clearConversationTimers(newConversationId);
            return;
          }

          console.debug("[useChat] Stream still active after HTTP — forcing stop");
          clearConversationTimers(newConversationId);
          activeStreamsRef.current.delete(newConversationId);
          sessionStreamsRef.current.delete(activeStreamKey);
          if (isCurrentStream(activeStreamKey)) {
            setIsStreaming(false);
          }
        }, 500);
        forcedStopTimersRef.current.set(newConversationId, forcedStopTimer);
      } catch (err) {
        console.error("[useChat] Failed to send message:", err);
        clearConversationTimers(newConversationId);

        const abortData =
          err instanceof ApiError && err.status === 409
            ? (err.data as {
                code?: string;
                sessionId?: string | null;
                assistantMessage?: string | null;
                attachments?: ChatMessageAttachment[];
                runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
              } | null)
            : null;
        const errorData =
          err instanceof ApiError
            ? (err.data as { runtimeLimitSnapshot?: RuntimeLimitSnapshot | null } | null)
            : null;
        const isAbortedError = abortData?.code === "aborted";

        // Если сервер прервал запуск, но уже создал сессию в БД,
        // продвигаем её в интерфейс, чтобы новая ветка чата не потерялась.
        // Переключение видимой сессии выполняется только для текущего потока.
        if (isAbortedError && abortData?.sessionId) {
          const resolvedId = abortData.sessionId;
          const shouldPromoteView = isCurrentStream(streamKey);
          if (streamKey !== resolvedId) {
            const state = sessionStreamsRef.current.get(streamKey);
            if (state) {
              sessionStreamsRef.current.delete(streamKey);
              sessionStreamsRef.current.set(resolvedId, state);
            }
            activeStreamsRef.current.set(newConversationId, resolvedId);
          }
          if (shouldPromoteView) {
            currentSessionIdRef.current = resolvedId;
            if (resolvedId !== effectiveSessionId) {
              onSessionResolved?.(resolvedId);
            }
          }
          // Боковая панель обновляется всегда, независимо от текущего просмотра.
          window.dispatchEvent(
            new CustomEvent("chat:session_created", { detail: { id: resolvedId } }),
          );
        }

        const activeStreamKey = activeStreamsRef.current.get(newConversationId) ?? streamKey;
        const state = sessionStreamsRef.current.get(activeStreamKey);
        const errorHandled = state?.errorHandled ?? false;
        const hasAccumulatedTokens = (state?.accumulator.length ?? 0) > 0;
        const shouldRollbackOptimisticFirstTurn =
          isAbortedError && !abortData?.sessionId && !effectiveSessionId;

        // При abort сначала переносим серверные данные в состояние потока,
        // затем удаляем поток и отдельно решаем, отражать ли изменения в React state.
        let patchedUserAttachments: ChatMessageAttachment[] | undefined;
        let appendedPartialAssistant: string | null = null;
        if (isAbortedError) {
          if (abortData?.attachments?.length) {
            const resolvedAttachments = abortData.attachments;
            // Обновляем промежуточное состояние потока только если оно ещё живо,
            // чтобы при позднем переключении сессии восстановить обновлённые вложения.
            if (state) {
              state.messages = state.messages.map((m) =>
                m.role === "user" &&
                m.content === userMessage.content &&
                m.attachments &&
                !m.attachments[0]?.path
                  ? { ...m, attachments: resolvedAttachments }
                  : m,
              );
            }
            // Всегда дублируем обновление в React state: если WS `chat:error`
            // уже очистил поток, без этого у сообщения не появится ссылка скачивания.
            patchedUserAttachments = resolvedAttachments;
          }
          if (
            typeof abortData?.assistantMessage === "string" &&
            abortData.assistantMessage.trim().length > 0
          ) {
            appendedPartialAssistant = abortData.assistantMessage;
            if (state && !hasAccumulatedTokens) {
              state.messages = [
                ...state.messages,
                { role: "assistant", content: appendedPartialAssistant },
              ];
            }
          }
        }

        activeStreamsRef.current.delete(newConversationId);
        sessionStreamsRef.current.delete(activeStreamKey);

        const wsHandled = handledErrorConversationsRef.current.has(newConversationId);
        // Ниже идут изменения UI, завершающие запуск.
        // Они применяются только к текущему потоку, чтобы фоновые завершения
        // не ломали видимую пользователю сессию.
        if (isCurrentStream(activeStreamKey)) {
          if (shouldRollbackOptimisticFirstTurn) {
            // Первое сообщение в новом чате ещё не было сохранено сервером.
            // Откатываем оптимистичную вставку, чтобы не оставить сиротский транскрипт.
            setMessages([]);
            conversationIdForNoSession.current = null;
          } else {
            if (patchedUserAttachments) {
              const resolved = patchedUserAttachments;
              setMessages((prev) =>
                prev.map((m) => (m === userMessage ? { ...m, attachments: resolved } : m)),
              );
            }
            if (appendedPartialAssistant) {
              const partial = appendedPartialAssistant;
              setMessages((prev) =>
                prev.some((m) => m.role === "assistant" && m.content === partial)
                  ? prev
                  : [...prev, { role: "assistant", content: partial }],
              );
            }
          }
          setIsStreaming(false);
          setChatRuntimeLimitSnapshot(
            abortData?.runtimeLimitSnapshot ?? errorData?.runtimeLimitSnapshot ?? null,
          );
          if (isAbortedError) {
            // Abort показываем только через banner, без искусственного сообщения.
            setChatErrorCode("aborted");
          } else if (!errorHandled && !wsHandled) {
            const message =
              err instanceof Error ? err.message : "Failed to get a response. Please try again.";
            setChatErrorCode(null);
            setMessages((prev) => [...prev, { role: "assistant", content: message }]);
          }
        }
        handledErrorConversationsRef.current.delete(newConversationId);
      }
    },
    [
      projectId,
      sessionId,
      messages,
      isStreaming,
      explore,
      taskId,
      onSessionResolved,
      clearConversationTimers,
      isCurrentStream,
    ],
  );

  const abortStream = useCallback(async () => {
    // Выбираем conversationId по streamKey текущей видимой сессии
    // (или ожидаемой новой), чтобы при параллельных запусках
    // не прервать чужой поток.
    const targetKey = currentSessionIdRef.current ?? conversationIdForNoSession.current;
    if (!targetKey) return;
    let conversationId: string | null = null;
    for (const [convId, streamKey] of activeStreamsRef.current) {
      if (streamKey === targetKey) {
        conversationId = convId;
        break;
      }
    }
    if (!conversationId) return;
    console.debug("[useChat] aborting conversation %s (key=%s)", conversationId, targetKey);
    try {
      await api.abortChat(conversationId);
    } catch (err) {
      console.warn("[useChat] abort request failed", err);
    }
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setChatErrorCode(null);
    setChatRuntimeLimitSnapshot(null);
  }, []);

  const newSession = useCallback(() => {
    setMessages([]);
    currentSessionIdRef.current = null;
    setChatErrorCode(null);
    setChatRuntimeLimitSnapshot(null);
  }, []);

  return {
    messages,
    isStreaming,
    isLoadingMessages,
    chatErrorCode,
    chatRuntimeLimitSnapshot,
    explore,
    setExplore,
    sendMessage,
    abortStream,
    clearMessages,
    newSession,
  };
}
