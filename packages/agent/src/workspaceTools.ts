/**
 * Инструменты рабочего пространства для субагентов.
 *
 * Зачем: субагент (planner, implementer, reviewer) работает не в процессе агента,
 * а через runtime-адаптер, поэтому ему нужен собственный узкий набор файловых
 * операций с понятным контрактом. Все они ограничены корнем рабочего дерева.
 *
 * Почему именно так:
 * - определения инструментов (WORKSPACE_TOOL_DEFINITIONS) описаны в формате
 *   OpenAI function calling: адаптеры отдают их модели дословно, поэтому схемы
 *   параметров строгие (additionalProperties: false).
 * - каждый путь проходит через safe(): абсолютные пути и выход за корень
 *   отбрасываются. Ограничение реализовано проверкой кода, а не доверием к
 *   промпту, потому что модель легко "уходит" туда, куда ей не нужно.
 * - shell_exec - единственный неструктурированный канал, поэтому он фильтруется
 *   черным списком регулярок и ограничивается по размеру вывода. Это защита от
 *   случайной разрушительной команды, а не полноценная песочница: regexp как
 *   граница безопасности ненадежен.
 * - ошибки возвращаются модели текстом (formatToolError), а не стектрейсом:
 *   ZodError - это плотный JSON, который модели разбирают плохо, поэтому
 *   валидационные сбои переписываются в короткие инструкции.
 */

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
// Лимит на чтение защищает контекст модели: гигантский файл вытеснил бы из окна
// саму задачу, над которой работает субагент.
const MAX_READ_BYTES = 200_000;
// Одновременно и предел maxBuffer для execFileSync, и лимит того, что вообще
// попадет в результат инструмента: вывод тестов или сборки бывает огромным.
const MAX_SHELL_OUTPUT_BYTES = 50_000;
// Имена, закрытые и на чтение, и на листинг. .git опасен тем, что через него
// настраиваются хуки и конфиг, то есть обходятся любые другие ограничения;
// .env содержит секреты, а node_modules - не исходники проекта.
const DENIED_TOP_LEVEL = new Set([".git", "node_modules", ".env", ".llm-backup"]);

// Черный список - эвристика, а не граница безопасности: его легко обойти
// кавычками, переменными окружения или алиасами. Его задача - не дать модели
// случайно выполнить разрушительное действие, а не остановить злоумышленника.
/** Паттерны shell-команд, запрещённые всегда. */
const SHELL_DENIED_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\b/i,
  /\bmv\s+\S+\s+\S+\.git\b/i,
  // gpush часто объявлен как алиас "git push --force": ловим и его.
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

// Схемы аргументов применяются на исполнении, поэтому невалидный вызов не
// доходит до файловой системы. min(1) отсекает пустую строку, которая после
// resolve превратилась бы в корень рабочего дерева.
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
 * Разрешённые подкоманды git для инструмента shell_exec.
 * Всё остальное исполняется как обычная shell-команда.
 */
export const WORKSPACE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  // Формат совпадает с OpenAI function calling, поэтому адаптеры передают его
  // модели без перевода. Флаг additionalProperties: false обязателен: без него
  // модель начинает придумывать поля, которых инструмент не понимает.
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
      // write_file и apply_patch разделены намеренно: перезапись целого файла
      // (создание) и точечная правка требуют разных гарантий, а тексты описаний
      // прямо подсказывают модели, какой из двух инструментов выбрать.
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
      // shell_exec - самый мощный и самый рискованный инструмент: он запускает
      // произвольный sh-код, поэтому в описании явно перечислены запреты.
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

