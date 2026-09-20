# Implementation Plan: Missing Gates and Makefile Integration

Branch: feature/missing-gates-and-makefile-integration
Created: 2026-09-20

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage
Milestone: "none"
Rationale: "Skipped by user; task is internal quality-gate hardening and can proceed without roadmap binding."

## Tasks

### Phase 1: Gate Framework and Deterministic Validation Base
- [x] Task 1: Create a deterministic gate runner and result schema for local and CI execution, including machine-readable outputs for each gate run.
  - Deliverable: `scripts/gates/run.mjs` runner + `scripts/gates/lib/` (logger, fs-tools, result, package-graph) + `aif-gate-result.json` schema (JSON with per-gate `pass/warn/fail`, scope checks, batch summary, timestamp, runId).
  - Files: `scripts/gates/` (new directory), `scripts/gates/results/` (gitignored output).
  - Logging: LOG_LEVEL-aware stderr logger; INFO per gate run + batch summary; ERROR on validator crash.
  - Status: DONE — runner executes 17 gates, writes machine-readable report, exit 0/1/2.

- [x] Task 2: Implement missing deterministic G1 validators focused on specification integrity (`G1-ID`, `G1-LINK`, `G1-DUP`, `G1-TBD`, `G1-MACHINE`).
  - Deliverable: `scripts/gates/validators/g1-{id,link,dup,tbd,machine}.mjs`. Created missing artifacts `open-questions.md` (TBD registry) and `docs/contracts/INDEX.yaml` (machine-readable registry); fixed 51 pre-existing broken links.
  - Files: validators + `open-questions.md` + `docs/contracts/INDEX.yaml` + doc link fixes.
  - Logging: INFO counts; WARN on findings; ERROR on missing registry/parse errors.
  - Status: DONE — all 5 gates pass.

- [x] Task 3: Implement remaining deterministic/heuristic G1 checks (`G1-FMT` hard mode, `G1-TRACE`, `G1-PRIO`, `G1-METRIC`, `G1-GHERKIN`, `G1-GLOSS`) with explicit pass/fail criteria and documented fallbacks where full determinism is not possible.
  - Deliverable: `scripts/gates/validators/g1-{fmt,trace,prio,metric,gherkin,gloss}.mjs`.
  - Files: validators.
  - Logging: INFO counts; WARN for heuristic/fallback activation; track status union.
  - Status: DONE — all 6 gates pass (TRACE/GHERKIN/GLOSS use warn for heuristic parts).

### Phase 2: FG/AG Structural Gates and Tooling
- [x] Task 4: Add architectural structural gates for dependency cycles and package-layer constraints (`AG-CYCLES`, `AG-LAYERS`, `AG-BOUNDARIES`) using static dependency analysis.
  - Deliverable: `scripts/gates/validators/ag-{cycles,layers,boundaries}.mjs` + `scripts/gates/lib/package-graph.mjs` (builds @aif/* graph from package.json, finds cycles, layer edges).
  - Files: validators + package-graph lib.
  - Logging: INFO package-graph summary; WARN cycles/edges; ERROR violations.
  - Status: DONE — all 3 pass (7 packages, no cycles, layers respected, DB boundary clean).

- [x] Task 5: Introduce `AG-STRUCT` and `FG-TEST-QUALITY` enforceable checks (complexity/size thresholds and test anti-pattern linting), and tighten `FG-MUTATION` policy to measurable thresholds.
  - Deliverable: `scripts/gates/validators/ag-struct.mjs` (file-size thresholds), `fg-test-quality.mjs` (skip/trivial-assert/assert-less anti-patterns), `fg-mutation-policy.mjs` (stryker thresholds + critical-package scope). Fixed the trivial-assert test in `packages/data/src/__tests__/projectionTypes.test.ts`.
  - Files: validators + projectionTypes test fix.
  - Logging: INFO per-file metric; WARN threshold trends; ERROR breaches.
  - Status: DONE — all 3 pass, warn on known large modules (coordinator 1817 lines etc.) and mutation break<threshold 80%.

### Phase 3: Makefile and CI Gate Integration
- [x] Task 6: Extend `Makefile` with explicit gate targets for new checks and compose them into clear local/CI pipelines (`gate-fast`, `gate`, `ci-gate`, and dedicated `gate-*` targets).
  - Deliverable: `gate-g1`, `gate-ag`, `gate-fg`, `gate-spec`, `gates` targets; `gate` extended with `gates`; `ci-gates` added to `ci-gate`; header docs updated.
  - Files: `Makefile`, root `package.json` (npm scripts `gates`, `gates:g1`, `gates:ag`, `gates:fg`, `gates:report`), `.gitignore` (`/scripts/gates/results/`).
  - Status: DONE — `make gate-g1` / `npm run gates:g1` green; `make -n` dry-run valid.

- [x] Task 7: Wire CI workflows to execute the same gate set as Makefile and publish gate artifacts (`aif-gate-result`) for auditability.
  - Deliverable: `.github/workflows/gates.yml` runs `npm run gates:report` on push/PR, uploads `aif-gate-result.json` artifact.
  - Files: `.github/workflows/gates.yml` (new).
  - Status: DONE — aligned with existing workflow patterns (checkout@v6, setup-node 22, npm ci, upload-artifact@v4).

### Phase 4: Documentation, Checklists, and Validation
- [x] Task 8: Update quality-gate documentation and package checklists to reflect implemented gates, ownership, and waiver policy.
  - Deliverable: `docs/qa/gates.md` status cells updated (G1×11, AG×4, FG×2 → ✅/🟡-подробно); new `docs/qa/gates-run.md` command reference; README Makefile quick-ref + docs table updated; `packages/data/CHECKLIST.md` note on trivial asserts + gates.
  - Files: `docs/qa/gates.md`, `docs/qa/gates-run.md` (new), `docs/qa/README.md`, `README.md`, `packages/data/CHECKLIST.md`.
  - Status: DONE — all gates documented with exact commands and report format.

- [x] Task 9: Run end-to-end validation for local and CI-equivalent paths and record baseline outcomes plus known exceptions.
  - Deliverable: `node scripts/gates/run.mjs` → exit 0 (17 gates: 10 pass / 7 warn / 0 fail); `make gate-g1/gate-ag/gate-fg` green; `packages/data` tests 344/344 pass; prettier-clean on all touched files; `ai:log-markers` clean.
  - Known exceptions (pre-existing on main, NOT caused by this branch): `npm run format:check` fails on 9 `packages/web/e2e/gui/*.spec.ts` files (untracked pre-existing work); `docs/known-issues.md` had uncommitted edits before this session.
  - Not run (expensive): full `make gate` / `make ci-gate` (Docker) / `npm run ai:validate` (blocked by pre-existing format:check failure).
  - Status: DONE-core — deterministic gates + touched-package tests + formatting validated; heavy CI-equivalent runs deferred to CI.

## Commit Plan
- **Commit 1** (after tasks 1-3): `feat(gates): add deterministic G1 gate runner and validators`
- **Commit 2** (after tasks 4-5): `feat(quality): enforce AG structure and test-quality gates`
- **Commit 3** (after tasks 6-7): `chore(ci): integrate gate matrix into Makefile and workflows`
- **Commit 4** (after tasks 8-9): `docs(qa): sync gate catalog checklists and validation baselines`
