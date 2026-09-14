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
const writeArgs = z.object({
  path: z.string().min(1, "path is required and must be a non-empty string"),
  content: z.string(),
});

export const WORKSPACE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace. The file must already exist.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path to the file" } },
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
        properties: { path: { type: "string", description: "Relative path to the directory" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or overwrite an existing file with the given content. " +
        "Use this to create files that do not yet exist. " +
        "Parent directories are created automatically if missing. " +
        "For existing files, prefer apply_patch to preserve other content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file to create or overwrite",
          },
          content: {
            type: "string",
            description: "Full content to write to the file",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Replace one exact unique text fragment in an existing workspace file. " +
        "Use this to modify files that already exist. " +
        "For new files, use write_file instead.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file to patch" },
          oldText: {
            type: "string",
            description: "Exact unique text fragment to replace",
          },
          newText: {
            type: "string",
            description: "Replacement text",
          },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Convert a caught error into a clear, model-friendly message string.
 * ZodError produces dense JSON that language models struggle to parse;
 * this converts validation failures into plain instructions.
 */
function formatToolError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const lines = error.issues.map((issue) => {
      const asKeyPath = issue.path.map((p) => String(p));
      const fieldPath = asKeyPath.length > 0 ? asKeyPath.join(".") : "arguments";
      const reason = issue.message;
      // Provide actionable hints for the most common schema violations
      const hint = schemaErrorHint(asKeyPath, issue.code, issue);
      return `  - ${fieldPath}: ${reason}.${hint ? ` ${hint}` : ""}`;
    });
    return `Validation error — the tool arguments did not match the expected format:\n${lines.join("\n")}`;
  }
  if (error instanceof RuntimeValidationError) {
    return error.message;
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("enoent") || lower.includes("no such file") || lower.includes("not found")) {
      return `${error.message}. This usually means the file does not exist yet — use write_file to create new files.`;
    }
    return error.message;
  }
  return String(error);
}

function schemaErrorHint(path: (string | number)[], code: string, issue: z.ZodIssue): string {
  if (code === "too_small" && "minimum" in issue && issue.minimum === 1) {
    return `This field cannot be empty. Provide a value with at least 1 character.`;
  }
  if (code === "invalid_type") {
    const invalidIssue = issue as z.ZodIssue & { expected: string; received: string };
    return `Expected a ${invalidIssue.expected} value, but received ${invalidIssue.received}.`;
  }
  if (code === "unrecognized_keys" && "keys" in issue) {
    return `Remove the unknown keys: ${(issue as z.ZodIssue & { keys: string[] }).keys.join(", ")}.`;
  }
  return "";
}

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
        case "write_file": {
          const { path: rawPath, content } = writeArgs.parse(args);
          const absolute = this.safe(rawPath);
          const parentDir = path.dirname(absolute);
          await fs.mkdir(parentDir, { recursive: true });
          await fs.writeFile(absolute, content, "utf8");
          result = `Written ${content.length} characters to ${rawPath}`;
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
      // Convert to a model-friendly error string instead of rethrowing the
      // raw exception. The caller (subagentQuery.ts tool loop) catches this
      // with `.catch((error) => "ERROR: ...")` and feeds it back to the
      // model.  Raw ZodError JSON confuses models; formatToolError produces
      // clear instructions the model can act on.
      throw new RuntimeValidationError(formatToolError(error));
    }
  }
}
