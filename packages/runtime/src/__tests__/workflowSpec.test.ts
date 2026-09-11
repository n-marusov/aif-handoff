import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeWorkflowSpec,
  resolveRuntimePromptPolicy,
  transformSkillCommandPrefix,
  UsageReporting,
  type RuntimeCapabilities,
} from "../index.js";

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: false,
  supportsApprovals: true,
  supportsCustomEndpoint: true,
  supportsIsolatedSubagentWorkflows: true,
  supportsNativeSubagentWorkflows: true,
  usageReporting: UsageReporting.NONE,
};

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: false,
  supportsSessionList: true,
  supportsAgentDefinitions: true,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: true,
  supportsCustomEndpoint: true,
  supportsIsolatedSubagentWorkflows: false,
  supportsNativeSubagentWorkflows: false,
  usageReporting: UsageReporting.FULL,
};

function createCodexNativeAssetsProjectRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "aif-codex-native-assets-"));
  const agentsDir = join(projectRoot, ".codex", "agents");
  mkdirSync(agentsDir, { recursive: true });

  for (const fileName of [
    "best-practices-sidecar.toml",
    "commit-preparer.toml",
    "docs-auditor.toml",
    "implement-coordinator.toml",
    "implement-worker.toml",
    "plan-coordinator.toml",
    "plan-polisher.toml",
    "review-sidecar.toml",
    "security-sidecar.toml",
  ]) {
    writeFileSync(join(agentsDir, fileName), `name = "${fileName}"\n`, "utf8");
  }

  writeFileSync(join(projectRoot, ".codex", "config.toml"), "[agents]\nmax_threads = 6\n", "utf8");

  return projectRoot;
}

