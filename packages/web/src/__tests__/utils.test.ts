import { describe, expect, it } from "vitest";
import { normalizeRepositoryPath } from "../lib/utils";

describe("normalizeRepositoryPath", () => {
  it("keeps a bare namespace/name unchanged", () => {
    expect(normalizeRepositoryPath("vedo-ecosystem/vedo-core")).toBe("vedo-ecosystem/vedo-core");
  });

  it("keeps nested group paths unchanged", () => {
    expect(normalizeRepositoryPath("group/subgroup/project")).toBe("group/subgroup/project");
  });

  it("strips https URL prefixes", () => {
    expect(normalizeRepositoryPath("https://gitlab.com/vedo-ecosystem/vedo-core")).toBe(
      "vedo-ecosystem/vedo-core",
    );
  });

  it("strips corporate/self-hosted instance URLs", () => {
    expect(normalizeRepositoryPath("https://gitlab.example.com/group/subgroup/project")).toBe(
      "group/subgroup/project",
    );
    expect(normalizeRepositoryPath("https://gitlab.corp.internal:8443/team/repo.git")).toBe(
      "team/repo",
    );
  });

  it("strips http URL prefixes", () => {
    expect(normalizeRepositoryPath("http://github.com/owner/repo")).toBe("owner/repo");
  });

  it("strips trailing .git suffix", () => {
    expect(normalizeRepositoryPath("https://gitlab.com/vedo-ecosystem/vedo-core.git")).toBe(
      "vedo-ecosystem/vedo-core",
    );
  });

  it("strips scp-style ssh URLs", () => {
    expect(normalizeRepositoryPath("git@gitlab.com:group/subgroup/repo.git")).toBe(
      "group/subgroup/repo",
    );
  });

  it("strips ssh:// URLs", () => {
    expect(normalizeRepositoryPath("ssh://git@gitlab.com/owner/repo.git")).toBe("owner/repo");
  });

  it("strips trailing slashes", () => {
    expect(normalizeRepositoryPath("owner/repo/")).toBe("owner/repo");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRepositoryPath("  owner/repo  ")).toBe("owner/repo");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeRepositoryPath("")).toBe("");
    expect(normalizeRepositoryPath("   ")).toBe("");
  });
});
