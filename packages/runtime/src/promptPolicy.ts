import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { RuntimeTransport, type RuntimeCapabilities } from "./types.js";
import type { RuntimeWorkflowSpec } from "./workflowSpec.js";
import {
  CODEX_SUBAGENT_STRATEGIES,
  getNativeSubagentWorkflowGuidance,
  resolveCodexNativeSubagentReadiness,
  resolveCodexSubagentStrategy,
} from "./adapters/codex/subagentStrategy.js";

export interface RuntimePromptPolicyLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface RuntimePromptPolicyInput {
  runtimeId: string;
  projectRoot?: string | null;
  capabilities: RuntimeCapabilities;
  runtimeOptions?: Record<string, unknown>;
  workflow: RuntimeWorkflowSpec;
  codexNativeSubagentsEnabled?: boolean;
  logger?: RuntimePromptPolicyLogger;
  transport?: RuntimeTransport;
}

export interface RuntimePromptPolicyResult {
  prompt: string;
  systemPromptAppend: string;
  agentDefinitionName?: string;
  usedFallbackSlashCommand: boolean;
  usedIsolatedSkillCommand: boolean;
  usedNativeSubagentWorkflow: boolean;
  usedApiSkillExpansion: boolean;
  nativeSubagentFallbackReason?: string;
}

const DEFAULT_SKILL_PREFIX = "/";

/**
 * Pattern matching skill command invocations in prompts.
 * Matches "/aif-<name>" at word boundaries (start of line or after whitespace).
 * The pattern captures the "/" prefix so it can be replaced with the runtime-specific prefix.
 */
const SKILL_COMMAND_PATTERN = /(?<=^|\s)\/(?=aif-)/gm;

/**
 * Transform skill command prefixes in text from the default "/" to the runtime-specific prefix.
 * Only transforms when the target prefix differs from the default.
 */
export function transformSkillCommandPrefix(text: string, prefix: string): string {
  if (!prefix || prefix === DEFAULT_SKILL_PREFIX) return text;
  return text.replace(SKILL_COMMAND_PATTERN, prefix);
}

function prependSlashFallbackPrompt(prompt: string, fallbackSlashCommand: string): string {
  const trimmedCommand = fallbackSlashCommand.trim();
  if (!trimmedCommand) return prompt;

  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.startsWith(trimmedCommand)) return prompt;
  return `${trimmedCommand}\n\n${prompt}`;
}

const API_SKILL_COMMAND_PATTERN = /^\/(aif-[a-z0-9-]+)(?:\s|$)/i;

const API_SKILL_FALLBACKS: Record<string, string> = {
  "aif-plan":
    "Create or refine an implementation-ready markdown checklist plan. Planning is read-only: do not create, modify, or delete project files and do not execute implementation steps. Return actionable unchecked items using '- [ ]'.",
  "aif-improve":
    "Improve the existing implementation plan only. Do not implement code or modify product files. Preserve the plan structure and return actionable unchecked checklist items.",
  "aif-implement":
    "Implement the requested plan in the current workspace. Make only task-scoped changes, run relevant tests, and report the files changed and validation performed.",
  "aif-review":
    "Review the current task diff for correctness, security, regressions, and missing tests. Do not modify files. Return concrete findings with severity and file references.",
  "aif-security-checklist":
    "Perform a read-only OWASP-oriented security review of the current task diff. Do not modify files. Return concrete findings with severity, evidence, and remediation.",
  "aif-verify":
    "Verify the requested implementation and its tests. Do not modify files. Report blockers, missing work, and validation results in a structured verification summary.",
  "aif-fix":
    "Analyze the reported bug and produce a fix plan only unless the command explicitly requests implementation. For plan-first mode, do not modify files and return an unchecked actionable checklist.",
};

function readApiSkillInstructions(
  projectRoot: string | null | undefined,
  skillName: string,
): { content: string; source: "project" | "fallback" } {
  const fallback =
    API_SKILL_FALLBACKS[skillName] ??
    "Follow the requested workflow as a read-only planning or review task unless the prompt explicitly grants implementation permission. Do not claim to have used tools or changed files when no workspace tool is available.";
  if (!projectRoot) return { content: fallback, source: "fallback" };

  const skillPath = resolve(projectRoot, ".agents", "skills", skillName, "SKILL.md");
  const relativeSkillPath = relative(resolve(projectRoot), skillPath);
  if (relativeSkillPath.startsWith("..") || relativeSkillPath.includes("..")) {
    return { content: fallback, source: "fallback" };
  }
  try {
    if (!existsSync(skillPath)) return { content: fallback, source: "fallback" };
    const content = readFileSync(skillPath, "utf8").trim();
    return content.length > 0
      ? { content, source: "project" }
      : { content: fallback, source: "fallback" };
  } catch {
    return { content: fallback, source: "fallback" };
  }
}

