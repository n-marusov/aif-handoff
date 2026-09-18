// Подключение к базе и управление схемой: открытие соединения, создание таблиц,
// миграции, триггеры и индексы.
//
// Схема описывается в schema.ts, а здесь всё, что приводит существующую базу к этой схеме.
// Порядок применения жёстко задан:
//   1. ensureTables - CREATE TABLE IF NOT EXISTS для чистой базы;
//   2. runMigrations - нумерованные миграции, ориентир - PRAGMA user_version;
//   3. runRuntimeBackfills, ensureTriggers, ensureIndexes - идемпотентные доработки.
//
// Соединение одно на процесс и кэшируется: одному процессу незачем держать несколько
// подключений к тому же файлу.
//
// ВАЖНО про миграции: массив MIGRATIONS только дополняется. Номер версии и SQL уже
// выпущенной миграции менять нельзя - база хранит прогресс в PRAGMA user_version, и
// подменённый SQL на таких базах просто не выполнится, оставив схему рассинхронизированной
// с кодом. При конфликте веток новая миграция добавляется в конец со следующим номером.

import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { logger } from "./logger.js";
import { findMonorepoRootFromUrl } from "./monorepoRoot.js";

const log = logger("db");

// Ссылки на соединение держатся в модуле: drizzle-объект нужен потребителям, а исходный
// клиент - для pragma, транзакций и закрытия.
let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

// Корень монорепозитория нужен для разрешения относительного пути к базе.
const MONOREPO_ROOT = findMonorepoRootFromUrl(import.meta.url);

// Относительный путь разрешается от корня монорепозитория, а не от текущего каталога:
// процессы запускаются из разных мест, а база в проекте одна. Специальное значение
// ":memory:" и абсолютные пути возвращаются без изменений.
/** Разрешает путь к базе относительно корня монорепозитория. */
function resolveDbPath(raw: string): string {
  if (raw === ":memory:" || raw.startsWith("/")) return raw;
  return resolve(MONOREPO_ROOT, raw);
}

