import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  RuntimeValidationError,
  type RuntimeToolCall,
  type RuntimeToolDefinition,
} from "@aif/runtime";
import { logger } from "@aif/shared";

const log = logger("workspace-tools");
const MAX_READ_BYTES = 200_000;
const DENIED_TOP_LEVEL = new Set([".git", "node_modules", ".env", ".llm-backup"]);

const readArgs = z.object({ path: z.string().min(1) });
const listArgs = z.object({ path: z.string().min(1) });
const patchArgs = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
});

export const WORKSPACE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List a workspace directory without recursion.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Replace one unique exact text fragment in a workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
];

export class WorkspaceToolExecutor {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private safe(rawPath: string): string {
    if (path.isAbsolute(rawPath))
      throw new RuntimeValidationError("Workspace tool paths must be relative");
    const absolute = path.resolve(this.root, rawPath);
    const relative = path.relative(this.root, absolute);
    const top = relative.split(path.sep)[0];
    if (relative.startsWith("..") || path.isAbsolute(relative) || DENIED_TOP_LEVEL.has(top)) {
      throw new RuntimeValidationError("Workspace tool path is outside the allowed project scope");
    }
    return absolute;
  }

  async execute(call: RuntimeToolCall): Promise<string> {
    log.info(
      { toolName: call.function.name, callId: call.id },
      "[FIX] Executing local workspace tool",
    );
    try {
      const args: unknown = JSON.parse(call.function.arguments || "{}");
      let result: string;
      switch (call.function.name) {
        case "read_file": {
          const { path: rawPath } = readArgs.parse(args);
          const absolute = this.safe(rawPath);
          const stat = await fs.stat(absolute);
          if (stat.size > MAX_READ_BYTES)
            throw new RuntimeValidationError(`File exceeds ${MAX_READ_BYTES} bytes`);
          result = await fs.readFile(absolute, "utf8");
          break;
        }
        case "list_dir": {
          const { path: rawPath } = listArgs.parse(args);
          const entries = await fs.readdir(this.safe(rawPath), { withFileTypes: true });
          result = entries
            .filter((entry) => !DENIED_TOP_LEVEL.has(entry.name))
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort()
            .join("\n");
          break;
        }
        case "apply_patch": {
          const { path: rawPath, oldText, newText } = patchArgs.parse(args);
          const absolute = this.safe(rawPath);
          const source = await fs.readFile(absolute, "utf8");
          const first = source.indexOf(oldText);
          const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
          if (first < 0)
            throw new RuntimeValidationError("oldText was not found; read the file again");
          if (second >= 0)
            throw new RuntimeValidationError("oldText must match exactly one occurrence");
          const backupDir = path.join(this.root, ".llm-backup", path.dirname(rawPath));
          await fs.mkdir(backupDir, { recursive: true });
          await fs
            .copyFile(absolute, path.join(backupDir, path.basename(rawPath)))
            .catch(() => undefined);
          const updated = source.slice(0, first) + newText + source.slice(first + oldText.length);
          await fs.writeFile(absolute, updated, "utf8");
          result = `Applied patch to ${rawPath}`;
          break;
        }
        default:
          throw new RuntimeValidationError(`Unknown workspace tool: ${call.function.name}`);
      }
      log.info(
        { toolName: call.function.name, callId: call.id },
        "[FIX] Local workspace tool succeeded",
      );
      return result;
    } catch (error) {
      log.error(
        {
          toolName: call.function.name,
          callId: call.id,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        "[FIX] Local workspace tool failed",
      );
      throw error;
    }
  }
}
