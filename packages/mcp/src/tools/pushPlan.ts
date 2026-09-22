import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger, parsePlanAnnotations, toTaskResponse } from "@aif/shared";
import { findTaskById, persistTaskPlanForTask, setTaskPlanContentManaged } from "@aif/data";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError, validationError } from "../middleware/errorHandler.js";
import { compactTaskResponse } from "../utils/compactResponse.js";
import { broadcastTaskChange } from "../utils/broadcast.js";

const log = logger("mcp:tool:push-plan");
const pushPlanInputSchema: Record<string, z.ZodTypeAny> = {
  taskId: z.string().uuid().describe("Task ID to push plan to"),
  planContent: z.string().max(100_000).describe("Plan content in markdown (max 100KB)"),
  persistTarget: z
    .enum(["field", "canonical_file"])
    .optional()
    .describe("Persistence target: task field only (default) or canonical plan file + field"),
};

type PushPlanArgs = {
  planContent: string;
  persistTarget?: "field" | "canonical_file";
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

        const persistTarget = args.persistTarget ?? "field";

        let task = toTaskResponse(row);
        if (persistTarget === "canonical_file") {
          persistTaskPlanForTask({ taskId: args.taskId, planText: args.planContent });
          const updatedRow = findTaskById(args.taskId);
          task = updatedRow ? toTaskResponse(updatedRow) : task;
        } else {
          const planResult = setTaskPlanContentManaged(args.taskId, args.planContent);
          if (!planResult.ok) {
            throw validationError(`Task not found: ${args.taskId}`, {
              taskId: ["Task does not exist"],
            });
          }
          task = planResult.task ? toTaskResponse(planResult.task) : task;
        }

        log.info(
          {
            taskId: args.taskId,
            planSize: args.planContent.length,
            annotationCount: annotations.length,
            persistTarget,
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