// Проверка идет по регулярным выражениям с флагом i, поэтому регистр команд не
// важен, а some() останавливается на первом совпадении.
function isDeniedCommand(command: string): boolean {
  return SHELL_DENIED_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Преобразует пойманную ошибку в ясную, понятную модели строку сообщения.
 * ZodError выдаёт плотный JSON, который языковым моделям тяжело разбирать;
 * здесь сбои валидации превращаются в простые инструкции.
 */
// Порядок проверок важен: ZodError наследуется от Error, поэтому ветка с Error
// перехватила бы его первой, если поставить ее выше.
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
  // Своя ошибка валидации уже содержит текст для модели, поэтому отдается как есть.
  if (error instanceof RuntimeValidationError) {
    return error.message;
  }
  if (error instanceof Error) {
    // Подсказка про write_file снимает типовую путаницу: модель пытается читать
    // файл, которого еще нет, вместо того чтобы его создать.
    const lower = error.message.toLowerCase();
    if (lower.includes("enoent") || lower.includes("no such file") || lower.includes("not found")) {
      return `${error.message}. This usually means the file does not exist yet — use write_file to create new files.`;
    }
    return error.message;
  }
  return String(error);
}

// Перевод кодов zod в короткие подсказки. Неизвестный код возвращает пустую
// строку, чтобы вызывающий код мог склеивать подсказку без дополнительных проверок.
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

// Один экземпляр на рабочее дерево. Класс, а не набор функций, потому что корень
// (и вытекающие из него проверки пути) нужно зафиксировать один раз.
export class WorkspaceToolExecutor {
  private readonly root: string;

  // resolve приводит путь к абсолютному и нормализует "..", поэтому все
  // последующие сравнения идут между сопоставимыми значениями.
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  // Единственная точка проверки путей. Алгоритм: абсолютный путь запрещен
  // сразу, остальное разрешается от корня, после чего relative() показывает,
  // остались ли мы внутри. Выход наверх дает ".." в начале результата, а
  // служебные каталоги отсекает отдельный черный список.
  private safe(rawPath: string): string {
    if (path.isAbsolute(rawPath))
      throw new RuntimeValidationError("Workspace tool paths must be relative");
    const absolute = path.resolve(this.root, rawPath);
    const relative = path.relative(this.root, absolute);
    // Проверяются все три условия сразу: префикс ".." (выход наружу),
    // абсолютный результат (на Windows это признак другого диска) и служебное
    // имя первого сегмента пути.
    const top = relative.split(path.sep)[0];
    if (relative.startsWith("..") || path.isAbsolute(relative) || DENIED_TOP_LEVEL.has(top)) {
      throw new RuntimeValidationError("Workspace tool path is outside the allowed project scope");
    }
    return absolute;
  }