describe("runtime workflow spec + prompt policy", () => {
  it("falls back to slash command when agent definitions are unavailable", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt: "Plan this feature",
      agentDefinitionName: "plan-coordinator",
      fallbackSlashCommand: "/aif-plan fast",
      fallbackStrategy: "slash_command",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      workflow,
    });

    expect(resolved.usedFallbackSlashCommand).toBe(true);
    expect(resolved.agentDefinitionName).toBeUndefined();
    expect(resolved.prompt).toContain("/aif-plan fast");
  });

  it("keeps agent definition when runtime supports it", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement",
      fallbackStrategy: "slash_command",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "claude",
      capabilities: CLAUDE_CAPABILITIES,
      workflow,
    });

    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBe("implement-coordinator");
    expect(resolved.prompt).toBe("Implement this feature");
  });

  it("uses isolated skill-command mode when runtime supports isolated subagent workflows", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "isolated_skill_session",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      workflow,
    });

    expect(resolved.usedIsolatedSkillCommand).toBe(true);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBeUndefined();
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("uses native Codex subagents when runtime supports them", () => {
    const projectRoot = createCodexNativeAssetsProjectRoot();
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      projectRoot,
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: { codexSubagentStrategy: "native" },
      workflow,
      codexNativeSubagentsEnabled: true,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(true);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBeUndefined();
    expect(resolved.prompt).toContain("Use Codex native subagents for this workflow.");
    expect(resolved.prompt).toContain('Spawn the custom Codex agent "implement-coordinator"');
    expect(resolved.prompt).not.toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("falls back to isolated skill-command mode when native Codex subagents are disabled by runtime option", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: { codexSubagentStrategy: "isolated" },
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(true);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("warns and falls back to isolated skill-command mode when codexSubagentStrategy is invalid", () => {
    const projectRoot = createCodexNativeAssetsProjectRoot();
    const warnings: Array<{ context: Record<string, unknown>; message: string }> = [];
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      projectRoot,
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: { codexSubagentStrategy: "isloated" },
      workflow,
      logger: {
        warn(context, message) {
          warnings.push({ context, message });
        },
      },
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(true);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
    expect(warnings).toEqual([
      {
        context: {
          runtimeId: "codex",
          workflowKind: "implementer",
          invalidValue: "isloated",
        },
        message:
          "Ignoring invalid Codex subagent strategy override; falling back to isolated skill-session execution",
      },
    ]);
  });

  it("falls back to isolated skill-command mode when Codex native subagents are disabled by feature flag", () => {
    const projectRoot = createCodexNativeAssetsProjectRoot();
    const warnings: Array<{ context: Record<string, unknown>; message: string }> = [];
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      projectRoot,
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: {},
      workflow,
      logger: {
        warn(context, message) {
          warnings.push({ context, message });
        },
      },
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(true);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.nativeSubagentFallbackReason).toBe("disabled_by_env");
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
    expect(warnings).toEqual([
      {
        context: {
          runtimeId: "codex",
          workflowKind: "implementer",
          featureFlag: "AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED",
        },
        message:
          "Native Codex subagents disabled by feature flag; falling back to isolated skill-session execution",
      },
    ]);
  });

  it("defaults Codex native_subagents requests to native orchestration when feature flag is enabled", () => {
    const projectRoot = createCodexNativeAssetsProjectRoot();
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      projectRoot,
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: {},
      workflow,
      codexNativeSubagentsEnabled: true,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(true);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.prompt).toContain('Spawn the custom Codex agent "implement-coordinator"');
  });

  it("falls back to isolated skill-command mode when Codex native assets are missing on disk", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "codex",
      projectRoot: mkdtempSync(join(tmpdir(), "aif-codex-missing-assets-")),
      capabilities: CODEX_CAPABILITIES,
      runtimeOptions: {},
      workflow,
      codexNativeSubagentsEnabled: true,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(true);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.nativeSubagentFallbackReason).toBe("missing_native_assets");
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
    expect(resolved.prompt).not.toContain("Use Codex native subagents for this workflow.");
  });

  it("keeps Claude native agent-definition behavior unchanged when Codex strategy options are present", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement",
      fallbackStrategy: "slash_command",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "claude",
      capabilities: CLAUDE_CAPABILITIES,
      runtimeOptions: { codexSubagentStrategy: "isolated" },
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(false);
    expect(resolved.agentDefinitionName).toBe("implement-coordinator");
    expect(resolved.prompt).toBe("Implement this feature");
  });

  it("downgrades isolated skill-command mode to slash fallback when runtime lacks capability", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "isolated_skill_session",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "openrouter",
      capabilities: {
        ...CODEX_CAPABILITIES,
        supportsIsolatedSubagentWorkflows: false,
      },
      workflow,
    });

    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(true);
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("downgrades native Codex subagents to slash fallback when neither native nor isolated execution is available", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "implementer",
      prompt: "Implement this feature",
      agentDefinitionName: "implement-coordinator",
      fallbackSlashCommand: "/aif-implement @.ai-factory/PLAN.md",
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      requiredCapabilities: ["supportsAgentDefinitions"],
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "openrouter",
      capabilities: {
        ...CODEX_CAPABILITIES,
        supportsIsolatedSubagentWorkflows: false,
        supportsNativeSubagentWorkflows: false,
      },
      workflow,
    });

    expect(resolved.usedNativeSubagentWorkflow).toBe(false);
    expect(resolved.usedIsolatedSkillCommand).toBe(false);
    expect(resolved.usedFallbackSlashCommand).toBe(true);
    expect(resolved.prompt).toContain("/aif-implement @.ai-factory/PLAN.md");
  });

  it("throws when isolated skill-command mode is requested without a fallback command", () => {
    expect(() =>
      createRuntimeWorkflowSpec({
        workflowKind: "implementer",
        prompt: "Implement this feature",
        executionMode: "isolated_skill_session",
      }),
    ).toThrow(/isolated_skill_session without fallbackSlashCommand/i);
  });

  it("throws when native subagent mode is requested without an agent definition name", () => {
    expect(() =>
      createRuntimeWorkflowSpec({
        workflowKind: "implementer",
        prompt: "Implement this feature",
        fallbackSlashCommand: "/aif-implement",
        executionMode: "native_subagents",
      }),
    ).toThrow(/native_subagents without agentDefinitionName/i);
  });

  it("defaults fallbackStrategy to slash_command when slash command is provided", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "reviewer",
      prompt: "Review this task",
      fallbackSlashCommand: "/aif-review",
      requiredCapabilities: ["supportsApprovals", "supportsApprovals"],
    });

    expect(workflow.fallbackStrategy).toBe("slash_command");
    expect(workflow.requiredCapabilities).toEqual(["supportsApprovals"]);
    expect(workflow.sessionReusePolicy).toBe("resume_if_available");
  });

  it("defaults fallbackStrategy to none when no slash command is provided", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "oneshot",
      prompt: "Generate commit message",
      sessionReusePolicy: "new_session",
    });

    expect(workflow.fallbackStrategy).toBe("none");
    expect(workflow.promptInput.fallbackSlashCommand).toBeUndefined();
    expect(workflow.sessionReusePolicy).toBe("new_session");
  });
});