function expandApiSkillCommand(
  prompt: string,
  fallbackSlashCommand: string,
  projectRoot: string | null | undefined,
  logger?: RuntimePromptPolicyLogger,
): string {
  const commandMatch = fallbackSlashCommand.trim().match(API_SKILL_COMMAND_PATTERN);
  if (!commandMatch) return prompt;

  const skillName = commandMatch[1].toLowerCase();
  const skill = readApiSkillInstructions(projectRoot, skillName);
  const command = fallbackSlashCommand.trim();
  logger?.debug?.(
    { skillName, source: skill.source, projectRoot: projectRoot ?? null },
    skill.source === "project"
      ? "[FIX] Expanded API slash command into skill instructions"
      : "[FIX] API slash command skill file unavailable; using safe inline fallback",
  );

  return [
    "API transport workflow contract:",
    "The following slash command is a workflow label, not an executable command. Do not claim that the slash command ran and do not invent tool output.",
    `Requested workflow command: ${command}`,
    "",
    "Skill instructions:",
    skill.content,
    "",
    "Apply the workflow instructions to the task context below. The API model has no local workspace tools unless the prompt explicitly provides their results.",
    prompt,
  ].join("\n");
}

function prependNativeSubagentPrompt(
  workflow: RuntimeWorkflowSpec,
  prompt: string,
  agentDefinitionName: string,
): string {
  const agentReference = `Spawn the custom Codex agent "${agentDefinitionName}" and delegate this workflow to it.`;
  const workflowSpecificGuidance = getNativeSubagentWorkflowGuidance(workflow.workflowKind);

  return [
    "Use Codex native subagents for this workflow.",
    agentReference,
    "Wait for delegated work to complete before producing the final answer.",
    "Do not use slash or skill commands as the primary execution mechanism when native subagents are available.",
    workflowSpecificGuidance,
    "",
    prompt,
  ].join("\n");
}

