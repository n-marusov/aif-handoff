/**
 * Генерация дорожной карты проекта и импорт задач из нее.
 *
 * Процесс сознательно разбит на два независимых прохода:
 * 1) `generateRoadmapFile` просит рантайм написать ROADMAP.md — свободный текст, который
 *    человек может прочитать и отредактировать руками.
 * 2) `generateRoadmapTasks` читает уже готовый файл и просит рантайм превратить его в
 *    строгий JSON, из которого затем создаются задачи в бэклоге.
 *
 * Почему не одним вызовом: между проходами файл становится источником правды. Пользователь
 * может поправить формулировки или снять галочку с майлстоуна, и повторный импорт подхватит
 * именно правленый текст. Если бы JSON генерировался напрямую из DESCRIPTION.md, точки
 * контроля у человека не было бы вовсе.
 *
 * Ключевые инварианты:
 * - Ни один ответ агента не считается доверенным. Сначала снимаются markdown-фенсы и
 *   прозаический префикс (`extractRoadmapContent`, `extractJsonObject`), затем результат
 *   проходит zod-валидацию (`roadmapResponseSchema`), и только потом попадает в базу.
 *   Ошибка модели не должна оставлять мусор в бэклоге.
 * - Алиас всегда берется из входных данных, а не из ответа модели: от него зависит
 *   дедупликация следующего импорта, поэтому он не может зависеть от генерации.
 * - Импорт идемпотентен по (projectId, нормализованный заголовок, alias). Повторный запуск
 *   на том же файле до-создает только новые задачи.
 * - Каждой задаче выдается уникальный planPath. Импорт обходит POST /tasks, поэтому
 *   проверки уникальности, которые есть там, воспроизводятся здесь вручную.
 *
 * Ловушки:
 * - Позиция считается вниз от текущего минимума бэклога, а не от нуля: импорт — осознанный
 *   путь "в начало очереди", и он не должен конфликтовать с обычным созданием задач,
 *   которое дописывает в хвост.
 * - Агент в CLI-режиме может записать файл сам, инструментами. Поэтому перед записью
 *   содержимого из outputText проверяется, не появился ли на диске осмысленный ROADMAP.md.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { logger, getEnv, getProjectConfig, generatePlanPath, defaultsForMode } from "@aif/shared";
import {
  createTask,
  findProjectById,
  findTasksByRoadmapAlias,
  getMinBacklogPosition,
  listTasks,
} from "@aif/data";
import { UsageSource } from "@aif/runtime";
import { resolveApiLightModel, runApiRuntimeOneShot } from "./runtime.js";

const log = logger("roadmap-generation");

// -- Zod-схемы для валидации ответа агента --

// Границы длин и min(1) на phase/sequence стоят здесь не для красоты: модель регулярно
// отвечает пустым заголовком, нулевой фазой или отрицательной последовательностью, и без
// валидации такие задачи уехали бы в базу и сломали сортировку импорта.
const generatedTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().default(""),
  phase: z.number().int().min(1),
  phaseName: z.string().default(""),
  sequence: z.number().int().min(1),
});

// min(1) на tasks — это ранний отказ: пустая дорожная карта означает, что модель не
// поняла вход, и об этом надо сообщить пользователю, а не молча создать ноль задач.
const roadmapResponseSchema = z.object({
  alias: z.string().min(1).max(200),
  tasks: z.array(generatedTaskSchema).min(1),
});

export type GeneratedTask = z.infer<typeof generatedTaskSchema>;
export type RoadmapResponse = z.infer<typeof roadmapResponseSchema>;

export interface RoadmapGenerationInput {
  projectId: string;
  roadmapAlias: string;
  /**
   * Необязательный id задачи-инициатора. Когда генерация запущена из очереди задач,
   * расход токенов приписывается именно этой задаче; при ручном запуске из веб-интерфейса
   * атрибуции нет, и это допустимый случай.
   */
  /** Необязательный id задачи для учёта расхода токенов */
  trackingTaskId?: string;
}

export interface RoadmapGenerationResult {
  alias: string;
  tasks: GeneratedTask[];
}