describe("API slash-command prompt policy", () => {
  it("expands API slash fallback into explicit skill instructions", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt: "HANDOFF_MODE: 1\nPlan file: @.ai-factory/PLAN.md",
      fallbackSlashCommand: "/aif-plan fast @.ai-factory/PLAN.md docs:false tests:false",
      fallbackStrategy: "slash_command",
    });

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "openrouter",
      transport: "api",
      capabilities: {
        ...CODEX_CAPABILITIES,
        supportsIsolatedSubagentWorkflows: false,
        supportsNativeSubagentWorkflows: false,
      },
      workflow,
    });

    expect(resolved.usedApiSkillExpansion).toBe(true);
    expect(resolved.prompt).toContain("API transport workflow contract:");
    expect(resolved.prompt).toContain("Planning is read-only");
    expect(resolved.prompt).toContain("Requested workflow command: /aif-plan fast");
    expect(resolved.prompt).not.toContain("*** Begin Patch");
  });

  it("uses a safe inline API skill fallback when the project skill is unavailable", () => {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt: "Plan this task",
      fallbackSlashCommand: "/aif-plan fast",
      fallbackStrategy: "slash_command",
    });
    const messages: string[] = [];

    const resolved = resolveRuntimePromptPolicy({
      runtimeId: "openrouter",
      transport: "api",
      projectRoot: "/path/that/does/not/exist",
      capabilities: { ...CODEX_CAPABILITIES, supportsIsolatedSubagentWorkflows: false },
      workflow,
      logger: { debug: (_context, message) => messages.push(message) },
    });

    expect(resolved.usedApiSkillExpansion).toBe(true);
    expect(resolved.prompt).toContain("do not create, modify, or delete project files");
    expect(messages).toContain(
      "[FIX] API slash command skill file unavailable; using safe inline fallback",
    );
  });
});

describe("transformSkillCommandPrefix", () => {
  it("transforms /aif-plan to $aif-plan", () => {
    expect(transformSkillCommandPrefix("/aif-plan fast", "$")).toBe("$aif-plan fast");
  });

  it("transforms multiple skill commands in one prompt", () => {
    const input = "/aif-review\n\nAlso run /aif-security-checklist after review";
    const result = transformSkillCommandPrefix(input, "$");
    expect(result).toContain("$aif-review");
    expect(result).toContain("$aif-security-checklist");
    expect(result).not.toContain("/aif-review");
    expect(result).not.toContain("/aif-security-checklist");
  });

  it("does not transform non-skill slash patterns", () => {
    const input = "Check /etc/config and /usr/local/bin paths\n/aif-implement @PLAN.md";
    const result = transformSkillCommandPrefix(input, "$");
    expect(result).toContain("/etc/config");
    expect(result).toContain("/usr/local/bin");
    expect(result).toContain("$aif-implement");
    expect(result).not.toContain("/aif-implement");
  });

  it("returns text unchanged when prefix is /", () => {
    expect(transformSkillCommandPrefix("/aif-plan fast", "/")).toBe("/aif-plan fast");
  });

  it("returns text unchanged when prefix is empty", () => {
    expect(transformSkillCommandPrefix("/aif-plan fast", "")).toBe("/aif-plan fast");
  });

  it("transforms /aif-fix command", () => {
    const result = transformSkillCommandPrefix('/aif-fix --plan-first "Title: bug"', "$");
    expect(result).toContain("$aif-fix --plan-first");
    expect(result).not.toContain("/aif-fix");
  });

  it("transforms inline skill references after whitespace", () => {
    const input = "Plan using /aif-plan approach and /aif-commit after";
    const result = transformSkillCommandPrefix(input, "$");
    expect(result).toBe("Plan using $aif-plan approach and $aif-commit after");
  });
});
