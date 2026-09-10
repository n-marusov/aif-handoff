import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createGitTestRoot } from "./gitTestUtils.js";
import {
  buildPlanCommitSubject,
  resolveBranchName,
  resolveIssueBranchName,
  resolveTargetProjectGitConventions,
} from "../gitConventions.js";

describe("resolveTargetProjectGitConventions", () => {
  it("falls back to Handoff defaults when the project declares no conventions", () => {
    const { rootPath } = createGitTestRoot("plan-review-conventions-default-");
    const conventions = resolveTargetProjectGitConventions(rootPath);
    expect(conventions).toMatchObject({
      branchPrefix: "feature/",
      commitSubjectPrefix: null,
      source: "default",
      sourceDetail: null,
    });
  });

  it("reads the branch prefix declared in .ai-factory/config.yaml", () => {
    const { rootPath } = createGitTestRoot("plan-review-conventions-config-", {
      configYaml:
        "git:\n  enabled: true\n  base_branch: main\n  create_branches: true\n  branch_prefix: fix/\n",
    });
    const conventions = resolveTargetProjectGitConventions(rootPath);
    expect(conventions).toMatchObject({
      branchPrefix: "fix/",
      commitSubjectPrefix: null,
      source: "config",
      sourceDetail: ".ai-factory/config.yaml",
    });
  });

  it("normalizes a branch prefix that lacks a trailing slash", () => {
    const { rootPath } = createGitTestRoot("plan-review-conventions-normalize-", {
      configYaml: "git:\n  enabled: true\n  branch_prefix: hotfix\n",
    });
    expect(resolveTargetProjectGitConventions(rootPath).branchPrefix).toBe("hotfix/");
  });

  it("lets a rules section override the config file", () => {
    const { rootPath } = createGitTestRoot("plan-review-conventions-rules-", {
      configYaml:
        "git:\n  enabled: true\n  base_branch: main\n  create_branches: true\n  branch_prefix: feature/\n",
    });
    writeFileSync(
      join(rootPath, "RULES.md"),
      [
        "# Project Rules",
        "",
        "## Git conventions",
        "branch_prefix: fix/",
        'commit_subject_prefix: "docs(plans):"',
        "",
      ].join("\n"),
    );

    const conventions = resolveTargetProjectGitConventions(rootPath);
    expect(conventions).toMatchObject({
      branchPrefix: "fix/",
      commitSubjectPrefix: "docs(plans):",
      source: "rules",
      sourceDetail: "RULES.md",
    });
  });

  it("reads conventions from the ai-factory rules file too", () => {
    const { rootPath } = createGitTestRoot("plan-review-conventions-aif-rules-");
    mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });
    writeFileSync(
      join(rootPath, ".ai-factory", "RULES.md"),
      [
        "## Git conventions",
        "branch_prefix: feature/github-issue-",
        "commit_subject_prefix: docs(plan):",
        "",
      ].join("\n"),
    );
    const conventions = resolveTargetProjectGitConventions(rootPath);
    expect(conventions).toMatchObject({
      branchPrefix: "feature/github-issue-/",
      commitSubjectPrefix: "docs(plan):",
      source: "rules",
    });
  });
});

describe("resolveBranchName", () => {
  it("composes prefix + provider + issue number into a stable branch name", () => {
    expect(resolveBranchName("feature/", "github", 42)).toBe("feature/github-issue-42");
    expect(resolveBranchName("feature/", "gitlab", 7)).toBe("feature/gitlab-issue-7");
    expect(resolveBranchName("fix", "github", 3)).toBe("fix/github-issue-3");
  });
});

describe("resolveIssueBranchName", () => {
  it("uses the RULES-declared prefix and reports the source", () => {
    const { rootPath } = createGitTestRoot("issue-branch-rules-");
    writeFileSync(
      join(rootPath, "RULES.md"),
      ["## Git conventions", "branch_prefix: fix/", ""].join("\n"),
    );
    const resolved = resolveIssueBranchName({
      projectRoot: rootPath,
      provider: "github",
      issueNumber: 5,
    });
    expect(resolved).toMatchObject({
      branchName: "fix/github-issue-5",
      source: "rules",
      sourceDetail: "RULES.md",
    });
  });

  it("falls back to the provider default prefix when nothing is declared", () => {
    const { rootPath } = createGitTestRoot("issue-branch-default-");
    const resolved = resolveIssueBranchName({
      projectRoot: rootPath,
      provider: "github",
      issueNumber: 9,
    });
    expect(resolved.branchName).toBe("feature/github-issue-9");
    expect(resolved.source).toBe("default");
  });
});

describe("buildPlanCommitSubject", () => {
  it("uses the docs(plan) default without an explicit prefix", () => {
    expect(buildPlanCommitSubject("Add plan review PR gate", { commitSubjectPrefix: null })).toBe(
      "docs(plan): Add plan review PR gate",
    );
  });

  it("honors an explicit target-project prefix", () => {
    expect(
      buildPlanCommitSubject("Add plan review PR gate", {
        commitSubjectPrefix: "docs(plans)",
      }),
    ).toBe("docs(plans): Add plan review PR gate");
  });

  it("flattens whitespace and caps the subject length", () => {
    const longTitle = `Title ${"with a very long suffix ".repeat(8)}end`;
    const subject = buildPlanCommitSubject(`  ${longTitle}  `, { commitSubjectPrefix: null });
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject).toMatch(/^docs\(plan\): /);
  });
});
