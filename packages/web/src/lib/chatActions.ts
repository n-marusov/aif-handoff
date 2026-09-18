import type { ChatAction, ChatActionCreateTask } from "@aif/shared/browser";

const ACTION_REGEX = /<!--ACTION:CREATE_TASK-->\s*(\{[\s\S]*?\})\s*<!--\/ACTION-->/g;

export interface ParsedMessage {
  /** Текст сообщения без блоков действий */
  text: string;
  actions: ChatAction[];
}

export function parseChatActions(content: string): ParsedMessage {
  const actions: ChatAction[] = [];
  const text = content.replace(ACTION_REGEX, (_match, json: string) => {
    try {
      const parsed = JSON.parse(json) as {
        title?: string;
        description?: string;
        isFix?: boolean;
      };
      if (parsed.title) {
        const action: ChatActionCreateTask = {
          type: "create_task",
          title: String(parsed.title).slice(0, 500),
          description: String(parsed.description ?? "").slice(0, 10_000),
          ...(parsed.isFix ? { isFix: true } : {}),
        };
        actions.push(action);
      }
    } catch {
      // Некорректный JSON — пропускаем
    }
    return "";
  });

  return { text: text.trim(), actions };
}
