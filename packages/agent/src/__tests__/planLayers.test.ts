import { describe, it, expect } from "vitest";
import {
  analyzeLayerDisjointness,
  collectDeclaredFiles,
  computePendingPlanLayers,
  computePlanLayers,
  formatLayerDecisions,
  formatLayerSummary,
  isOutsideDeclaredScope,
} from "../planLayers.js";

describe("plan layer parsing", () => {
  it("computes parallel layer for dependency fan-out", () => {
    const plan = `
### Phase 1: Setup
- [ ] **Task 1: Scaffold package**

### Phase 2: Build
- [ ] **Task 2: Build component** (depends on 1)
- [ ] **Task 3: Add styles** (depends on 1)

### Phase 3: Verify
- [ ] **Task 4: Verify** (depends on 2, 3)
`;
    const { layers } = computePlanLayers(plan);
    expect(layers).toEqual([[1], [2, 3], [4]]);
  });

  it("uses implicit phase dependencies when depends-on is omitted", () => {
    const plan = `
### Phase 1
- [ ] **Task 1: one**
- [ ] **Task 2: two**

### Phase 2
- [ ] **Task 3: three**
`;
    const { layers } = computePlanLayers(plan);
    expect(layers).toEqual([[1, 2], [3]]);
  });

  it("does not parse non-checkbox heading-style tasks", () => {
    const plan = `
### Task 1: Init
**Depends on:** nothing

### Task 2: UI
**Depends on:** Task 1

### Task 3: CSS
**Depends on:** Task 1
`;
    const { layers } = computePlanLayers(plan);
    expect(layers).toEqual([]);
  });

  it("formats summary for prompt injection", () => {
    const text = formatLayerSummary([[1], [2, 3], [4]]);
    expect(text).toContain("Layer 2 (parallel): tasks 2, 3");
  });

  it("does not parse numbered checklist tasks without `Task` keyword", () => {
    const plan = `
## Fix Steps
1. [ ] Remove footer html
2. [x] Remove footer css
3. [ ] Remove footer js (depends on 1)
`;
    const { layers } = computePendingPlanLayers(plan);
    expect(layers).toEqual([]);
  });

  it("does not parse numbered plain steps", () => {
    const plan = `
## Steps
1. Create endpoint
2) Add tests
3. Verify integration
`;
    const { layers } = computePendingPlanLayers(plan);
    expect(layers).toEqual([]);
  });

  it("parses checkbox Task rows with heading prefix", () => {
    const plan = `
### Phase 1
#### - [x] Task 1: Done base setup
#### - [ ] Task 2: Add feature (depends on 1)
`;
    const { layers } = computePendingPlanLayers(plan);
    expect(layers).toEqual([[2]]);
  });

  it("treats [~] Task as in-progress (pending)", () => {
    const plan = `
### Phase 1
- [x] Task 1: Base setup
- [~] Task 2: Coordinator is working now (depends on 1)
`;
    const { layers } = computePendingPlanLayers(plan);
    expect(layers).toEqual([[2]]);
  });
});

describe("plan change scope + layer disjointness", () => {
  const plan = `
### Phase 1
- [ ] **Task 1: Add model**

  Files:
  - Modify: \`packages/api/src/model.ts\`
  - Test: \`packages/api/src/__tests__/model.test.ts\`

  Change scope:
  - New artifacts (code): none.
  - Modified artifacts (code): model field.

- [ ] **Task 2: Add service**

  Files:
  - Modify: \`packages/api/src/service.ts\`

  Change scope:
  - Modified artifacts (code): service call.

### Phase 2
- [ ] **Task 3: Docs**

  Files:
  - Modify: \`packages/api/src/service.ts\`

  Change scope:
  - Modified artifacts (docs): doc note.
`;

  it("parses declared files and artifact types per task", () => {
    const { tasks } = computePlanLayers(plan);
    const taskOne = tasks.find((task) => task.number === 1);
    expect(taskOne?.changeScope.files).toEqual([
      "packages/api/src/__tests__/model.test.ts",
      "packages/api/src/model.ts",
    ]);
    expect(taskOne?.changeScope.declared).toBe(true);
    expect(taskOne?.changeScope.artifactTypes).toEqual(["code"]);
  });

  it("allows parallel fan-out when a layer's declared file sets are disjoint", () => {
    const { tasks, layers } = computePlanLayers(plan);
    const analyses = analyzeLayerDisjointness(layers, tasks);
    expect(analyses[0]).toMatchObject({
      tasks: [1, 2],
      decision: "parallel",
      overlappingFiles: [],
      undeclaredTasks: [],
    });
  });

  it("downgrades a layer to sequential when two tasks declare the same file", () => {
    const overlapping = `
### Phase 1
- [ ] **Task 1: A**

  Files:
  - Modify: \`src/shared.ts\`

- [ ] **Task 2: B**

  Files:
  - Modify: \`src/shared.ts\`
`;
    const { tasks, layers } = computePlanLayers(overlapping);
    const analyses = analyzeLayerDisjointness(layers, tasks);
    expect(analyses[0]?.decision).toBe("sequential");
    expect(analyses[0]?.overlappingFiles).toEqual(["src/shared.ts"]);
  });

  it("downgrades a layer to sequential when a task declares no change scope", () => {
    const undeclared = `
### Phase 1
- [ ] **Task 1: A**

  Files:
  - Modify: \`src/a.ts\`

- [ ] **Task 2: B**
`;
    const { tasks, layers } = computePlanLayers(undeclared);
    const analyses = analyzeLayerDisjointness(layers, tasks);
    expect(analyses[0]?.decision).toBe("sequential");
    expect(analyses[0]?.undeclaredTasks).toEqual([2]);
  });

  it("collects the declared file union and detects out-of-scope paths", () => {
    const { tasks } = computePlanLayers(plan);
    const files = collectDeclaredFiles(tasks);
    expect(files).toContain("packages/api/src/service.ts");
    expect(isOutsideDeclaredScope("./packages/api/src/model.ts", files)).toBe(false);
    expect(isOutsideDeclaredScope("packages/api/src/unrelated.ts", files)).toBe(true);
  });

  it("formats layer decisions for prompt injection", () => {
    const { tasks, layers } = computePlanLayers(plan);
    const text = formatLayerDecisions(analyzeLayerDisjointness(layers, tasks));
    expect(text).toContain("Layer 1 (parallel): tasks 1, 2");
  });
});
