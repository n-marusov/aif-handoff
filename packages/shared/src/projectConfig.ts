// Конфигурация проекта: пути к артефактам, правила workflow, настройки git и язык
// артефактов.
//
// Значения по умолчанию - это контракт структуры проекта: они позволяют работать с
// проектом до появления .ai-factory/config.yaml. Файл конфигурации лишь
// переопределяет часть полей, поэтому чтение всегда идёт через слияние с
// умолчаниями, а не заменой объекта целиком.
//
// Модуль серверный: использует node:fs и YAML, в браузерный вход не входит.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface AifProjectPaths {
  plan: string;
  plans: string;
  fix_plan: string;
  roadmap: string;
  description: string;
  architecture: string;
  docs: string;
  research: string;
  rules_file: string;
  security: string;
  references: string;
  patches: string;
  evolutions: string;
  evolution: string;
  specs: string;
  rules: string;
  qa: string;
}

export interface AifProjectWorkflow {
  auto_create_dirs: boolean;
  plan_id_format: "slug" | "timestamp" | "uuid";
  analyze_updates_architecture: boolean;
  architecture_updates_roadmap: boolean;
  verify_mode: "strict" | "normal" | "lenient";
}

export interface AifProjectGit {
  enabled: boolean;
  base_branch: string;
  create_branches: boolean;
  branch_prefix: string;
  /**
   * Если true, `/aif-commit` (и авто-коммит при approve-done) должен создать
   * коммит без push. Если false (по умолчанию), после коммита выполняется push
   * в текущую ветку. Параметр отображается в настройках web-интерфейса.
   */
  skip_push_after_commit: boolean;
  /**
   * Политика `git pull --ff-only origin <base_branch>` перед созданием
   * feature-ветки. Если false (по умолчанию), неуспешный pull обрабатывается
   * по принципу best-effort: Handoff пишет предупреждение и ветвится от
   * локальной базы. Если true, неуспешный pull превращается в
   * `BranchIsolationError("base_update_failed")`, а задача переводится в
   * `blocked_external`. Подходит проектам, где feature-ветка должна
   * начинаться только от актуальной базы.
   */
  strict_base_update: boolean;
}

export interface AifProjectLanguage {
  /** Локаль для UI-подсказок (пока информационная, зарезервирована для развития UI). */
  ui: string;
  /**
   * Локаль, в которой ИИ должен генерировать артефакты: описания задач,
   * планы, заметки ревью, сообщения коммита, элементы roadmap и ответы чата.
   * Используется код языка в стиле BCP-47 в нижнем регистре. "en"
   * (по умолчанию) означает, что дополнительная директива не внедряется.
   */
  artifacts: string;
  /**
   * Политика для технических токенов (идентификаторы, имена API, пути,
   * флаги CLI, фрагменты кода). "keep" — оставлять на английском даже при
   * нерусском языке артефактов. "translate" — переводить вместе с остальным.
   */
  technical_terms: "keep" | "translate";
}

// Полная разрешённая конфигурация проекта: то, что видят потребители после слияния
// файла с умолчаниями.
export interface AifProjectConfig {
  paths: AifProjectPaths;
  workflow: AifProjectWorkflow;
  git: AifProjectGit;
  language: AifProjectLanguage;
}

// Пути относительны корня проекта и намеренно повторяют раскладку ai-factory: так
// файлы остаются совместимы с внешним инструментом инициализации.
const DEFAULT_PATHS: AifProjectPaths = {
  plan: ".ai-factory/PLAN.md",
  plans: ".ai-factory/plans/",
  fix_plan: ".ai-factory/FIX_PLAN.md",
  roadmap: ".ai-factory/ROADMAP.md",
  description: ".ai-factory/DESCRIPTION.md",
  architecture: ".ai-factory/ARCHITECTURE.md",
  docs: "docs/",
  research: ".ai-factory/RESEARCH.md",
  rules_file: ".ai-factory/RULES.md",
  security: ".ai-factory/SECURITY.md",
  references: ".ai-factory/references/",
  patches: ".ai-factory/patches/",
  evolutions: ".ai-factory/evolutions/",
  evolution: ".ai-factory/evolution/",
  specs: ".ai-factory/specs/",
  rules: ".ai-factory/rules/",
  qa: ".ai-factory/qa/",
};

const DEFAULT_WORKFLOW: AifProjectWorkflow = {
  auto_create_dirs: true,
  plan_id_format: "slug",
  analyze_updates_architecture: true,
  architecture_updates_roadmap: true,
  verify_mode: "normal",
};

// Умолчания git подобраны так, чтобы не делать ничего неожиданного: ветки создаются,
// push после коммита разрешён, строгая проверка актуальности базы выключена.
const DEFAULT_GIT: AifProjectGit = {
  enabled: true,
  base_branch: "main",
  create_branches: true,
  branch_prefix: "feature/",
  skip_push_after_commit: false,
  strict_base_update: false,
};

