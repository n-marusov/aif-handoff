import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger, toTaskResponse } from "@aif/shared";
import { updateTaskManaged } from "@aif/data";
import { registerMcpTool, type ToolContext } from "./index.js";
import { rateLimitError, toMcpError, validationError } from "../middleware/errorHandler.js";
import { compactTaskResponse } from "../utils/compactResponse.js";
import { broadcastTaskChange } from "../utils/broadcast.js";
import { buildEffectiveTaskRuntimeMetadata } from "./runtimeTaskMetadata.js";

const log = logger("mcp:tool:update-task");
const updateTaskInputSchema: Record<string, z.ZodTypeAny> = {
  taskId: z.string().uuid().describe("Task ID to update (must exist)"),
  title: z.string().max(500).optional().describe("Updated task title"),
  description: z.string().optional().describe("Updated task description"),
  priority: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe("Priority level (0=none, 1=low, 2=medium, 3=high)"),
  tags: z.array(z.string()).optional().describe("Updated tags"),
  plan: z.string().nullable().optional().describe("Plan content (null to clear)"),
  autoMode: z.boolean().optional().describe("Enable/disable auto mode"),
  isFix: z.boolean().optional().describe("Mark/unmark as fix"),
  plannerMode: z.enum(["fast", "full"]).optional().describe("Planner mode"),
  planDocs: z.boolean().optional().describe("Include documentation in plan"),
  planTests: z.boolean().optional().describe("Include tests in plan"),
  skipReview: z.boolean().optional().describe("Skip review stage"),
  useSubagents: z.boolean().optional().describe("Use subagents for implementation"),
  maxReviewIterations: z.number().int().min(1).optional().describe("Maximum review iterations"),
  paused: z.boolean().optional().describe("Pause/unpause task"),
  implementationLog: z.string().nullable().optional().describe("Implementation log content"),
  reviewComments: z.string().nullable().optional().describe("Review comments content"),
  roadmapAlias: z.string().nullable().optional().describe("Roadmap milestone alias"),
  blockedReason: z.string().nullable().optional().describe("Reason the task is blocked"),
  runtimeProfileId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Optional runtime profile override (must be project-scoped or global)"),
  modelOverride: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Optional model override for task execution"),
  runtimeOptions: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("Optional runtime-specific options for task execution"),
};

type UpdateTaskArgs = {
  autoMode?: boolean;
  blockedReason?: string | null;
  description?: string;
  implementationLog?: string | null;
  isFix?: boolean;
  maxReviewIterations?: number;
  modelOverride?: string | null;
  paused?: boolean;
  plan?: string | null;
  planDocs?: boolean;
  plannerMode?: "fast" | "full";
  planTests?: boolean;
  priority?: number;
  reviewComments?: string | null;
  roadmapAlias?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  runtimeProfileId?: string | null;
  skipReview?: boolean;
  tags?: string[];
  taskId: string;
  title?: string;
  useSubagents?: boolean;
};

export function register(server: McpServer, context: ToolContext): void {
  registerMcpTool(
    server,
    "handoff_update_task",
    "Update an existing task's fields (title, description, status, plan, etc.)",
    updateTaskInputSchema,
    async (rawArgs) => {
      const args = rawArgs as UpdateTaskArgs;
      try {
        if (!context.rateLimiter.check("handoff_update_task", "write")) {
          throw rateLimitError("handoff_update_task");
        }

        log.debug(
          {
            taskId: args.taskId,
            runtimeProfileId: args.runtimeProfileId ?? null,
            modelOverride: args.modelOverride ?? null,
            hasRuntimeOptions: args.runtimeOptions !== undefined,
          },
          "DEBUG [mcp:tool:*] handoff_update_task called with runtime metadata",
        );

        // Извлекает taskId, остальные поля передаёт в общий контракт.
        const { taskId, ...fields } = args;

        // Общий контракт сам отклоняет поля владения/жизненного цикла и
        // валидирует runtime-профиль — локальных проверок больше нет.
        const result = updateTaskManaged({
          taskId,
          patch: fields as Record<string, unknown>,
          plannerMode: args.plannerMode,
          useSubagents: args.useSubagents,
          skipReview: args.skipReview,
          planDocs: args.planDocs,
          planTests: args.planTests,
        });

        if (!result.ok) {
          if (result.code === "forbidden_fields") {
            log.warn({ taskId }, "Rejected ownership fields in generic MCP task update");
            throw validationError("Task ownership cannot be changed through handoff_update_task", {
              ownership: ["Use the authenticated Handoff API for ownership changes"],
            });
          }
          if (result.code === "invalid_runtime_profile") {
            const fieldErrors = result.validation?.fieldErrors ?? {};
            log.warn(
              { taskId, runtimeProfileId: args.runtimeProfileId ?? null },
              "Rejected invalid runtime profile in MCP task update",
            );
            throw validationError("Invalid runtime profile selection", fieldErrors);
          }
          if (result.code === "parallel_mode_required") {
            throw validationError(result.error, {
              plannerMode: [result.error],
            });
          }
          log.error({ taskId, code: result.code }, "MCP task update rejected");
          throw validationError(`Task not found: ${taskId}`, {
            taskId: ["Task does not exist"],
          });
        }

        const row = result.task;
        // Готовит сводку изменённых полей для логирования
        const changedFields = Object.keys(fields).filter(
          (key) => fields[key as keyof typeof fields] !== undefined,
        );

        const full = toTaskResponse(row);
        const effectiveRuntime = buildEffectiveTaskRuntimeMetadata(full.id, full.projectId);
        const compact = compactTaskResponse({ ...full, effectiveRuntime });

        log.debug(
          {
            taskId,
            effectiveRuntimeSource: effectiveRuntime.source,
            effectiveRuntimeProfileId: effectiveRuntime.profileId,
          },
          "DEBUG [mcp:tool:*] Returning compact task response with effective runtime metadata",
        );

        log.info(
          {
            taskId,
            changedFields,
            runtimeProfileId: args.runtimeProfileId ?? null,
            modelOverride: args.modelOverride ?? null,
          },
          "handoff_update_task completed",
        );

        void broadcastTaskChange(taskId);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(compact) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