export function resolveRuntimePromptPolicy(
  input: RuntimePromptPolicyInput,
): RuntimePromptPolicyResult {
  const canUseAgentDefinition = Boolean(
    input.workflow.agentDefinitionName && input.capabilities.supportsAgentDefinitions,
  );
  const wantsNativeSubagentWorkflow = input.workflow.executionMode === "native_subagents";
  const wantsIsolatedSkillCommand = input.workflow.executionMode === "isolated_skill_session";
  const wantsSlashFallback = input.workflow.fallbackStrategy === "slash_command";
  const codexSubagentStrategy = resolveCodexSubagentStrategy(
    input.runtimeId,
    input.runtimeOptions,
    { nativeSubagentsEnabled: input.codexNativeSubagentsEnabled === true },
  );
  const codexNativeReadiness =
    input.runtimeId === "codex" ? resolveCodexNativeSubagentReadiness(input.projectRoot) : null;
  const supportsIsolatedSkillCommand = Boolean(
    input.capabilities.supportsIsolatedSubagentWorkflows,
  );
  const supportsNativeSubagentWorkflow =
    codexSubagentStrategy.strategy === CODEX_SUBAGENT_STRATEGIES.native &&
    Boolean(input.capabilities.supportsNativeSubagentWorkflows) &&
    (input.runtimeId !== "codex" || codexNativeReadiness?.ready === true);
  const hasFallbackCommand = Boolean(input.workflow.promptInput.fallbackSlashCommand?.trim());
  const hasNativeAgentName = Boolean(input.workflow.agentDefinitionName?.trim());
  const useNativeSubagentWorkflow =
    !canUseAgentDefinition &&
    wantsNativeSubagentWorkflow &&
    supportsNativeSubagentWorkflow &&
    hasNativeAgentName;
  const useIsolatedSkillCommand =
    !canUseAgentDefinition &&
    (wantsIsolatedSkillCommand ||
      (wantsNativeSubagentWorkflow && !useNativeSubagentWorkflow && wantsSlashFallback)) &&
    supportsIsolatedSkillCommand &&
    hasFallbackCommand;
  const useSlashFallback =
    !canUseAgentDefinition &&
    wantsSlashFallback &&
    hasFallbackCommand &&
    !useNativeSubagentWorkflow &&
    !useIsolatedSkillCommand;

  if (!canUseAgentDefinition && input.workflow.agentDefinitionName) {
    input.logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        agentDefinitionName: input.workflow.agentDefinitionName,
        hasFallbackCommand,
      },
      "Runtime does not support agent definitions, checking workflow fallback strategy",
    );
  }
  if (wantsNativeSubagentWorkflow && !hasNativeAgentName) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution but no agentDefinitionName was provided",
    );
  }
  if (codexSubagentStrategy.reason === "invalid_fallback") {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        invalidValue: codexSubagentStrategy.configuredValue,
      },
      "Ignoring invalid Codex subagent strategy override; falling back to isolated skill-session execution",
    );
  }
  if (
    wantsNativeSubagentWorkflow &&
    codexSubagentStrategy.reason === "explicit_isolated" &&
    input.runtimeId === "codex"
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Native Codex subagents disabled via runtime option; falling back to isolated skill-session execution",
    );
  }
  if (
    wantsNativeSubagentWorkflow &&
    codexSubagentStrategy.reason === "disabled_by_env" &&
    input.runtimeId === "codex"
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        featureFlag: "AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED",
      },
      "Native Codex subagents disabled by feature flag; falling back to isolated skill-session execution",
    );
  }
  if (
    wantsNativeSubagentWorkflow &&
    input.runtimeId === "codex" &&
    codexSubagentStrategy.strategy === CODEX_SUBAGENT_STRATEGIES.native &&
    codexNativeReadiness &&
    !codexNativeReadiness.ready
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
        missingPaths: codexNativeReadiness.missingPaths,
      },
      "Native Codex subagents requested but project is missing required AI Factory-managed .codex assets; falling back to isolated skill-session execution",
    );
  }

  if (wantsSlashFallback && !hasFallbackCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested slash fallback but no fallback slash command was provided",
    );
  }
  if (
    wantsNativeSubagentWorkflow &&
    !supportsNativeSubagentWorkflow &&
    !(
      input.runtimeId === "codex" &&
      codexSubagentStrategy.strategy === CODEX_SUBAGENT_STRATEGIES.native &&
      codexNativeReadiness &&
      !codexNativeReadiness.ready
    ) &&
    codexSubagentStrategy.reason !== "invalid_fallback" &&
    codexSubagentStrategy.reason !== "disabled_by_env"
  ) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution but runtime does not support it",
    );
  }
  if (wantsNativeSubagentWorkflow && !supportsNativeSubagentWorkflow && !hasFallbackCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested native subagent execution without any fallback command; prompt will remain non-delegated",
    );
  }
  if (wantsIsolatedSkillCommand && !supportsIsolatedSkillCommand) {
    input.logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        workflowKind: input.workflow.workflowKind,
      },
      "Workflow requested isolated skill-command execution but runtime does not support it",
    );
  }

  const useApiSkillExpansion = input.transport === RuntimeTransport.API && useSlashFallback;

  const prompt = useNativeSubagentWorkflow
    ? prependNativeSubagentPrompt(
        input.workflow,
        input.workflow.promptInput.prompt,
        input.workflow.agentDefinitionName ?? "",
      )
    : useApiSkillExpansion
      ? expandApiSkillCommand(
          input.workflow.promptInput.prompt,
          input.workflow.promptInput.fallbackSlashCommand ?? "",
          input.projectRoot,
          input.logger,
        )
      : useIsolatedSkillCommand
        ? prependSlashFallbackPrompt(
            input.workflow.promptInput.prompt,
            input.workflow.promptInput.fallbackSlashCommand ?? "",
          )
        : useSlashFallback
          ? prependSlashFallbackPrompt(
              input.workflow.promptInput.prompt,
              input.workflow.promptInput.fallbackSlashCommand ?? "",
            )
          : input.workflow.promptInput.prompt;
  const systemPromptAppend = input.workflow.promptInput.systemPromptAppend ?? "";
  const agentDefinitionName = canUseAgentDefinition
    ? input.workflow.agentDefinitionName
    : undefined;

  input.logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      workflowKind: input.workflow.workflowKind,
      usedFallbackSlashCommand: useSlashFallback,
      usedIsolatedSkillCommand: useIsolatedSkillCommand,
      usedNativeSubagentWorkflow: useNativeSubagentWorkflow,
      usedApiSkillExpansion: useApiSkillExpansion,
      nativeSubagentFallbackReason:
        input.runtimeId === "codex" &&
        wantsNativeSubagentWorkflow &&
        !useNativeSubagentWorkflow &&
        codexNativeReadiness &&
        !codexNativeReadiness.ready
          ? "missing_native_assets"
          : input.runtimeId === "codex" &&
              wantsNativeSubagentWorkflow &&
              !useNativeSubagentWorkflow &&
              codexSubagentStrategy.reason !== "non_codex"
            ? codexSubagentStrategy.reason
            : null,
      agentDefinitionName: agentDefinitionName ?? null,
      systemPromptAppendLength: systemPromptAppend.length,
    },
    "Resolved runtime workflow prompt policy",
  );

  return {
    prompt,
    systemPromptAppend,
    agentDefinitionName,
    usedFallbackSlashCommand: useSlashFallback,
    usedIsolatedSkillCommand: useIsolatedSkillCommand,
    usedNativeSubagentWorkflow: useNativeSubagentWorkflow,
    usedApiSkillExpansion: useApiSkillExpansion,
    nativeSubagentFallbackReason:
      input.runtimeId === "codex" &&
      wantsNativeSubagentWorkflow &&
      !useNativeSubagentWorkflow &&
      codexNativeReadiness &&
      !codexNativeReadiness.ready
        ? "missing_native_assets"
        : input.runtimeId === "codex" &&
            wantsNativeSubagentWorkflow &&
            !useNativeSubagentWorkflow &&
            codexSubagentStrategy.reason !== "non_codex"
          ? codexSubagentStrategy.reason
          : undefined,
  };
}