const DEFAULT_LANGUAGE: AifProjectLanguage = {
  ui: "en",
  artifacts: "en",
  technical_terms: "keep",
};

/**
 * Консервативная проверка тега языка в стиле BCP-47: первичный под-тег 2-3
 * символа и опциональные под-теги через `-`/`_` (по 2-8 символов).
 * Отсекает опечатки и мусорные значения, чтобы они не попадали как есть
 * в системную директиву (например, `"ru1"` или `"русский"`).
 */
// Проверка нужна, чтобы мусор из конфигурации не попадал в системную директиву для
// модели дословно: значение вида "ru1" или "русский" вместо кода языка сбивало бы её.
const BCP47_TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/;

// Невалидное значение молча заменяется значением по умолчанию: конфигурация - не то
// место, где стоит останавливать работу проекта из-за опечатки в коде языка.
function normalizeLanguageTag(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return fallback;
  return BCP47_TAG.test(trimmed) ? trimmed : fallback;
}

function normalizeLanguage(raw: unknown): AifProjectLanguage {
  const obj = (raw ?? {}) as Partial<AifProjectLanguage>;
  const ui = normalizeLanguageTag(obj.ui, DEFAULT_LANGUAGE.ui);
  const artifacts = normalizeLanguageTag(obj.artifacts, DEFAULT_LANGUAGE.artifacts);
  // Повторяем мягкий разбор `ui`/`artifacts`, чтобы варианты вроде
  // `"Translate"` или `" translate "` не откатывались молча к `keep`.
  const technicalRaw =
    typeof obj.technical_terms === "string" ? obj.technical_terms.trim().toLowerCase() : "";
  const technicalTerms =
    technicalRaw === "translate" ? "translate" : DEFAULT_LANGUAGE.technical_terms;
  return { ui, artifacts, technical_terms: technicalTerms };
}

/** Кеш конфигураций по projectRoot, чтобы не перечитывать файл на каждый вызов. */
// Вместе с конфигом хранится время изменения файла: без этого правка config.yaml не
// подхватилась бы до перезапуска процесса. Кэш живёт в памяти процесса -
// межпроцессной согласованности здесь не требуется.
const configCache = new Map<string, { config: AifProjectConfig; mtimeMs: number }>();

/**
 * Загружает итоговую конфигурацию проекта.
 * Если есть `.ai-factory/config.yaml`, его значения переопределяют умолчания.
 * Результаты кешируются по projectRoot и сбрасываются при изменении mtime.
 */
export function getProjectConfig(projectRoot: string): AifProjectConfig {
  const configPath = join(projectRoot, ".ai-factory", "config.yaml");

  if (!existsSync(configPath)) {
    // Возвращаются копии, а не сами объекты умолчаний: иначе вызывающий код мог бы
    // случайно изменить глобальные значения сразу для всех проектов.
    return {
      paths: { ...DEFAULT_PATHS },
      workflow: { ...DEFAULT_WORKFLOW },
      git: { ...DEFAULT_GIT },
      language: { ...DEFAULT_LANGUAGE },
    };
  }

  // Сравнение по mtimeMs, а не по содержимому: один stat дешевле, чем чтение и
  // разбор YAML на каждый вызов.
  const stat = statSync(configPath);
  const cached = configCache.get(projectRoot);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.config;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw) as Record<string, unknown> | null;

  const yamlPaths = (parsed?.paths ?? {}) as Partial<AifProjectPaths>;
  const yamlWorkflow = (parsed?.workflow ?? {}) as Partial<AifProjectWorkflow>;
  const yamlGit = (parsed?.git ?? {}) as Partial<AifProjectGit>;

  // Слияние поверхностное, по секциям: незаданные поля внутри секции берут значения
  // по умолчанию. Благодаря этому уже существующий config.yaml продолжает работать
  // после добавления новых параметров.
  const config: AifProjectConfig = {
    paths: { ...DEFAULT_PATHS, ...yamlPaths },
    workflow: { ...DEFAULT_WORKFLOW, ...yamlWorkflow },
    git: { ...DEFAULT_GIT, ...yamlGit },
    language: normalizeLanguage(parsed?.language),
  };

  configCache.set(projectRoot, { config, mtimeMs: stat.mtimeMs });
  return config;
}

/** Очищает кеш конфигурации проекта (полезно после записи config.yaml). */
// Вызывается после записи config.yaml: mtime в кэше обновится только при следующем
// чтении файла, а вызывающий код обычно ждёт изменений немедленно.
export function clearProjectConfigCache(projectRoot?: string): void {
  if (projectRoot) {
    configCache.delete(projectRoot);
  } else {
    configCache.clear();
  }
}