// Исходный индекс нужен как последний критерий сортировки: у задач из одной фазы может
// совпасть sequence, и без стабильного тайбрейкера порядок импорта плавал бы между
// запусками на одном и том же ответе модели.
type IndexedGeneratedTask = {
  task: GeneratedTask;
  index: number;
};

export interface GenerateRoadmapFileInput {
  projectId: string;
  /** Необязательное пользовательское видение/требования, направляющие генерацию */
  vision?: string;
}

export interface GenerateRoadmapFileResult {
  roadmapPath: string;
  content: string;
}

/**
 * Генерирует файл ROADMAP.md для проекта через Agent SDK.
 * Читает DESCRIPTION.md и ARCHITECTURE.md для контекста, затем создаёт
 * стратегическую карту вех.
 */
// Снятие фенса обязательно: даже при явном запрете в системном промпте модель иногда
// оборачивает весь документ в ```markdown, и тогда заголовки перестали бы распознаваться
// проверкой на "##" ниже. Регексп ленивый, поэтому берется первый блок, а не до последнего
// фенса в ответе — после него модель любит дописывать пояснения.
/** Извлекает содержимое карты из outputText агента, убирая markdown-ограждения, если они есть. */
function extractRoadmapContent(raw: string): string {
  const fenceMatch = raw.match(/```(?:markdown)?\s*\n([\s\S]*?)\n\s*```/);
  return fenceMatch ? fenceMatch[1].trim() : raw.trim();
}

