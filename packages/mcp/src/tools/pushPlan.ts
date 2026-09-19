import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger, parsePlanAnnotations, toTaskResponse } from "@aif/shared";
import { findTaskById, setTaskPlanContentManaged } from "@aif/data";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError, validationError } from "../middleware/errorHandler.js";
import { compactTaskResponse } from "../utils/compactResponse.js";
import { broadcastTaskChange } from "../utils/broadcast.js";

const log = logger("mcp:tool:push-plan");
const pushPlanInputSchema: Record<string, z.ZodTypeAny> = {
  taskId: z.string().uuid().describe("Task ID to push plan to"),
  planContent: z.string().max(100_000).describe("Plan content in markdown (max 100KB)"),
};

type PushPlanArgs = {
  planContent: string;
  taskId: string;
};

export function register(server: McpServer, context: ToolContext): void {
  registerMcpTool(
    server,
    "handoff_push_plan",
    "Push plan content to a task's plan field with annotation preservation",
    pushPlanInputSchema,
    async (rawArgs) => {
      const args = rawArgs as PushPlanArgs;
      try {
        if (!context.rateLimiter.check("handoff_push_plan", "write")) {
          throw rateLimitError("handoff_push_plan");
        }

        log.debug(
          { taskId: args.taskId, planSize: args.planContent.length },
          "handoff_push_plan called",
        );

        const row = findTaskById(args.taskId);
        if (!row) {
          throw validationError(`Task not found: ${args.taskId}`, {
            taskId: ["Task does not exist"],
          });
        }

        // Разбирает аннотации из входящего плана
        const annotations = parsePlanAnnotations(args.planContent);
        log.debug(
          { taskId: args.taskId, annotationCount: annotations.length },
          "Parsed annotations",
        );

        // Проверяет, что упомянутые идентификаторы задач существуют
        const annotationResults = annotations.map((ann) => {
          const referencedTask = findTaskById(ann.taskId);
          if (!referencedTask) {
            log.warn(
              { taskId: args.taskId, referencedTaskId: ann.taskId, line: ann.line },
              "Plan references non-existent task",
            );
          }
          return {
            taskId: ann.taskId,
            line: ann.line,
            valid: !!referencedTask,
          };
        });

        // Обновляет поле плана задачи через общий контракт
        const planResult = setTaskPlanContentManaged(args.taskId, args.planContent);
        if (!planResult.ok) {
          throw validationError(`Task not found: ${args.taskId}`, {
            taskId: ["Task does not exist"],
          });
        }
        const updatedRow = planResult.task;
        const task = updatedRow ? toTaskResponse(updatedRow) : toTaskResponse(row);

        log.info(
          {
            taskId: args.taskId,
            planSize: args.planContent.length,
            annotationCount: annotations.length,
          },
          "handoff_push_plan completed",
        );

        void broadcastTaskChange(args.taskId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                task: compactTaskResponse(task),
                annotations: annotationResults,
              }),
            },
          ],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