  // Единая точка входа: разбор аргументов, диспетчеризация по имени, логирование
  // и приведение любой ошибки к RuntimeValidationError.
  async execute(call: RuntimeToolCall): Promise<string> {
    log.info({ toolName: call.function.name, callId: call.id }, "Executing local workspace tool");
    try {
      // Аргументы приходят строкой JSON. Пустая строка трактуется как пустой
      // объект: некоторые модели так вызывают инструмент без параметров.
      const args: unknown = JSON.parse(call.function.arguments || "{}");
      let result: string;
      // Явный switch вместо таблицы обработчиков: так виден весь список
      // инструментов, а неизвестное имя уходит в default с ошибкой.
      switch (call.function.name) {
        // Размер проверяется до чтения: иначе большой файл уже оказался бы в памяти.
        case "read_file": {
          const { path: rawPath } = readArgs.parse(args);
          const absolute = this.safe(rawPath);
          const stat = await fs.stat(absolute);
          if (stat.size > MAX_READ_BYTES)
            throw new RuntimeValidationError(`File exceeds ${MAX_READ_BYTES} bytes`);
          result = await fs.readFile(absolute, "utf8");
          break;
        }
        // Суффикс "/" у каталогов и сортировка дают модели стабильную картину
        // дерева, а служебные имена скрываются тем же черным списком.
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
        // Родительские каталоги создаются сами: это снимает с модели лишний шаг,
        // который она регулярно забывала делать.
        case "write_file": {
          const { path: rawPath, content } = writeArgs.parse(args);
          const absolute = this.safe(rawPath);
          const parentDir = path.dirname(absolute);
          await fs.mkdir(parentDir, { recursive: true });
          await fs.writeFile(absolute, content, "utf8");
          result = `Written ${content.length} characters to ${rawPath}`;
          break;
        }
        // Патч задается точным фрагментом текста, а не diff-форматом: модели
        // проще скопировать существующий код. Требование уникальности (first и
        // second) защищает от правки не того места, если фрагмент встречается дважды.
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
          // Копия оригинала кладется в .llm-backup перед перезаписью. Ошибка
          // копирования игнорируется: отсутствие бэкапа не должно мешать
          // основной операции.
          const backupDir = path.join(this.root, ".llm-backup", path.dirname(rawPath));
          await fs.mkdir(backupDir, { recursive: true });
          await fs
            .copyFile(absolute, path.join(backupDir, path.basename(rawPath)))
            .catch(() => undefined);
          // Склейка по индексам, без регулярных выражений, поэтому спецсимволы
          // в oldText и newText не требуют экранирования.
          const updated = source.slice(0, first) + newText + source.slice(first + oldText.length);
          await fs.writeFile(absolute, updated, "utf8");
          result = `Applied patch to ${rawPath}`;
          break;
        }
        // Команда исполняется через "sh -c", то есть с полным shell-синтаксисом.
        // Проверка isDeniedCommand выполняется до запуска и служит грубым
        // фильтром, а не заменой песочнице.
        case "shell_exec": {
          const { command } = z.object({ command: z.string().min(1) }).parse(args);
          if (isDeniedCommand(command)) {
            throw new RuntimeValidationError(
              "Command contains a denied pattern. Destructive operations (git push, git rebase, git reset --hard, sudo, rm -rf on non-standard paths, etc.) are not allowed.",
            );
          }
          // maxBuffer - жесткий предел: при его превышении execFileSync бросает
          // исключение, то есть вывод не разрастется до размера памяти.
          try {
            const callResult = execFileSync("sh", ["-c", command], {
              cwd: this.root,
              encoding: "utf8",
              stdio: "pipe",
              maxBuffer: MAX_SHELL_OUTPUT_BYTES,
            });
            result = callResult.toString().trim();
          } catch (execErr) {
            const err = execErr as {
              status?: number;
              stdout?: Buffer | string;
              stderr?: Buffer | string;
              message?: string;
            };
            // Для execFileSync ненулевой код выхода - это исключение, поэтому мы
            // разбираем его в структурированный текст вместо повторного throw.
            const exitCode = typeof err.status === "number" ? err.status : 1;
            const stdout = err.stdout ? err.stdout.toString().trim() : "";
            const stderr = err.stderr ? err.stderr.toString().trim() : (err.message ?? "");
            // Возвращаем структурированную ошибку как обычный результат инструмента,
            // чтобы модель осмотрела exit code, stdout и stderr и решила —
            // это настоящий сбой (например, упало утверждение теста, exit 1)
            // или проблема окружения (например, нет тулчейна, exit 127).
            result = [
              `Exit code: ${exitCode}`,
              stdout
                ? `Stdout:
${stdout}`
                : "",
              stderr
                ? `Stderr:
${stderr}`
                : "",
            ]
              .filter(Boolean)
              .join("\n");
          }
          break;
        }
        // Неизвестное имя инструмента - ошибка контракта, а не тихий no-op:
        // модель должна узнать, что вызвала несуществующую функцию.
        default:
          throw new RuntimeValidationError(`Unknown workspace tool: ${call.function.name}`);
      }
      log.info({ toolName: call.function.name, callId: call.id }, "Local workspace tool succeeded");
      return result;
    } catch (error) {
      log.error(
        {
          toolName: call.function.name,
          callId: call.id,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        "Local workspace tool failed",
      );
      // Наружу всегда уходит RuntimeValidationError с текстом для модели:
      // адаптер покажет это сообщение в ответе, а не сырой стектрейс.
      throw new RuntimeValidationError(formatToolError(error));
    }
  }
}
