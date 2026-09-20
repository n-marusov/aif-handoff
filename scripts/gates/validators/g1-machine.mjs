// G1-MACHINE — машинная читаемость каталога контрактов.
//
// Проверяет, что `docs/contracts/INDEX.yaml` существует, корректно парсится,
// содержит обязательные поля и согласован с реестром `docs/contracts/README.md`
// (все `contract-*` ID из таблицы зарегистрированы в YAML).

import { join } from "node:path";

import { displayPath, loadYaml, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-MACHINE", name: "Машинная читаемость", group: "G1" };

const INDEX_YAML = "docs/contracts/INDEX.yaml";
const README_MD = "docs/contracts/README.md";

const REQUIRED_FIELDS = ["id", "name", "type", "format", "status"];
const ALLOWED_TYPES = new Set(["typescript", "rest", "websocket", "sql", "schedule", "git"]);
const ALLOWED_FORMATS = new Set(["ts-types", "openapi-3.1", "custom-yaml", "drizzle-orm"]);

export async function run({ repoRoot }) {
  const checks = [];
  const yamlPath = join(repoRoot, INDEX_YAML);
  const parsed = loadYaml(yamlPath);

  if (parsed === null) {
    checks.push({
      scope: INDEX_YAML,
      status: "fail",
      message: `файл ${INDEX_YAML} не существует`,
    });
    return { checks, summary: "INDEX.yaml missing" };
  }

  if (parsed.parseError !== undefined) {
    checks.push({
      scope: INDEX_YAML,
      status: "fail",
      message: `ошибка парсинга YAML: ${parsed.parseError}`,
    });
    return { checks, summary: "INDEX.yaml parse error" };
  }

  if (!Array.isArray(parsed)) {
    checks.push({
      scope: INDEX_YAML,
      status: "fail",
      message: "корневой элемент не является списком контрактов",
    });
    return { checks, summary: "INDEX.yaml not a list" };
  }

  const seenIds = new Set();
  for (const contract of parsed) {
    if (typeof contract !== "object" || contract === null) {
      checks.push({ scope: INDEX_YAML, status: "fail", message: "запись не является объектом" });
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (contract[field] === undefined) {
        checks.push({
          scope: INDEX_YAML,
          status: "fail",
          message: `контракт ${contract.id ?? "<без id>"} без обязательного поля ${field}`,
        });
      }
    }
    if (contract.type !== undefined && !ALLOWED_TYPES.has(contract.type)) {
      checks.push({
        scope: INDEX_YAML,
        status: "fail",
        message: `контракт ${contract.id} использует неизвестный type ${contract.type}`,
      });
    }
    if (contract.format !== undefined && !ALLOWED_FORMATS.has(contract.format)) {
      checks.push({
        scope: INDEX_YAML,
        status: "fail",
        message: `контракт ${contract.id} использует неизвестный format ${contract.format}`,
      });
    }
    if (contract.id !== undefined) {
      if (!/^contract-[a-z0-9-]+$/.test(contract.id)) {
        checks.push({
          scope: INDEX_YAML,
          status: "fail",
          message: `id ${contract.id} не соответствует схеме contract-<slug>`,
        });
      }
      if (seenIds.has(contract.id)) {
        checks.push({
          scope: INDEX_YAML,
          status: "fail",
          message: `дубликат id ${contract.id}`,
        });
      }
      seenIds.add(contract.id);
    }
  }

  // Согласованность с README-реестром: каждый `contract-*` в README есть в YAML.
  const readmeSource = readText(join(repoRoot, README_MD)) ?? "";
  for (const match of readmeSource.matchAll(/`(contract-[a-z0-9-]+)`/g)) {
    const id = match[1];
    if (!seenIds.has(id)) {
      checks.push({
        scope: README_MD,
        status: "fail",
        message: `контракт ${id} есть в реестре README, но отсутствует в ${INDEX_YAML}`,
      });
    }
  }

  if (checks.length === 0) {
    log.info(`G1-MACHINE: INDEX.yaml корректен (${seenIds.size} контрактов)`);
  } else {
    log.warn(`G1-MACHINE: ${checks.length} замечаний`);
  }

  return {
    checks,
    summary: `INDEX.yaml: ${seenIds.size} contracts, ${checks.length} issues`,
  };
}