// Соединение создаётся лениво и один раз на процесс. При открытии выставляются два
// обязательных режима: WAL даёт параллельное чтение во время записи, а foreign_keys = ON
// включает проверку внешних ключей, которая в SQLite по умолчанию выключена.
export function getDb(url?: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const dbPath = resolveDbPath(url ?? process.env.DATABASE_URL ?? "./data/aif.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  log.debug({ dbPath }, "Opening database connection");

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  ensureTables(_sqlite);

  _db = drizzle(_sqlite, { schema });
  log.info({ dbPath }, "Database connected");

  return _db;
}

/** Создаёт таблицы, если они ещё не существуют. */
// Создание таблиц для чистой базы. Выражения идемпотентны (IF NOT EXISTS), а описанная
// здесь схема соответствует последней версии - поэтому на новой базе миграции ниже
// пропускаются.
function ensureTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      planner_max_budget_usd REAL,
      plan_checker_max_budget_usd REAL,
      implementer_max_budget_usd REAL,
      review_sidecar_max_budget_usd REAL,
      pinned_at TEXT,
      group_name TEXT,
      parallel_enabled INTEGER NOT NULL DEFAULT 0,
      auto_queue_mode INTEGER NOT NULL DEFAULT 0,
      default_task_runtime_profile_id TEXT,
      default_plan_runtime_profile_id TEXT,
      default_review_runtime_profile_id TEXT,
      default_chat_runtime_profile_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
      default_task_runtime_profile_id TEXT,
      default_plan_runtime_profile_id TEXT,
      default_review_runtime_profile_id TEXT,
      default_chat_runtime_profile_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      normalized_username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      active INTEGER NOT NULL DEFAULT 1,
      deactivated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS participant_sessions (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      token_digest TEXT NOT NULL UNIQUE,
      csrf_token_digest TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      auto_mode INTEGER NOT NULL DEFAULT 1,
      execution_owner TEXT NOT NULL DEFAULT 'ai' CHECK (execution_owner IN ('ai', 'human')),
      ownership_revision INTEGER NOT NULL DEFAULT 0,
      is_fix INTEGER NOT NULL DEFAULT 0,
      planner_mode TEXT NOT NULL DEFAULT 'fast',
      plan_path TEXT NOT NULL DEFAULT '.ai-factory/PLAN.md',
      plan_docs INTEGER NOT NULL DEFAULT 0,
      plan_tests INTEGER NOT NULL DEFAULT 0,
      skip_review INTEGER NOT NULL DEFAULT 0,
      use_subagents INTEGER NOT NULL DEFAULT 0,
      run_plan_improve INTEGER NOT NULL DEFAULT 0,
      run_post_verify INTEGER NOT NULL DEFAULT 0,
      auto_qa INTEGER NOT NULL DEFAULT 0,
      qa_change_summary TEXT,
      qa_test_plan TEXT,
      qa_test_cases TEXT,
      qa_status TEXT NOT NULL DEFAULT 'idle',
      status TEXT NOT NULL DEFAULT 'backlog',
      priority INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 1000.0,
      plan TEXT,
      implementation_log TEXT,
      review_comments TEXT,
      agent_activity_log TEXT,
      blocked_reason TEXT,
      blocked_from_status TEXT,
      retry_after TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      token_total INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      roadmap_alias TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      rework_requested INTEGER NOT NULL DEFAULT 0,
      review_iteration_count INTEGER NOT NULL DEFAULT 0,
      max_review_iterations INTEGER NOT NULL DEFAULT 3,
      manual_review_required INTEGER NOT NULL DEFAULT 0,
      auto_review_state_json TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at TEXT,
      last_synced_at TEXT,
      runtime_profile_id TEXT,
      model_override TEXT,
      runtime_options_json TEXT,
      session_id TEXT,
      active_runtime_status TEXT,
      active_runtime_selection_json TEXT,
      runtime_limit_snapshot_json TEXT,
      runtime_limit_updated_at TEXT,
      locked_by TEXT,
      locked_until TEXT,
      scheduled_at TEXT,
      branch_name TEXT,
      worktree_path TEXT,
      auto_queue_commit_status TEXT,
      auto_queue_commit_base_sha TEXT,
      commit_sha TEXT,
      auto_queue_commit_error TEXT,
      auto_queue_commit_completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human',
      participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      assigned_by_kind TEXT NOT NULL,
      assigned_by_id TEXT,
      assigned_by_display_name_snapshot TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (task_id, participant_id)
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_executor_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_title_snapshot TEXT NOT NULL,
      ownership_revision INTEGER NOT NULL,
      execution_owner TEXT NOT NULL CHECK (execution_owner IN ('ai', 'human')),
      assignees_snapshot_json TEXT NOT NULL DEFAULT '[]',
      status_snapshot TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      actor_display_name_snapshot TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      task_id TEXT,
      task_title_snapshot TEXT,
      participant_id TEXT,
      participant_display_name_snapshot TEXT,
      execution_owner_snapshot TEXT,
      assignees_snapshot_json TEXT,
      status_snapshot TEXT,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      actor_display_name_snapshot TEXT,
      reason TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS github_repositories (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      html_url TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      token_env_var TEXT NOT NULL DEFAULT 'GITHUB_TOKEN',
      eligibility_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT,
      sync_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS github_issues (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      issue_number INTEGER NOT NULL,
      task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
      node_id TEXT NOT NULL,
      html_url TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      source_updated_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      sync_error TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      pr_state TEXT CHECK (pr_state IS NULL OR pr_state IN ('open', 'closed', 'merged')),
      pr_checks_status TEXT CHECK (pr_checks_status IS NULL OR pr_checks_status IN ('pending', 'success', 'failure')),
      review_state TEXT CHECK (review_state IS NULL OR review_state IN ('pending', 'approved', 'changes_requested')),
      last_review_id INTEGER,
      review_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (project_id, issue_number)
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runtime_profiles (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      transport TEXT,
      base_url TEXT,
      api_key_env_var TEXT,
      default_model TEXT,
      headers_json TEXT NOT NULL DEFAULT '{}',
      options_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      runtime_limit_snapshot_json TEXT,
      runtime_limit_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      agent_session_id TEXT,
      runtime_profile_id TEXT,
      runtime_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      project_id TEXT,
      task_id TEXT,
      chat_session_id TEXT,
      runtime_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      profile_id TEXT,
      transport TEXT,
      workflow_kind TEXT,
      usage_reporting TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runtime_warmup_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      runtime_profile_id TEXT,
      runtime_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      transport TEXT,
      model TEXT,
      source_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      ttl_seconds INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      summary TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS codex_sessions (
      session_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT,
      project_root TEXT,
      account_fingerprint TEXT,
      source_created_at TEXT,
      source_updated_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      preview_text TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_indexed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS codex_session_files (
      file_path TEXT PRIMARY KEY,
      session_id TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      parsed_offset INTEGER NOT NULL DEFAULT 0,
      pending_tail TEXT NOT NULL DEFAULT '',
      missing INTEGER NOT NULL DEFAULT 0,
      import_version INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS codex_limit_heads (
      head_key TEXT PRIMARY KEY,
      account_fingerprint TEXT NOT NULL,
      project_root TEXT,
      limit_id TEXT NOT NULL,
      model TEXT,
      source TEXT NOT NULL DEFAULT 'codex',
      snapshot_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      session_id TEXT,
      file_path TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS codex_limit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      head_key TEXT NOT NULL,
      account_fingerprint TEXT NOT NULL,
      project_root TEXT,
      limit_id TEXT NOT NULL,
      model TEXT,
      snapshot_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      session_id TEXT,
      file_path TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS codex_index_cursors (
      cursor_key TEXT PRIMARY KEY,
      cursor_value TEXT,
      cursor_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  runMigrations(sqlite);
  ensureTriggers(sqlite);
  runRuntimeBackfills(sqlite);
  ensureIndexes(sqlite);
}

/**
 * Система версионированных миграций на PRAGMA user_version из SQLite.
 * Каждая миграция выполняется один раз, по порядку, внутри транзакции.
 * Новые миграции добавляются в конец массива — существующие записи нельзя переставлять или удалять.
 */
// Описание одной миграции. Триггеры вынесены в отдельное поле, потому что их DDL содержит
// точки с запятой внутри тела (BEGIN ... END) - разбиение по ";" его разрушило бы.
// Поле backfill позволяет выполнить перенос данных в той же транзакции, что и изменение
// схемы, то есть без промежуточного состояния.
interface Migration {
  version: number;
  description: string;
  sql: string;
  /** DDL-выражения триггеров с точками с запятой внутри тела, которые нужно выполнять целиком. */
  triggers?: string[];
  /** Необязательная миграция данных, выполняемая атомарно с версионированным DDL. */
  backfill?: (sqlite: Database.Database) => Record<string, number>;
}

// Перенос данных: строкам без владельца проставляются значения по умолчанию. Запускается
// в одной транзакции с изменением схемы, поэтому прерывание не оставит половинчатого
// состояния.
function backfillParticipantOwnership(sqlite: Database.Database): Record<string, number> {
  // Миграция может применяться и к базе, созданной до появления колонки created_at,
  // поэтому выражение для времени выбирается по факту её наличия.
  const historyCreatedAtExpression = hasColumn(sqlite, "tasks", "created_at")
    ? "tasks.created_at"
    : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const existingTaskCount = sqlite.prepare("SELECT count(*) AS count FROM tasks").get() as {
    count: number;
  };
  const ownerDefaults = sqlite
    .prepare(
      `
        UPDATE tasks
        SET execution_owner = 'ai',
            ownership_revision = 0
        WHERE execution_owner IS NULL
           OR ownership_revision IS NULL
      `,
    )
    .run();
  const historyRows = sqlite
    .prepare(
      `
        INSERT INTO task_executor_history (
          id,
          task_id,
          task_title_snapshot,
          ownership_revision,
          execution_owner,
          assignees_snapshot_json,
          status_snapshot,
          actor_kind,
          actor_id,
          actor_display_name_snapshot,
          reason,
          created_at
        )
        SELECT
          'history-' || lower(hex(randomblob(16))),
          tasks.id,
          tasks.title,
          tasks.ownership_revision,
          tasks.execution_owner,
          '[]',
          tasks.status,
          'system',
          NULL,
          'System',
          'migration_v27_initial_owner',
          ${historyCreatedAtExpression}
        FROM tasks
        WHERE NOT EXISTS (
          SELECT 1
          FROM task_executor_history history
          WHERE history.task_id = tasks.id
        )
      `,
    )
    .run();

  return {
    existingTaskCount: existingTaskCount.count,
    ownerDefaultsUpdated: ownerDefaults.changes,
    executorHistoryInserted: historyRows.changes,
  };
}

// Нумерованные миграции. ПРАВИЛО: массив только дополняется. Нельзя менять номер версии
// или SQL уже выпущенной миграции: база, где эта версия применена, пропустит новое
// содержимое (runMigrations отбирает version > user_version), и схема разойдётся с кодом.
// При конфликте в мерже ранее влитая миграция остаётся на своём номере, а вторая переносится
// в конец с новым.
//
// ALTER TABLE ADD COLUMN безопасно выпускать повторно: ошибка о дублирующейся колонке
// поглощается isIgnorableMigrationError.
const MIGRATIONS: Migration[] = [
  // Наследованные колонки, добавлявшиеся через ensureColumn, — сведены в миграции.
  // Идемпотентные проверки в стиле ensureColumn: в существующих базах они уже есть.
  {
    version: 1,
    description: "Add session_id column to tasks for agent session resume",
    sql: "ALTER TABLE tasks ADD COLUMN session_id TEXT",
  },
  {
    version: 2,
    description: "Add chat_sessions and chat_messages tables",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New Chat',
        agent_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    version: 3,
    description: "Add attachments column to chat_messages",
    sql: "ALTER TABLE chat_messages ADD COLUMN attachments TEXT",
  },
  {
    version: 4,
    description: "Add parallel_enabled column to projects",
    sql: "ALTER TABLE projects ADD COLUMN parallel_enabled INTEGER NOT NULL DEFAULT 0",
  },
  {
    version: 5,
    description: "Add task locking columns for parallel execution",
    sql: `
      ALTER TABLE tasks ADD COLUMN locked_by TEXT;
      ALTER TABLE tasks ADD COLUMN locked_until TEXT;
    `,
  },
  {
    version: 6,
    description: "Add runtime profile persistence and runtime-neutral session columns",
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        name TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        transport TEXT,
        base_url TEXT,
        api_key_env_var TEXT,
        default_model TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        options_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      ALTER TABLE projects ADD COLUMN default_task_runtime_profile_id TEXT;
      ALTER TABLE projects ADD COLUMN default_chat_runtime_profile_id TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_profile_id TEXT;
      ALTER TABLE tasks ADD COLUMN model_override TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_options_json TEXT;
      ALTER TABLE chat_sessions ADD COLUMN runtime_profile_id TEXT;
      ALTER TABLE chat_sessions ADD COLUMN runtime_session_id TEXT;
    `,
  },
  {
    version: 7,
    description: "Add cascade cleanup triggers for runtime_profiles deletion",
    sql: "",
    triggers: [
      `CREATE TRIGGER IF NOT EXISTS trg_runtime_profiles_delete
       AFTER DELETE ON runtime_profiles
       FOR EACH ROW
       BEGIN
         UPDATE tasks SET runtime_profile_id = NULL WHERE runtime_profile_id = OLD.id;
         UPDATE projects SET default_task_runtime_profile_id = NULL WHERE default_task_runtime_profile_id = OLD.id;
         UPDATE projects SET default_chat_runtime_profile_id = NULL WHERE default_chat_runtime_profile_id = OLD.id;
         UPDATE chat_sessions SET runtime_profile_id = NULL WHERE runtime_profile_id = OLD.id;
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_projects_delete_profiles
       AFTER DELETE ON projects
       FOR EACH ROW
       BEGIN
         DELETE FROM runtime_profiles WHERE project_id = OLD.id;
       END`,
    ],
  },
  {
    version: 8,
    description: "Add per-stage runtime profile columns to projects",
    sql: `
      ALTER TABLE projects ADD COLUMN default_plan_runtime_profile_id TEXT;
      ALTER TABLE projects ADD COLUMN default_review_runtime_profile_id TEXT;
    `,
  },
  {
    version: 9,
    description: "Add usage_events table and per-entity token aggregates (projects, chat_sessions)",
    sql: `
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        chat_session_id TEXT,
        runtime_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        profile_id TEXT,
        transport TEXT,
        workflow_kind TEXT,
        usage_reporting TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      ALTER TABLE projects ADD COLUMN token_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN token_output INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN token_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN token_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN token_output INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN token_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
    `,
  },
  // ВАЖНО: версия 10 намеренно переписывает старую «только backfill» миграцию
  // апстрима, потому что ответвлённая ветка фичи ранее использовала версию 9 под
  // схему manual-review. Базам, уже выполнившим апстримные v9/v10, ничего не угрожает:
  // в них есть usage_events и агрегатные колонки токенов, поэтому пропуск
  // переписанной v10 безвреден. Базам, дошедшим до v9 из ответвлённой ветки,
  // нужен этот шаг сверки, чтобы версия 11 легла корректно
  // после слияния историй.
  {
    version: 10,
    description:
      "Reconcile usage-event schema for diverged version-9 histories and backfill project token aggregates",
    sql: `
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        chat_session_id TEXT,
        runtime_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        profile_id TEXT,
        transport TEXT,
        workflow_kind TEXT,
        usage_reporting TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      ALTER TABLE projects ADD COLUMN token_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN token_output INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN token_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN token_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN token_output INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN token_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      UPDATE projects
      SET
        token_input  = token_input  + coalesce((SELECT sum(token_input)  FROM tasks WHERE tasks.project_id = projects.id), 0),
        token_output = token_output + coalesce((SELECT sum(token_output) FROM tasks WHERE tasks.project_id = projects.id), 0),
        token_total  = token_total  + coalesce((SELECT sum(token_total)  FROM tasks WHERE tasks.project_id = projects.id), 0),
        cost_usd     = cost_usd     + coalesce((SELECT sum(cost_usd)     FROM tasks WHERE tasks.project_id = projects.id), 0)
      WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.project_id = projects.id AND tasks.token_total > 0)
    `,
  },
  {
    version: 11,
    description: "Add auto review manual handoff and state snapshot columns to tasks",
    sql: `
      ALTER TABLE tasks ADD COLUMN manual_review_required INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN auto_review_state_json TEXT;
    `,
  },
  {
    version: 12,
    description:
      "Add scheduled_at (tasks) and auto_queue_mode (projects) for scheduled execution and auto-queue",
    sql: `
      ALTER TABLE tasks ADD COLUMN scheduled_at TEXT;
      ALTER TABLE projects ADD COLUMN auto_queue_mode INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 13,
    description: "Persist runtime limit snapshots on runtime_profiles and tasks",
    sql: `
      ALTER TABLE runtime_profiles ADD COLUMN runtime_limit_snapshot_json TEXT;
      ALTER TABLE runtime_profiles ADD COLUMN runtime_limit_updated_at TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_limit_snapshot_json TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_limit_updated_at TEXT;
    `,
  },
  {
    version: 14,
    description: "Add app_settings singleton table and extend runtime-profile cleanup coverage",
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
        default_task_runtime_profile_id TEXT,
        default_plan_runtime_profile_id TEXT,
        default_review_runtime_profile_id TEXT,
        default_chat_runtime_profile_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT OR IGNORE INTO app_settings (id) VALUES (1);
      DROP TRIGGER IF EXISTS trg_runtime_profiles_delete;
    `,
    triggers: [
      `CREATE TRIGGER IF NOT EXISTS trg_runtime_profiles_delete
       AFTER DELETE ON runtime_profiles
       FOR EACH ROW
       BEGIN
         UPDATE tasks SET runtime_profile_id = NULL WHERE runtime_profile_id = OLD.id;
         UPDATE projects SET default_task_runtime_profile_id = NULL WHERE default_task_runtime_profile_id = OLD.id;
         UPDATE projects SET default_plan_runtime_profile_id = NULL WHERE default_plan_runtime_profile_id = OLD.id;
         UPDATE projects SET default_review_runtime_profile_id = NULL WHERE default_review_runtime_profile_id = OLD.id;
         UPDATE projects SET default_chat_runtime_profile_id = NULL WHERE default_chat_runtime_profile_id = OLD.id;
         UPDATE chat_sessions SET runtime_profile_id = NULL WHERE runtime_profile_id = OLD.id;
         UPDATE app_settings
         SET
           default_task_runtime_profile_id = CASE
             WHEN default_task_runtime_profile_id = OLD.id THEN NULL
             ELSE default_task_runtime_profile_id
           END,
           default_plan_runtime_profile_id = CASE
             WHEN default_plan_runtime_profile_id = OLD.id THEN NULL
             ELSE default_plan_runtime_profile_id
           END,
           default_review_runtime_profile_id = CASE
             WHEN default_review_runtime_profile_id = OLD.id THEN NULL
             ELSE default_review_runtime_profile_id
           END,
           default_chat_runtime_profile_id = CASE
             WHEN default_chat_runtime_profile_id = OLD.id THEN NULL
             ELSE default_chat_runtime_profile_id
           END,
           updated_at = CASE
             WHEN default_task_runtime_profile_id = OLD.id
               OR default_plan_runtime_profile_id = OLD.id
               OR default_review_runtime_profile_id = OLD.id
               OR default_chat_runtime_profile_id = OLD.id
             THEN (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ELSE updated_at
           END
         WHERE id = 1;
       END`,
    ],
  },
  {
    version: 15,
    description:
      "Re-apply runtime limit snapshot columns for DBs that skipped v13 due to branch-merge re-ordering",
    sql: `
      ALTER TABLE runtime_profiles ADD COLUMN runtime_limit_snapshot_json TEXT;
      ALTER TABLE runtime_profiles ADD COLUMN runtime_limit_updated_at TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_limit_snapshot_json TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_limit_updated_at TEXT;
    `,
  },
  {
    version: 17,
    description: "Add Codex index read-model tables for session and usage-limit overlays",
    sql: `
      CREATE TABLE IF NOT EXISTS codex_sessions (
        session_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        title TEXT,
        project_root TEXT,
        account_fingerprint TEXT,
        source_created_at TEXT,
        source_updated_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        preview_text TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        last_indexed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS codex_session_files (
        file_path TEXT PRIMARY KEY,
        session_id TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        parsed_offset INTEGER NOT NULL DEFAULT 0,
        pending_tail TEXT NOT NULL DEFAULT '',
        missing INTEGER NOT NULL DEFAULT 0,
        import_version INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS codex_limit_heads (
        head_key TEXT PRIMARY KEY,
        account_fingerprint TEXT NOT NULL,
        project_root TEXT,
        limit_id TEXT NOT NULL,
        model TEXT,
        source TEXT NOT NULL DEFAULT 'codex',
        snapshot_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        session_id TEXT,
        file_path TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS codex_limit_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        head_key TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL,
        project_root TEXT,
        limit_id TEXT NOT NULL,
        model TEXT,
        snapshot_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        session_id TEXT,
        file_path TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS codex_index_cursors (
        cursor_key TEXT PRIMARY KEY,
        cursor_value TEXT,
        cursor_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    version: 18,
    description: "Drop unused Codex session-file dirty-scan index",
    sql: `
      DROP INDEX IF EXISTS idx_codex_session_files_dirty;
    `,
  },
  {
    version: 19,
    description:
      "Persist feature branch name per task so HANDOFF_MODE auto-queue can route implementer back to the right branch",
    sql: "ALTER TABLE tasks ADD COLUMN branch_name TEXT",
  },
  {
    version: 20,
    description: "Persist per-task git worktree path for parallel auto-queue isolation",
    sql: "ALTER TABLE tasks ADD COLUMN worktree_path TEXT",
  },
  {
    version: 21,
    description: "Add runtime warmup session persistence",
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_warmup_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        runtime_profile_id TEXT,
        runtime_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        transport TEXT,
        model TEXT,
        source_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'creating',
        ttl_seconds INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        summary TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    version: 22,
    description: "Add stage-scoped active runtime selection to tasks",
    sql: `
      ALTER TABLE tasks ADD COLUMN active_runtime_status TEXT;
      ALTER TABLE tasks ADD COLUMN active_runtime_selection_json TEXT;
    `,
  },
  {
    version: 23,
    description: "Add QA fields to tasks (autoQa toggle, three QA artifacts, qaStatus)",
    sql: `
      ALTER TABLE tasks ADD COLUMN auto_qa INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN qa_change_summary TEXT;
      ALTER TABLE tasks ADD COLUMN qa_test_plan TEXT;
      ALTER TABLE tasks ADD COLUMN qa_test_cases TEXT;
      ALTER TABLE tasks ADD COLUMN qa_status TEXT NOT NULL DEFAULT 'idle';
    `,
  },
  {
    version: 24,
    description: "Add optional skills-mode improve and verify task flags",
    sql: `
      ALTER TABLE tasks ADD COLUMN run_plan_improve INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN run_post_verify INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 25,
    description: "Add project pinning and flat grouping",
    sql: `
      ALTER TABLE projects ADD COLUMN pinned_at TEXT;
      ALTER TABLE projects ADD COLUMN group_name TEXT;
    `,
  },
  {
    version: 26,
    description: "Persist restart-safe auto-queue commit state and task commit SHA",
    sql: `
      ALTER TABLE tasks ADD COLUMN auto_queue_commit_status TEXT;
      ALTER TABLE tasks ADD COLUMN auto_queue_commit_base_sha TEXT;
      ALTER TABLE tasks ADD COLUMN commit_sha TEXT;
      ALTER TABLE tasks ADD COLUMN auto_queue_commit_error TEXT;
      ALTER TABLE tasks ADD COLUMN auto_queue_commit_completed_at TEXT;
    `,
  },
  {
    version: 27,
    description: "Add participant identity, sessions, task ownership, history, and audit model",
    sql: `
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        normalized_username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        active INTEGER NOT NULL DEFAULT 1,
        deactivated_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS participant_sessions (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE,
        csrf_token_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      ALTER TABLE tasks ADD COLUMN execution_owner TEXT NOT NULL DEFAULT 'ai';
      ALTER TABLE tasks ADD COLUMN ownership_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE task_comments ADD COLUMN participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL;
      CREATE TABLE IF NOT EXISTS task_assignments (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        assigned_by_kind TEXT NOT NULL,
        assigned_by_id TEXT,
        assigned_by_display_name_snapshot TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (task_id, participant_id)
      );
      CREATE TABLE IF NOT EXISTS task_executor_history (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_title_snapshot TEXT NOT NULL,
        ownership_revision INTEGER NOT NULL,
        execution_owner TEXT NOT NULL,
        assignees_snapshot_json TEXT NOT NULL DEFAULT '[]',
        status_snapshot TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        actor_display_name_snapshot TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        task_id TEXT,
        task_title_snapshot TEXT,
        participant_id TEXT,
        participant_display_name_snapshot TEXT,
        execution_owner_snapshot TEXT,
        assignees_snapshot_json TEXT,
        status_snapshot TEXT,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        actor_display_name_snapshot TEXT,
        reason TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
    backfill: backfillParticipantOwnership,
    triggers: [
      `CREATE TRIGGER IF NOT EXISTS trg_task_executor_history_prevent_update
       BEFORE UPDATE ON task_executor_history
       FOR EACH ROW
       BEGIN
         SELECT RAISE(ABORT, 'task_executor_history is append-only');
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_task_executor_history_prevent_delete
       BEFORE DELETE ON task_executor_history
       FOR EACH ROW
       BEGIN
         SELECT RAISE(ABORT, 'task_executor_history is append-only');
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_audit_events_prevent_update
       BEFORE UPDATE ON audit_events
       FOR EACH ROW
       BEGIN
         SELECT RAISE(ABORT, 'audit_events is append-only');
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_audit_events_prevent_delete
       BEFORE DELETE ON audit_events
       FOR EACH ROW
       BEGIN
         SELECT RAISE(ABORT, 'audit_events is append-only');
       END`,
    ],
  },
  {
    version: 28,
    description: "Add restart-safe GitHub repository, issue, and pull-request linkage",
    sql: `
      CREATE TABLE IF NOT EXISTS github_repositories (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        html_url TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        token_env_var TEXT NOT NULL DEFAULT 'GITHUB_TOKEN',
        eligibility_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_synced_at TEXT,
        sync_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS github_issues (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue_number INTEGER NOT NULL,
        task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
        node_id TEXT NOT NULL,
        html_url TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        source_updated_at TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        sync_error TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        pr_state TEXT CHECK (pr_state IS NULL OR pr_state IN ('open', 'closed', 'merged')),
        pr_checks_status TEXT CHECK (pr_checks_status IS NULL OR pr_checks_status IN ('pending', 'success', 'failure')),
        review_state TEXT CHECK (review_state IS NULL OR review_state IN ('pending', 'approved', 'changes_requested')),
        last_review_id INTEGER,
        review_fingerprint TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (project_id, issue_number)
      );
    `,
  },
  {
    version: 29,
    description: "Add restart-safe GitLab repository, issue, and merge-request linkage",
    sql: `
      CREATE TABLE IF NOT EXISTS gitlab_repositories (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        web_url TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        token_env_var TEXT NOT NULL DEFAULT 'GITLAB_TOKEN',
        eligibility_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_synced_at TEXT,
        sync_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS gitlab_issues (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        iid INTEGER NOT NULL,
        task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
        global_id TEXT NOT NULL,
        web_url TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        source_updated_at TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        sync_error TEXT,
        mr_iid INTEGER,
        mr_url TEXT,
        mr_state TEXT CHECK (mr_state IS NULL OR mr_state IN ('open', 'closed', 'merged')),
        mr_checks_status TEXT CHECK (mr_checks_status IS NULL OR mr_checks_status IN ('pending', 'success', 'failure')),
        review_state TEXT CHECK (review_state IS NULL OR review_state IN ('pending', 'approved')),
        review_fingerprint TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (project_id, iid)
      );
    `,
  },
  {
    version: 30,
    description: "Track when a GitLab repository was auto-prepared (git_prepared_at)",
    sql: `
      ALTER TABLE gitlab_repositories ADD COLUMN git_prepared_at TEXT;
    `,
  },
  {
    version: 31,
    description: "Add task activity progress columns (last_activity_at, current_tool_json)",
    sql: `
      ALTER TABLE tasks ADD COLUMN last_activity_at TEXT;
      ALTER TABLE tasks ADD COLUMN current_tool_json TEXT;
    `,
  },
  {
    version: 32,
    description: "Track last-processed GitLab review note id for request-changes edge trigger",
    sql: `
      ALTER TABLE gitlab_issues ADD COLUMN last_review_note_id INTEGER;
    `,
  },
  {
    version: 33,
    description: "Add plan review gate columns to tasks and PR/MR mode to VCS issue links",
    sql: `
      ALTER TABLE tasks ADD COLUMN plan_review_state TEXT;
      ALTER TABLE tasks ADD COLUMN plan_review_commit_sha TEXT;
      ALTER TABLE tasks ADD COLUMN plan_review_published_at TEXT;
      ALTER TABLE tasks ADD COLUMN plan_review_approved_at TEXT;
      ALTER TABLE tasks ADD COLUMN plan_review_feedback TEXT;
      ALTER TABLE github_issues ADD COLUMN pr_mode TEXT DEFAULT 'implementation';
      ALTER TABLE gitlab_issues ADD COLUMN mr_mode TEXT DEFAULT 'implementation';
    `,
  },
  {
    version: 34,
    description: "Backfill plan_ready status values to plan_review",
    sql: `
      UPDATE tasks SET status = 'plan_review' WHERE status = 'plan_ready';
    `,
    backfill: (sqlite) => {
      const statusCount = sqlite
        .prepare("UPDATE tasks SET status = 'plan_review' WHERE status = 'plan_ready'")
        .run().changes;
      // В схемах до v27 колонки blocked_from_status может не быть; при отсутствии безопасно пропускаем.
      let blockedCount = 0;
      try {
        blockedCount = sqlite
          .prepare(
            "UPDATE tasks SET blocked_from_status = 'plan_review' WHERE blocked_from_status = 'plan_ready'",
          )
          .run().changes;
      } catch {
        blockedCount = 0;
      }
      return { statusUpdated: statusCount, blockedFromStatusUpdated: blockedCount };
    },
  },
  {
    version: 35,
    description: "Track when a GitHub repository was auto-prepared (git_prepared_at)",
    sql: `
      ALTER TABLE github_repositories ADD COLUMN git_prepared_at TEXT;
    `,
  },
];

// Простое разбиение по точке с запятой. Годится только для DDL без вложенных ";" - тела
// триггеров по этой причине передаются отдельным полем triggers.
function splitSqlStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

// Повторное применение уже выполненного DDL ошибкой не считается. Признак берётся из
// текста сообщения драйвера: другого источника у SQLite нет, поэтому список вариантов
// должен покрывать все формы, которые драйвер выдаёт при дублировании колонки или объекта.
function isIgnorableMigrationError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("duplicate column name") || message.includes("already exists");
}

// Применение миграций от текущей версии к последней. Все они выполняются в одной
// транзакции вместе с обновлением user_version: прерывание на середине откатит изменения
// целиком, и база не останется в состоянии "часть схемы новая, часть нет".
function runMigrations(sqlite: Database.Database): void {
  const currentVersion = (sqlite.pragma("user_version", { simple: true }) as number) ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    // Чистая база уже создана через CREATE TABLE IF NOT EXISTS с полной актуальной схемой,
    // поэтому прогонять по ней все миграции незачем - достаточно отметить последнюю версию.
    // Для свежих баз (user_version=0), только что созданных через CREATE TABLE IF NOT EXISTS
    // (схема уже включает session_id), выставляется последняя версия, чтобы пропустить миграции.
    if (currentVersion === 0 && MIGRATIONS.length > 0) {
      const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
      sqlite.pragma(`user_version = ${latest}`);
    }
    return;
  }

  log.info({ currentVersion, pendingCount: pending.length }, "Running database migrations");

  const runAll = sqlite.transaction(() => {
    for (const migration of pending) {
      const statements = splitSqlStatements(migration.sql);
      for (const statement of statements) {
        try {
          sqlite.exec(statement);
        } catch (err) {
          if (isIgnorableMigrationError(err)) {
            log.debug(
              { version: migration.version, statement },
              "Migration statement already applied, skipping",
            );
            continue;
          }
          throw err;
        }
      }
      const backfillCounts = migration.backfill?.(sqlite);
      if (backfillCounts) {
        log.info(
          { version: migration.version, ...backfillCounts },
          "Migration data backfill complete",
        );
      }
      for (const trigger of migration.triggers ?? []) {
        try {
          sqlite.exec(trigger);
        } catch (err) {
          if (isIgnorableMigrationError(err)) {
            log.debug({ version: migration.version }, "Trigger already exists, skipping");
            continue;
          }
          throw err;
        }
      }
      log.info(
        { version: migration.version, description: migration.description },
        "Migration applied",
      );
    }
    const latest = pending[pending.length - 1].version;
    sqlite.pragma(`user_version = ${latest}`);
  });

  runAll();
  log.info({ newVersion: pending[pending.length - 1].version }, "Migrations complete");
}

// Проверка наличия колонки. Нужна в backfill-функциях, где требуется SQL, совместимый и
// со старой, и с новой схемой.
function hasColumn(sqlite: Database.Database, tableName: string, columnName: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

// Идемпотентные доработки данных, применяемые к любой базе независимо от версии:
// заполнение значений по умолчанию и восстановление полей после расхождений прошлых
// версий. Запускается на каждом открытии базы, поэтому все операции обязаны быть
// повторяемыми.
function runRuntimeBackfills(sqlite: Database.Database): void {
  if (hasColumn(sqlite, "app_settings", "id")) {
    const appSettingsBackfill = sqlite
      .prepare(
        `
        INSERT OR IGNORE INTO app_settings (id)
        VALUES (1)
      `,
      )
      .run();
    log.info(
      { backfilledRows: appSettingsBackfill.changes },
      "Backfilled singleton app_settings row",
    );
  }

  if (hasColumn(sqlite, "chat_sessions", "runtime_session_id")) {
    const sessionBackfill = sqlite
      .prepare(
        `
        UPDATE chat_sessions
        SET runtime_session_id = agent_session_id
        WHERE runtime_session_id IS NULL
          AND agent_session_id IS NOT NULL
      `,
      )
      .run();
    log.info(
      { backfilledRows: sessionBackfill.changes },
      "Backfilled runtime_session_id from legacy agent_session_id",
    );
  }

  if (hasColumn(sqlite, "runtime_profiles", "headers_json")) {
    const headersBackfill = sqlite
      .prepare(
        `
        UPDATE runtime_profiles
        SET headers_json = '{}'
        WHERE headers_json IS NULL OR trim(headers_json) = ''
      `,
      )
      .run();
    log.info(
      { backfilledRows: headersBackfill.changes },
      "Backfilled runtime profile headers_json defaults",
    );
  }

  if (hasColumn(sqlite, "runtime_profiles", "options_json")) {
    const optionsBackfill = sqlite
      .prepare(
        `
        UPDATE runtime_profiles
        SET options_json = '{}'
        WHERE options_json IS NULL OR trim(options_json) = ''
      `,
      )
      .run();
    log.info(
      { backfilledRows: optionsBackfill.changes },
      "Backfilled runtime profile options_json defaults",
    );
  }

  if (hasColumn(sqlite, "runtime_profiles", "enabled")) {
    const enabledBackfill = sqlite
      .prepare(
        `
        UPDATE runtime_profiles
        SET enabled = 1
        WHERE enabled IS NULL
      `,
      )
      .run();
    log.info(
      { backfilledRows: enabledBackfill.changes },
      "Backfilled runtime profile enabled defaults",
    );
  }

  if (hasColumn(sqlite, "tasks", "manual_review_required")) {
    const manualReviewBackfill = sqlite
      .prepare(
        `
        UPDATE tasks
        SET manual_review_required = 0
        WHERE manual_review_required IS NULL
      `,
      )
      .run();
    log.info(
      { backfilledRows: manualReviewBackfill.changes },
      "Backfilled task manual_review_required defaults",
    );
  }

  if (hasColumn(sqlite, "runtime_profiles", "runtime_limit_snapshot_json")) {
    const runtimeProfileLimitBackfill = sqlite
      .prepare(
        `
        UPDATE runtime_profiles
        SET runtime_limit_snapshot_json = NULL
        WHERE runtime_limit_snapshot_json IS NOT NULL
          AND trim(runtime_limit_snapshot_json) = ''
      `,
      )
      .run();
    log.info(
      { backfilledRows: runtimeProfileLimitBackfill.changes },
      "Backfilled runtime profile empty runtime_limit_snapshot_json values",
    );
  }

  if (hasColumn(sqlite, "tasks", "runtime_limit_snapshot_json")) {
    const taskLimitBackfill = sqlite
      .prepare(
        `
        UPDATE tasks
        SET runtime_limit_snapshot_json = NULL
        WHERE runtime_limit_snapshot_json IS NOT NULL
          AND trim(runtime_limit_snapshot_json) = ''
      `,
      )
      .run();
    log.info(
      { backfilledRows: taskLimitBackfill.changes },
      "Backfilled task empty runtime_limit_snapshot_json values",
    );
  }
}

/** Идемпотентная инициализация триггеров — гарантирует триггеры каскадной очистки при каждом запуске. */
// Триггеры каскадной очистки. Внешние ключи в SQLite не удаляют зависимые строки сами,
// поэтому целостность обеспечивается триггерами.
function ensureTriggers(sqlite: Database.Database): void {
  const allTriggers = MIGRATIONS.flatMap((m) => m.triggers ?? []);
  for (const trigger of allTriggers) {
    try {
      sqlite.exec(trigger);
    } catch (err) {
      if (isIgnorableMigrationError(err)) continue;
      log.error({ err }, "Trigger bootstrap failed");
    }
  }
  if (allTriggers.length > 0) {
    log.debug({ triggerCount: allTriggers.length }, "Trigger bootstrap complete");
  }
}

/** Идемпотентная инициализация индексов для часто используемых шаблонов запросов. */
// Индексы создаются отдельным проходом, а не в CREATE TABLE: так их можно добавлять к уже
// существующим базам, не меняя таблицы.
function ensureIndexes(sqlite: Database.Database): void {
  const indexDefs = [
    // Координатор выбирает задачи по статусу
    "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)",
    // Повторные попытки координатора: blocked_external с наступившим retry_after
    "CREATE INDEX IF NOT EXISTS idx_tasks_retry_after ON tasks(retry_after)",
    // Запросы списка задач с фильтром по проекту
    "CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)",
    // Составной: координатор фильтрует status + retry_after вместе
    "CREATE INDEX IF NOT EXISTS idx_tasks_status_retry ON tasks(status, retry_after)",
    // Составной: порядок списка задач в проекте по статусу и позиции
    "CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, position)",
    // Фильтры задач координатора и участника с учётом владельца
    "CREATE INDEX IF NOT EXISTS idx_tasks_execution_owner_status ON tasks(execution_owner, status)",
    // Поиск комментариев по задаче
    "CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_comments_participant_id ON task_comments(participant_id)",
    // Идентификация участников и администрирование активной роли
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_normalized_username ON participants(normalized_username)",
    "CREATE INDEX IF NOT EXISTS idx_participants_active_role ON participants(active, role)",
    // Разрешение токена сессии и отзыв всех сессий участника
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_sessions_token_digest ON participant_sessions(token_digest)",
    "CREATE INDEX IF NOT EXISTS idx_participant_sessions_participant ON participant_sessions(participant_id, revoked_at, expires_at)",
    // Текущее назначение задачи и фильтры задач участника
    "CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_assignments_participant ON task_assignments(participant_id, task_id)",
    // Неизменяемая лента исполнителей и запросы аудита
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executor_history_revision ON task_executor_history(task_id, ownership_revision)",
    "CREATE INDEX IF NOT EXISTS idx_task_executor_history_created ON task_executor_history(task_id, created_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_events_task ON audit_events(task_id, created_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_events_participant ON audit_events(participant_id, created_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_kind, actor_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_github_issues_task ON github_issues(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_github_issues_pr ON github_issues(project_id, pr_number)",
    // Блокировки задач: поиск свободных или задач с устаревшей блокировкой
    "CREATE INDEX IF NOT EXISTS idx_tasks_locked ON tasks(locked_by, locked_until)",
    // Отложенные задачи координатора: backlog с наступившим scheduled_at
    "CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(scheduled_at, status)",
    // Выбор runtime-профиля по области проекта
    "CREATE INDEX IF NOT EXISTS idx_runtime_profiles_project_id ON runtime_profiles(project_id)",
    // Выбор runtime-профиля по runtime/provider
    "CREATE INDEX IF NOT EXISTS idx_runtime_profiles_runtime ON runtime_profiles(runtime_id, provider_id)",
    // Поиск runtime-профиля для задач
    "CREATE INDEX IF NOT EXISTS idx_tasks_runtime_profile_id ON tasks(runtime_profile_id)",
    // Поиск runtime-профиля для сессий чата
    "CREATE INDEX IF NOT EXISTS idx_chat_sessions_runtime_profile_id ON chat_sessions(runtime_profile_id)",
    // События учёта по областям для агрегирующих запросов по сущностям и дашбордов
    "CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_usage_events_task ON usage_events(task_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_usage_events_chat_session ON usage_events(chat_session_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events(source, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_usage_events_runtime ON usage_events(runtime_id, provider_id, created_at)",
    // Поиск разогрева runtime-сессий и сканирования жизненного цикла.
    "CREATE INDEX IF NOT EXISTS idx_runtime_warmup_active_lookup ON runtime_warmup_sessions(project_id, runtime_profile_id, runtime_id, provider_id, transport, model, status, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_runtime_warmup_expires ON runtime_warmup_sessions(status, expires_at)",
    // Индекс Codex: перечень сессий проекта и поиск деталей сессии.
    "CREATE INDEX IF NOT EXISTS idx_codex_sessions_project_root_updated ON codex_sessions(project_root, source_updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_codex_sessions_file_path ON codex_sessions(file_path)",
    // Сверка состояния файлов Codex.
    "CREATE INDEX IF NOT EXISTS idx_codex_session_files_session_id ON codex_session_files(session_id)",
    // Поиск последнего head Codex и ограниченной истории.
    "CREATE INDEX IF NOT EXISTS idx_codex_limit_heads_lookup ON codex_limit_heads(account_fingerprint, project_root, limit_id, observed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_codex_limit_history_head ON codex_limit_history(head_key, observed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_codex_limit_history_account ON codex_limit_history(account_fingerprint, project_root, limit_id, observed_at DESC)",
  ];

  for (const ddl of indexDefs) {
    try {
      sqlite.exec(ddl);
    } catch (err) {
      log.error({ err, ddl }, "Index bootstrap failed");
    }
  }

  log.info({ indexCount: indexDefs.length }, "Index bootstrap complete");
  log.debug(
    { indexes: indexDefs.map((d) => d.match(/idx_\w+/)?.[0] ?? d) },
    "Indexes created/verified",
  );
}

/** Создаёт новую базу в памяти — удобно для тестов */
// База в памяти для тестов: без файла и без миграций. Схема поднимается тем же
// ensureTables, что и в рабочем режиме, поэтому тесты проверяют реальную структуру.
export function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureTables(sqlite);
  // ensureTables уже вызывает ensureIndexes в конце

  const db = drizzle(sqlite, { schema });
  log.debug("Created in-memory test database");

  return db;
}

// Закрытие соединения. Ссылки обнуляются, чтобы следующий getDb открыл базу заново: это
// нужно тестам и корректному завершению процесса.
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    log.debug("Database connection closed");
  }
}
