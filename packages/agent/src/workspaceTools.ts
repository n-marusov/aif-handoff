import { execFileSync } from "node:child_process";
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
const MAX_SHELL_OUTPUT_BYTES = 50_000;
const DENIED_TOP_LEVEL = new Set([".git", "node_modules", ".env", ".llm-backup"]);

/** Shell command patterns that are never allowed. */
const SHELL_DENIED_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\b/i,
  /\bmv\s+\S+\s+\S+\.git\b/i,
  /\bgpush\b/,
  /\bgp\s*--force\b/,
  /\bgit\s+push\b/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+clone\b/i,
  /\bgit\s+remote\b/i,
  /\bgit\s+fetch\b/i,
  /\bgit\s+merge\b/i,
  /\bgit\s+tag\b/i,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
];

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

/**
 * Allowed git subcommands for the shell_exec tool.
 * Everything else is executed as a generic shell command.
 */
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
  {
    type: "function",
    function: {
      name: "shell_exec",
      description:
        "Execute a shell command in the workspace root. " +
        "The command runs in a shell (sh) and inherits the workspace environment. " +
        "Use this to run git commands, tests, linters, and other CLI tools. " +
        "Output is limited to 50 KB. " +
        "WARNING: certain destructive commands (rm -rf on non-standard paths, " +
        "git push, git rebase, git reset --hard, sudo, etc.) are blocked.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute, e.g. 'git status' or 'go test ./...'",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

function isDeniedCommand(command: string): boolean {
  return SHELL_DENIED_PATTERNS.some((pattern) => pattern.test(command));
}

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
            throw new RuntimeValidationError(
              "oldText was not found in the file; read the file again and verify the text is present",
            );
          if (second >= 0)
            throw new RuntimeValidationError(
              "oldText matches more than one occurrence; provide a more specific fragment",
            );
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
        case "shell_exec": {
          const { command } = z.object({ command: z.string().min(1) }).parse(args);
          if (isDeniedCommand(command)) {
            throw new RuntimeValidationError(
              "Command contains a denied pattern. Destructive operations (git push, git rebase, git reset --hard, sudo, rm -rf on non-standard paths, etc.) are not allowed.",
            );
          }
          const callResult = execFileSync("sh", ["-c", command], {
            cwd: this.root,
            encoding: "utf8",
            stdio: "pipe",
            maxBuffer: MAX_SHELL_OUTPUT_BYTES,
          });
          result = callResult.toString().trim();
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
      throw new RuntimeValidationError(formatToolError(error));
    }
  }
}