export async function generateRoadmapFile(
  input: GenerateRoadmapFileInput,
): Promise<GenerateRoadmapFileResult> {
  const { projectId, vision } = input;

  log.info({ projectId }, "Starting roadmap file generation");

  const project = findProjectById(projectId);
  if (!project) {
    throw new RoadmapGenerationError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }

  // Контекст читается с диска, а не из базы: DESCRIPTION.md и ARCHITECTURE.md правит
  // руками человек, и на карту должна влиять именно их текущая версия. Отсутствие файла —
  // нормальный случай, обрабатываемый ниже через null.
  // Чтение контекста проекта
  const projectCfg = getProjectConfig(project.rootPath);
  const descriptionPath = join(project.rootPath, projectCfg.paths.description);
  const architecturePath = join(project.rootPath, projectCfg.paths.architecture);

  const description = existsSync(descriptionPath) ? readFileSync(descriptionPath, "utf8") : null;
  const architecture = existsSync(architecturePath) ? readFileSync(architecturePath, "utf8") : null;

  // Без описания и без видения генерировать нечего: модель начнет выдумывать проект
  // с нуля, и такой результат дороже отклонить, чем не создавать его вовсе.
  if (!description && !vision) {
    throw new RoadmapGenerationError(
      "NO_CONTEXT",
      "No DESCRIPTION.md found and no vision provided. Cannot generate roadmap without project context.",
    );
  }

  log.debug(
    {
      hasDescription: !!description,
      hasArchitecture: !!architecture,
      hasVision: !!vision,
    },
    "Project context loaded for roadmap generation",
  );

  const basePrompt = buildRoadmapGenerationPrompt({
    description,
    architecture,
    vision: vision ?? null,
  });
  // rawResult — fallback на случай, когда агент не записал файл сам (SDK-транспорт без
  // инструментов). Инициализация пустой строкой позволяет ниже отличить "агент ничего не
  // вернул" от "агент вернул текст".
  let rawResult = "";
  try {
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: project.rootPath,
      prompt: basePrompt,
      // Субагенты явно запрещены: генерация карты — это одна связная генерация, а не
      // исследование репозитория; иначе расход токенов непредсказуем, а ответ приходит
      // кусками. usageContext привязывает расход к фиче генерации карты.
      workflowKind: "roadmap-generate",
      systemPromptAppend:
        "Do not spawn subagents. Reply directly with the ROADMAP.md content in markdown format. No JSON, no code fences around the entire output.",
      usageContext: { source: UsageSource.ROADMAP_GENERATE },
    });
    rawResult = (result.outputText ?? "").trim();
    // Транспортные сбои рантайма приводятся к одному коду AGENT_UNAVAILABLE: выше по стеку
    // (в роуте) он превращается в 503, а детали транспорта наружу не утекают — они остаются
    // в тексте сообщения для логов.
  } catch (err) {
    log.error({ err, projectId }, "Agent SDK roadmap generation error");
    throw new RoadmapGenerationError(
      "AGENT_UNAVAILABLE",
      `Agent SDK unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Запись ROADMAP.md — агент мог уже создать файл инструментами (режим CLI),
  // поэтому сначала проверяем файл и только затем откатываемся на outputText.
  // Путь карты берется из конфига проекта, поэтому mkdirSync с recursive: в свежем
  // репозитории вложенной папки под карту может еще не существовать.
  const cfg = getProjectConfig(project.rootPath);
  const roadmapPath = join(project.rootPath, cfg.paths.roadmap);
  mkdirSync(dirname(roadmapPath), { recursive: true });

  let content: string;
  if (existsSync(roadmapPath)) {
    const fileContent = readFileSync(roadmapPath, "utf8").trim();
    // Эвристика "не заглушка": файл длиннее 100 символов и содержит признаки
    // markdown-структуры. Если агент создал пустую заготовку, ее содержимое игнорируется
    // и перезаписывается текстом из ответа.
    // Проверяем, что агент записал настоящую карту, а не заготовку
    if (fileContent.length > 100 && (fileContent.includes("- [") || fileContent.includes("##"))) {
      content = fileContent;
      log.info({ projectId, roadmapPath, source: "file" }, "Using roadmap file written by agent");
    } else {
      content = extractRoadmapContent(rawResult);
      writeFileSync(roadmapPath, content, "utf8");
    }
    // Файла нет и текста нет — это не частичный успех, а полный отказ: сохранять пустой
    // ROADMAP.md нельзя, иначе следующий проход прочитает его как источник правды.
  } else if (rawResult) {
    content = extractRoadmapContent(rawResult);
    writeFileSync(roadmapPath, content, "utf8");
  } else {
    throw new RoadmapGenerationError("EMPTY_RESPONSE", "Agent returned empty roadmap");
  }

  log.info({ projectId, roadmapPath, contentLength: content.length }, "Roadmap file generated");

  return { roadmapPath, content };
}

function buildRoadmapGenerationPrompt(ctx: {
  description: string | null;
  architecture: string | null;
  vision: string | null;
}): string {
  // Разделители вида <<<DESC ... DESC нужны, чтобы модель отличала пользовательский текст
  // от инструкций: DESCRIPTION.md может содержать фразы, похожие на команды, и без явных
  // границ они влияют на генерацию как равноправная часть промпта.
  const sections: string[] = [];

  if (ctx.description) {
    sections.push(`PROJECT DESCRIPTION:\n<<<DESC\n${ctx.description}\nDESC`);
  }
  if (ctx.architecture) {
    sections.push(`ARCHITECTURE:\n<<<ARCH\n${ctx.architecture}\nARCH`);
  }
  if (ctx.vision) {
    sections.push(`USER VISION / REQUIREMENTS:\n<<<VISION\n${ctx.vision}\nVISION`);
  }

  // Промпт задает и структуру, и правила разметки одновременно: файл потом парсится
  // именно по "##" и "- [", поэтому пример формата — часть контракта, а не украшение.
  // Менять его нужно вместе с проверкой в generateRoadmapFile.
  return `You are creating a strategic project roadmap based on the project context below.

${sections.join("\n\n")}

Generate a ROADMAP.md file with the following format:

# Project Roadmap

> <one-line project vision>

## Milestones

- [ ] **Milestone Name** — short description of what this achieves
- [ ] **Milestone Name** — short description of what this achieves

## Completed

| Milestone | Date |
|-----------|------|

Rules:
- Each milestone is a HIGH-LEVEL goal, not a granular task
- 5-15 milestones is the sweet spot
- Order by logical sequence (dependencies first)
- If something appears already built based on the description, mark it [x] and add to Completed table with today's date
- Milestones should be specific and actionable, not vague
- Cover the full scope of the project from current state to production-ready
- Output ONLY the markdown content for ROADMAP.md, nothing else`;
}

/**
 * Читает ROADMAP.md из корня проекта и через Agent SDK извлекает
 * структурированные данные задач как JSON. Результат валидирует через zod.
 */
// Второй проход: файл уже лежит на диске (его мог поправить человек), поэтому читается
// именно файл, а не сохраненный текст первого ответа модели.
export async function generateRoadmapTasks(
  input: RoadmapGenerationInput,
): Promise<RoadmapGenerationResult> {
  const { projectId, roadmapAlias, trackingTaskId } = input;

  log.info({ projectId, roadmapAlias }, "Starting roadmap generation");

  // 1. Разрешить корень проекта и проверить файл карты
  // Файл проверяется до обращения к модели: незачем платить за вызов, если карта еще не
  // сгенерирована или лежит по другому пути (конфиг проекта поменяли после генерации).
  const project = findProjectById(projectId);
  if (!project) {
    throw new RoadmapGenerationError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }

  const tasksCfg = getProjectConfig(project.rootPath);
  const roadmapPath = join(project.rootPath, tasksCfg.paths.roadmap);
  if (!existsSync(roadmapPath)) {
    throw new RoadmapGenerationError(
      "ROADMAP_NOT_FOUND",
      `Roadmap file not found at ${roadmapPath}`,
    );
  }

  // Чтение без явной кодировки сломало бы кириллицу в описаниях майлстоунов, поэтому
  // utf8 задан явно.
  const roadmapContent = readFileSync(roadmapPath, "utf8");
  log.debug({ roadmapPath, contentLength: roadmapContent.length }, "Roadmap file read");

  // 2. Запросить Agent SDK для строгого преобразования в JSON
  const prompt = buildExtractionPrompt(roadmapContent, roadmapAlias);

  let rawResult = "";
  try {
    // Извлечение — механическая задача нормализации, творчество здесь не нужно, поэтому
    // берется light-модель проекта (с откатом к основной, если она не настроена).
    const lightModel = await resolveApiLightModel(projectId, trackingTaskId);
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: project.rootPath,
      // Явный null вместо undefined: контракт рантайма ожидает поле и не должен сам
      // решать, к какой задаче приписать расход, если атрибуции нет.
      taskId: trackingTaskId ?? null,
      prompt,
      workflowKind: "roadmap-extract",
      modelOverride: lightModel,
      systemPromptAppend:
        "Do not spawn subagents. Reply directly with JSON only. No markdown fences, no explanatory text.",
      usageContext: { source: UsageSource.ROADMAP_EXTRACT },
    });

    // Учёт ведётся автоматически обёрткой реестра runtime через DB-сток
    // (runApiRuntimeOneShot проставляет projectId + taskId в usageContext).

    rawResult = (result.outputText ?? "").trim();
  } catch (err) {
    log.error({ err, projectId, roadmapAlias }, "Agent SDK query error");
    throw new RoadmapGenerationError(
      "AGENT_UNAVAILABLE",
      `Agent SDK unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.debug({ rawResultLength: rawResult.length }, "Raw agent output received");

  // Пустой ответ не доходит до zod: сообщение про пустоту понятнее пользователю, чем
  // список ошибок валидации по несуществующему объекту.
  if (!rawResult) {
    throw new RoadmapGenerationError("EMPTY_RESPONSE", "Agent returned empty response");
  }

  // 3. Разобрать и валидировать ответ
  // Это граница доверия: после успешного разбора данные считаются пригодными для записи
  // в базу, до него — произвольный текст от модели.
  const parsed = parseAgentResponse(rawResult, roadmapAlias);
  log.info(
    { projectId, roadmapAlias, taskCount: parsed.tasks.length },
    "Roadmap generation complete",
  );

  return parsed;
}

function buildExtractionPrompt(roadmapContent: string, alias: string): string {
  // Требование "skip - [x]" принципиально: импорт должен быть повторяемым, и уже
  // выполненный майлстоун не должен воскресать как новая задача при каждом запуске на
  // обновленном файле.
  return `You are converting a project roadmap markdown into structured JSON for task creation.

ROADMAP CONTENT:
<<<ROADMAP
${roadmapContent}
ROADMAP

ALIAS: ${alias}

Convert all milestones/tasks from the roadmap into the following JSON structure.
Each item becomes a task. Group by phase (numbered sequentially from 1).
Assign each task a sequence number within its phase (starting from 1).

Required output format (JSON only, no markdown fences):
{
  "alias": "${alias}",
  "tasks": [
    {
      "title": "short imperative task title",
      "description": "detailed description of what needs to be done",
      "phase": 1,
      "phaseName": "Phase Name",
      "sequence": 1
    }
  ]
}

Rules:
- Only include unchecked milestones (- [ ]). Skip completed milestones (- [x]) entirely — do NOT create tasks for them
- Task titles should be short, imperative, and specific
- Descriptions should include enough context for implementation
- Phase numbers must be sequential (1, 2, 3, ...)
- Sequence numbers restart at 1 for each phase
- Return ONLY valid JSON, no explanatory text`;
}

// Сканер с подсчетом глубины скобок, а не регексп: в описаниях задач модель часто
// оставляет фигурные скобки прямо в тексте, и жадный регексп захватил бы лишнее.
// Состояние inString/escape нужно, чтобы кавычки и скобки внутри строковых значений не
// сбивали счетчик глубины.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Единственное место, где ответ модели превращается в типизированные данные. Порядок
// шагов важен: сначала снять фенс, затем попытаться распарсить ответ целиком, и только
// потом искать объект внутри прозы — иначе валидный JSON с текстом вокруг был бы отброшен.
function parseAgentResponse(raw: string, expectedAlias: string): RoadmapGenerationResult {
  // Извлекаем JSON из markdown-ограждений — агент может дописать текст после закрывающего
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  let jsonObj: unknown;
  try {
    jsonObj = JSON.parse(cleaned);
  } catch (initialErr) {
    // Резерв: агент мог добавить прозу перед JSON-объектом
    const extracted = extractJsonObject(cleaned);
    if (extracted) {
      try {
        jsonObj = JSON.parse(extracted);
      } catch (err) {
        // В лог попадает только начало ответа: полный текст бывает в сотни килобайт и
        // раздул бы файл логов без пользы для разбора инцидента.
        log.error({ raw: raw.slice(0, 500), err }, "Failed to parse agent response as JSON");
        throw new RoadmapGenerationError(
          "PARSE_ERROR",
          `Agent response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      log.error(
        { raw: raw.slice(0, 500), err: initialErr },
        "Failed to parse agent response as JSON",
      );
      throw new RoadmapGenerationError(
        "PARSE_ERROR",
        `Agent response is not valid JSON: ${initialErr instanceof Error ? initialErr.message : String(initialErr)}`,
      );
    }
  }

  const validated = roadmapResponseSchema.safeParse(jsonObj);
  if (!validated.success) {
    log.error(
      { issues: validated.error.issues, raw: raw.slice(0, 500) },
      "Agent response failed zod validation",
    );
    throw new RoadmapGenerationError(
      "VALIDATION_ERROR",
      `Response validation failed: ${validated.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  // Нормализация алиаса под вход
  // Алиас принудительно подменяется на ожидаемый: модель может вернуть его с опечаткой
  // или в другом регистре, а от алиаса зависит дедупликация следующего импорта, поэтому
  // он не может зависеть от ответа модели.
  return {
    alias: expectedAlias,
    tasks: validated.data.tasks,
  };
}

// -- Обогащение тегов --

// Набор тегов — публичный контракт: по rm:<alias> задачи группируются в интерфейсе, по
// phase:/seq: они сортируются. Формат слага и паддинга номера нельзя менять без миграции
// уже созданных задач.

/**
 * Строит обязательный набор тегов для сгенерированной задачи карты.
 * Теги: roadmap, rm:<alias>, phase:<number>, phase:<name>, seq:<nn>
 */
export function buildTaskTags(alias: string, task: GeneratedTask): string[] {
  const tags: string[] = ["roadmap", `rm:${alias}`];
  tags.push(`phase:${task.phase}`);
  if (task.phaseName) {
    tags.push(`phase:${task.phaseName.toLowerCase().replace(/\s+/g, "-")}`);
  }
  tags.push(`seq:${String(task.sequence).padStart(2, "0")}`);
  return tags;
}

// Ключ дедупликации. Регистр и повторные пробелы убираются потому, что при повторной
// генерации модель почти всегда перефразирует заголовок чуть иначе, и без нормализации
// повторный импорт создал бы дубликаты.
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

// Порядок импорта должен совпадать с порядком чтения человеком: фаза, затем позиция
// внутри фазы, затем исходный порядок в ответе модели. Последний критерий делает
// сортировку детерминированной при равных phase и sequence.
function compareRoadmapImportOrder(a: IndexedGeneratedTask, b: IndexedGeneratedTask): number {
  return a.task.phase - b.task.phase || a.task.sequence - b.task.sequence || a.index - b.index;
}

// -- Дедупликация + пакетное создание --

// Сводка по фазам возвращается наружу без изменений: интерфейс показывает пользователю,
// сколько задач реально создалось и сколько было пропущено как дубликаты.
export interface ImportResult {
  roadmapAlias: string;
  created: number;
  skipped: number;
  taskIds: string[];
  byPhase: Record<number, { created: number; skipped: number }>;
}

/**
 * Импортирует сгенерированные задачи в базу, дедуплицируя по
 * projectId + normalizedTitle + roadmapAlias.
 */
export function importGeneratedTasks(
  projectId: string,
  generation: RoadmapGenerationResult,
): ImportResult {
  const { alias, tasks: generatedTasks } = generation;

  log.info({ projectId, alias, totalTasks: generatedTasks.length }, "Starting task import");

  // Разрешаем конфиг проекта, чтобы каждая импортированная задача получила
  // уникальный planPath на основе slug. Иначе каждая откатывалась бы к общему
  // значению по умолчанию `cfg.paths.plan` и затирала план предыдущей задачи на
  // диске (см. lee-to/aif-handoff#55). planPath здесь отвязан от plannerMode:
  // задача сохраняет режим планировщика по умолчанию проекта, мы лишь
  // гарантируем уникальность самого пути файла плана при массовых импортах.
  const project = findProjectById(projectId);
  if (!project) {
    throw new RoadmapGenerationError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
  }
  const cfg = getProjectConfig(project.rootPath);

  // Загружаются только задачи этого алиаса: одинаковые заголовки в разных дорожных
  // картах легальны, и склеивать их между собой нельзя.
  // Для дедупликации загружаем существующие задачи этого алиаса
  const existing = findTasksByRoadmapAlias(projectId, alias);
  const existingTitles = new Set(existing.map((t) => normalizeTitle(t.title)));

  // Резервируем все planPath, уже занятые любой задачей этого проекта (по всем
  // алиасам), чтобы суффиксы от коллизий случайно не перезаписали существующий
  // файл плана. Общее значение по умолчанию исключено: оно не принадлежит
  // какой-то одной задаче, и сталкиваться с ним безопасно.
  const usedPlanPaths = new Set<string>(
    listTasks(projectId)
      .map((t) => t.planPath)
      .filter((p): p is string => !!p && p !== cfg.paths.plan),
  );
  const minBacklogPosition = getMinBacklogPosition(projectId);
  // Импорт карты — сознательный путь «в начало очереди»: импортированные задачи
  // получают позиции перед текущим минимумом бэклога, чтобы порядок фаз/последовательности
  // побеждал, хотя обычное создание задач теперь дописывает в хвост.
  // Шаг 100 оставляет запас, чтобы вставка задачи между двумя импортированными не
  // требовала переиндексации всего бэклога.
  const importPositionStart = (minBacklogPosition ?? 1000) - generatedTasks.length * 100;

  // Вычисляем уникальный путь плана для каждой задачи общим хелпером slug
  // и добавляем `-2`, `-3`, … перед `.md`, если базовый путь сталкивается с уже
  // зарезервированным. Это покрывает и коллизии внутри пачки (два заголовка,
  // приводящиеся к одному slug), и коллизии между импортами (повторные импорты
  // или разные алиасы, дающие один и тот же slug).
  const reserveUniquePlanPath = (title: string): string => {
    const base = generatePlanPath(title, "full", {
      plansDir: cfg.paths.plans,
      defaultPlanPath: cfg.paths.plan,
    });
    if (!usedPlanPaths.has(base)) {
      usedPlanPaths.add(base);
      return base;
    }
    // Суффикс вставляется перед расширением, а не в конец строки: с суффиксом после
    // ".md" файл перестал бы считаться markdown-планом для остальных частей системы.
    const suffixMatch = base.match(/^(.*)\.md$/);
    const stem = suffixMatch ? suffixMatch[1] : base;
    let counter = 2;
    let candidate = `${stem}-${counter}.md`;
    while (usedPlanPaths.has(candidate)) {
      counter++;
      candidate = `${stem}-${counter}.md`;
    }
    usedPlanPaths.add(candidate);
    return candidate;
  };

  const result: ImportResult = {
    roadmapAlias: alias,
    created: 0,
    skipped: 0,
    taskIds: [],
    byPhase: {},
  };

  // Сортировка выполняется до создания задач: позиции в бэклоге выдаются по порядку
  // обхода массива, поэтому этот шаг напрямую задает порядок карточек в колонке.
  const orderedTasks = generatedTasks
    .map((task, index) => ({ task, index }))
    .sort(compareRoadmapImportOrder);

  // Счетчик растет только на успешно созданных задачах: пропущенные дубликаты не должны
  // оставлять дыры в нумерации позиций.
  let createdPositionIndex = 0;

  for (const { task: genTask } of orderedTasks) {
    // Аккумулятор по фазе создается лениво: набор фаз приходит из ответа модели и
    // заранее неизвестен.
    const phaseStats = result.byPhase[genTask.phase] ?? { created: 0, skipped: 0 };
    result.byPhase[genTask.phase] = phaseStats;

    // Пропуск дубликата — не ошибка: повторный импорт того же файла обычен (пользователь
    // добавил новые майлстоуны), и он должен до-создавать только новое.
    const normalized = normalizeTitle(genTask.title);
    if (existingTitles.has(normalized)) {
      log.debug({ title: genTask.title, alias, phase: genTask.phase }, "Task skipped (duplicate)");
      phaseStats.skipped++;
      result.skipped++;
      continue;
    }

    const tags = buildTaskTags(alias, genTask);
    // Импорт карты минует POST /tasks, поэтому режимные значения по умолчанию
    // должны применяться и здесь. Проекты с parallelEnabled принудительно берут
    // "full" (то же правило, что у POST); иначе — "fast". skipReview для импорта
    // карты всегда true, чтобы пакетный конвейер не замирал на ревью.
    const planPath = reserveUniquePlanPath(genTask.title);
    const plannerMode = project.parallelEnabled ? "full" : "fast";
    const modeDefaults = defaultsForMode(plannerMode);
    const created = createTask({
      projectId,
      title: genTask.title,
      description: genTask.description,
      roadmapAlias: alias,
      tags,
      planPath,
      plannerMode,
      planDocs: modeDefaults.planDocs,
      planTests: modeDefaults.planTests,
      skipReview: true,
      useSubagents: getEnv().AGENT_USE_SUBAGENTS,
      position: importPositionStart + createdPositionIndex * 100,
    });

    // createTask возвращает null, если уникальность нарушилась на уровне базы (гонка с
    // параллельным импортом). Такой случай просто не попадает в счетчики и не двигает
    // позицию следующей задачи.
    if (created) {
      createdPositionIndex++;
      result.taskIds.push(created.id);
      phaseStats.created++;
      result.created++;
      existingTitles.add(normalized);
    }
  }

  log.info(
    {
      projectId,
      alias,
      created: result.created,
      skipped: result.skipped,
    },
    "Task import complete with distinct plan paths",
  );

  return result;
}

// Код ошибки отделен от текста сообщения: роут маппит code на HTTP-статус, и решение
// принимается по структуре, а не по разбору строки — сообщение может быть дополнено или
// локализовано без предупреждения.
export class RoadmapGenerationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RoadmapGenerationError";
  }
}
