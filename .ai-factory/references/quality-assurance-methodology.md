# Quality Assurance Methodology Reference

> **Sources:** 13 bibliography entries (see [Bibliography](#bibliography))
> **Base methodology:** the `quality-matrix` skill — the Quality Programming Matrix (5×4 completeness framework)
> **Created:** 2026-09-20 · **Updated:** 2026-09-20

## Overview

This reference distills the quality-assurance (QA) methodology from a curated QA bibliography
and organizes it around the **Quality Programming Matrix** — the 5×4
completeness framework from the `quality-matrix` skill. The matrix is the *base*: it defines **what
must be covered** (20 mandatory classes of requirements). The books supply **how to cover and verify**
each class: test levels, test-design techniques, test-quality criteria, test doubles, automation,
metrics, and quality gates.

Two axioms run through every source:

1. **Quality is objective and lifecycle-wide** — the degree to which a system meets user needs across
   its whole life cycle ([QM], [ISO25010], [Kulikov]). Any matrix cell not closed by at least one
   *measurable* requirement is a **free parameter** — an uncontrolled risk.
2. **Testing cannot prove absence of defects** — "Program testing can be used to show the presence of
   bugs, but never to show their absence" (Dijkstra, quoted in [EST], [STA]). QA is therefore
   **risk reduction through systematic technique selection**, not exhaustive execution
   ("exhaustive testing is impossible" — 300 boolean flags give 2³⁰⁰ combinations, [EST]; [Kulikov]).

**Scope note.** The sources are dominated by *testing* methodology (unit, integration, E2E, API,
automation, TDD/BDD) plus one quality model ([ISO25010]) and one test-strategy practice ([Spektr]).
Environment/regulatory, ergonomics/accessibility, and decommissioning are **thin across all sources**;
those gaps are recorded explicitly in [Coverage gaps](#coverage-gaps).

---

## Core Concepts

| Concept | Definition (grounded) |
|---|---|
| **Quality** | "The degree to which a component, system or process meets specified requirements and/or user/customer needs and expectations" ([ISO25010]); «некая ценность для конечного пользователя» — value to the user, not mere spec compliance ([Kulikov]) |
| **Software testing** | «процесс анализа программного средства и сопутствующей документации с целью выявления дефектов и повышения качества продукта» — analysis of software + docs to find defects and raise quality ([Kulikov]) |
| **Quality assurance** | "Part of quality management focused on providing confidence that quality requirements will be fulfilled" ([Kulikov], ISTQB); testing is one instrument of QA, not a synonym |
| **Verification vs validation** | "Verification is about having the system right; validation is about having the right system" ([EST]); verification alone risks the "absence-of-errors fallacy" ([EST]) |
| **Error → defect → failure** | Human mistake → fault in the artifact → observable deviation at runtime ([Kulikov] ch. 2.5.1); debugging is "the process of finding, analyzing and removing the causes of failures" — distinct from testing ([Kulikov]) |
| **Requirement** | «описание того, какие функции и с соблюдением каких условий должно выполнять приложение в процессе решения полезной для пользователя задачи» ([Kulikov]) |
| **Unit of work** | "all the actions that take place between the invocation of an entry point up until a noticeable end result through one or more exit points" ([Art]) |
| **Unit test** | "an automated piece of code that invokes the unit of work through an entry point and then checks one of its exit points… trustworthy, readable, and maintainable" ([Art]); a small, fast, isolated piece of code ([UTP]) |
| **Integration test** | "testing a unit of work without having full control over all of its real dependencies" ([Art]); any test that fails one of the good-unit-test conditions |
| **Regression** | broken functionality — code that used to work and now does not; «регрессия», «программная ошибка» and «баг» are synonyms ([UTP], [Art]) |
| **Test double** | "an object that looks and behaves like its real counterpart but is a simplified version, more convenient for testing" ([UTP], after Meszaros); "an overarching term that describes all kinds of non-production-ready, fake dependencies" ([Art]) |
| **Testability** | "the ease with which software can be tested" / "the extent to which a software artifact supports its testing" ([STA]); prerequisites: controllability, observability, stability, simplicity, availability ([STA]) |
| **Code coverage** | share of source code executed by at least one test ([UTP], [pytest]); a *negative* indicator, not proof of quality ([UTP]) |
| **Test recipe** | "a test plan, outlining at which level a particular feature should be tested" ([Art]) |

---

## The Quality Programming Matrix (base framework)

The **Quality Programming Matrix** ([QM]) is a 5×4 table (20 cells). Each cell is a **mandatory class
of requirements** that must be closed by ≥1 measurable requirement.

**Rows — conditioning factors** (objective forces acting on the system; hierarchy is strict — if a
higher row is unsecured, lower rows lose meaning):

| # | Factor | Question the row answers |
|---|---|---|
| R1 | **Environment** | Under what social, regulatory, corporate, technological, natural conditions must the system stay operable — and how do system and environment affect each other? |
| R2 | **Ergonomics** | How do humans interact with the system? Cognitive load, mental models, behavior patterns, accessibility (a11y), reaction time, attention span, interface fatigue. |
| R3 | **Functions** | What tasks does the system perform? What value is created for the client — business logic, algorithms, operations, computation, storage, transmission, integrations? |
| R4 | **Accidents / Disasters** | What threat sources exist? How are catastrophes prevented? What happens on failures, errors, misuse, attacks? Acceptable damage, degradation, recovery, data protection and integrity. |
| R5 | **Lifecycle technical support** | Which management tools, procedures, platforms, tech stack, resources and competencies support design, development, deployment, maintenance and decommissioning? |

**Columns — lifecycle stages** (temporal slices; a requirement must be defined for each stage):

| # | Stage | Question the column answers |
|---|---|---|
| C1 | **Design & Development** | How are requirements elicited, designed, built, tested, packaged, deployed? Requirements on the *process* itself (CI/CD, test environments, review, linters, code metrics, dependency management). |
| C2 | **Operation / Needs satisfaction** | How does the system perform in the user's hands in normal mode? Availability, response time, throughput, accuracy, UX, behavior under load, onboarding. |
| C3 | **Operation / Maintenance** | Monitoring, logging, diagnostics, updates (rolling/blue-green/canary), data migration, backup/restore, incident management, user feedback. |
| C4 | **Decommissioning / Migration** | How is the system retired? Data migration, access revocation, disposal of accounts, artifacts, configs, domains, certificates. |

**Cell ids** are `<row>.<column>` — e.g. cell 3.2 = "Functions at Operation / Needs satisfaction".

**Method of finding gaps** ([QM]). A **lacuna** is a cell whose check question has no measurable answer.
For each of the 20 cells the auditor asks the cell's check question and assigns a status:

| Status | Symbol | Criterion |
|---|---|---|
| **Lacuna** | 🔴 | Cell empty — no requirement formulated. A free parameter. |
| **Metrologically unsound coverage** | 🟠 | Requirements exist but fail the measurability test (see [Measurability criteria](#measurability-criteria-for-requirements)). Cell is *not* closed. |
| **Formally closed, substantively incomplete** | 🟡 | Measurable requirements exist, but experience from other projects (post-mortems, incidents) reveals missed aspects that caused failures elsewhere. |
| **Closed and substantively complete** | 🟢 | ≥1 measurable requirement, and no critically missed aspect found. |
| **Hierarchy violation** | ⬆️ | A lower row is closed (🟢/🟡) while the corresponding R1/R2 cell for the same stage is 🔴/🟠. |

**Verdict rule** ([QM]): quality is *objectively confirmed* only if all cells are 🟢 with no hierarchy
violations; any 🔴 or 🟠 in columns C2/C3 (or a hierarchy violation in critical rows) means the project
is *objectively unconfirmed and at risk*.

**Reverse-inference principle** ([QM]): a requirement that cannot be mapped to *any* cell is either
formulated too vaguely (→ 🟠) or extends an already-closed cell.

### Cell check questions (condensed)

| Cell | What the cell demands |
|---|---|
| 1.1 | Environment constraints on *development*: software licenses, export restrictions, open-source policies, cloud regions, source-code storage rules |
| 1.2 | Environment in which the system *operates*: user languages/cultures/volume, regulation (GDPR, HIPAA, 152-ФЗ, industry standards), client SLAs/security policies/SSO, browsers/OS/devices/networks/cloud/APIs/protocols/load, geo-distribution and DR |
| 1.3 | Environment needed for *maintenance*: production access, audit trails, regulatory compliance during incidents, response-time SLAs |
| 1.4 | Regulatory/corporate/ecological/ethical/technological constraints at *decommissioning*: data retention after shutdown, right to erasure, user notification, domain/certificate transfer, archival compliance |
| 2.1 | Ergonomics of *developer tooling*: code readability, repo navigation, developer docs, CI/CD UX, onboarding, AI agents |
| 2.2 | Cognitive/visual/motor requirements of the *UI*: a11y (WCAG 2.1 AA), localization incl. RTL, mental models, learning time, error tolerance, fatigue, response latency, cognitive load |
| 2.3 | Ergonomics of *maintenance tooling*: monitoring dashboards, admin consoles, log readability/filtering, DevOps/SRE UX, alert ergonomics |
| 2.4 | Ergonomics of *decommissioning*: data-migration UI, admin UX for delete/archive, procedure clarity for end users, notifications |
| 3.1 | Functions verified *during development*: automated tests (unit/integration/e2e), acceptance testing, CI security checks, static analysis, build-time performance tests |
| 3.2 | Functions the system performs *for the user*: business logic, operations, reports, integrations, APIs, performance, accuracy |
| 3.3 | Functions that ensure *maintainability*: monitoring, alerting, distributed tracing, audit, config management, feature flags, A/B testing, canary releases, feedback collection, support tooling |
| 3.4 | Functions that ensure *decommissioning*: machine-readable user-data export, account deletion, traffic redirection, notifications, log/artifact archiving |
| 4.1 | Failure scenarios *during development*: CI/CD outage, secret leakage into the repo, malicious code/backdoor, build compromise, supply-chain attack, VCS failure, loss of infrastructure-as-code |
| 4.2 | What happens on *runtime failure*: acceptable downtime, RPO/RTO, functional degradation, rate limiting, circuit breaker, DDoS protection, invalid-input handling, OWASP Top 10, data integrity under partition |
| 4.3 | Failure scenarios *during maintenance*: failed update and rollback, DB failure and recovery strategy, log/metric loss, admin-access compromise, accidental production-data deletion |
| 4.4 | Failure scenarios *during decommissioning*: data loss during migration, hung transactions, unauthorized access to archived data, incomplete deletion across all processors/subcontractors |
| 5.1 | Procedures/platforms/tools/competencies for *design & development*: CI/CD platform, VCS, containers/orchestration, linters, test frameworks, code review, secret management, SBOM |
| 5.2 | Infrastructure/competencies the *user* needs: client devices, network bandwidth, browser version, plugins, access rights, training, user documentation, support desk |
| 5.3 | Procedures/tools/regulations for *maintenance* and scaling: observability stack, scalability, centralized logging, alerting/on-call, incident management, backup and recovery plan, changeset/release management, runbooks |
| 5.4 | Procedures/tools/regulations for *decommissioning*: migration plan, data-deletion procedure and completeness verification, access revocation, artifact archiving, knowledge/documentation handover |

---

## Quality Models & Standards

### ISO/IEC 25010 — product quality model
[ISO25010] (the ГОСТ Р ИСО/МЭК 25010-2015 PDF is **image-only**, so the model below is the
well-established ISO/IEC 25010:2011 content, **reconstructed**, not quoted from the scanned file).

| Characteristic | Sub-characteristics |
|---|---|
| Functional suitability | functional completeness, correctness, appropriateness |
| Performance efficiency | time behaviour, resource utilization, capacity |
| Compatibility | co-existence, interoperability |
| Usability | appropriateness recognizability, learnability, operability, user-error protection, UI aesthetics, accessibility |
| Reliability | maturity, availability, fault tolerance, recoverability |
| Security | confidentiality, integrity, non-repudiation, accountability, authenticity |
| Maintainability | modularity, reusability, analysability, modifiability, testability |
| Portability | adaptability, installability, replaceability |

**Quality-in-use model:** effectiveness, efficiency, satisfaction (usefulness, trust, pleasure,
comfort), freedom from risk (economic / health-safety / environmental), context coverage (completeness,
flexibility).

**How the standard frames quality** (reconstructed): quality = degree of satisfying stated and implied
needs, viewed as **product quality** (internal/external attributes) *and* **quality in use** (outcome in
a context of use). Characteristics are made operational through **quality measures** (measurement
function + method + target value + rating levels). The SQuaRE family (ISO/IEC 25000–25099) splits into
quality management (2500n), model (2501n), measurement (2502n), requirements (2503n) and evaluation
(2504n). ⚠️ ISO/IEC 25010 was revised in 2023 (adding *Safety*); whether a later GOST adoption reflects
it is unverified.

**Mapping to the matrix.** ISO/IEC 25010 supplies the *vocabulary* for the R3/R4 rows (functional
suitability → R3; reliability/security → R4) and R2 (usability/accessibility); portability/maintainability
are the nearest conceptual hooks for C4 migration ([ISO25010], [Spektr]).

---

## QA Methodology by Lifecycle Stage (columns)

### C1 — Design & Development
The sources' centre of gravity. Practices:

- **Design test cases before writing them** — frameworks run tests, they do not design them; "the real
  challenge … is not writing JUnit code but designing decent test cases that may reveal bugs" ([EST]).
  Be **systematic**: "for a given piece of code, any developer should come up with the same test suite" ([EST]).
- **TDD micro-cycle** — write a failing test → minimum code to pass → refactor; seconds-to-minutes per
  spin ([TDD-EC], [Art], [EST], [UTP], [STA]).
- **Testability first** — "Software testing should begin with the testability assessment"; testable code
  is "clean, modular, and reusable" ([STA]). Refactor to create **seams** ("a place where you can alter
  the behavior in your program without editing in that place" — Feathers, [TDD-EC]).
- **Test-first interface design** — "Test-Drive the Interface Before the Internals" ([TDD-EC]).
- **Requirements analysis via test design** — drafting checks/test cases while reading a requirement is
  the fastest *verifiability* probe; "no test ideas ⇒ red flag" ([Kulikov]).
- **Dual-targeting** (embedded) — design from day one to run on the development host *and* the target,
  breaking the hardware bottleneck ([TDD-EC]).
- **Coverage as a gap-finder**, not a target ([UTP], [pytest], [TM]).
- **CI on every change** — tests run on every build and on PR open ([Spektr], [pytest], [TDD-EC]).

### C2 — Operation / Needs satisfaction
- **System / end-to-end testing** — exercise the whole system as the user does; automate the main and
  risky flows; keep E2E thin ([EST], [TM], [Art]).
- **Acceptance testing** — alpha → beta → gamma; BDD/Gherkin scenarios express acceptance criteria in
  business language ([Kulikov], [behave], [EST]).
- **API-level coverage preferred over long E2E in agile** — faster and less brittle ([TM], [API]).
- **Non-functional verification on the services layer** — load, stress, soak, and recovery ("graceful
  degradation under extreme conditions") ([TM], [API]).
- **Shadow / mirroring testing** — replay recorded production inputs against a new version and compare
  outputs; used for migration and rewrite verification ([TM]).
- **Exploratory testing / crawlers** — discover functionality by executing all possible actions ([TM]).
- **Observability of results** — "Сейчас отчеты готовятся только по API-тестам… Необходимы отчеты по
  всем тестированиям" — one unified report across all test types ([Spektr]).

### C3 — Operation / Maintenance
- **Regression suites** — the safety net that makes code "almost fearlessly changed" ([TDD-EC], [Art],
  [UTP]); regression is the raison d'être of unit tests (protection against regressions) ([UTP]).
- **Characterization tests** — pin existing behavior before modifying legacy code; they "also serve as
  the team's long-term memory" ([TDD-EC]).
- **Learning tests** — written for third-party/library code "so we can learn"; "Learning tests are free!
  Or maybe better than free!" ([TDD-EC]).
- **Contract testing (entry/exit) and CDCT** — validate messages at service boundaries; consumer-driven
  contract tests run by the vendor in CI/CD ([API], [TM]).
- **API versioning / backward compatibility** — old endpoints must not break ([API]).
- **Flakiness engineering** — identify and quarantine flaky tests; randomize order to expose hidden
  inter-test dependencies; bound runtime with timeouts ([Art], [pytest], [TM], [EST]).
- **Fault localization** — spectrum-based fault localization: "the faulty element is the one that is
  covered by failing test cases more frequently than the passing ones" ([STA]).
- **Monitoring / logging testability** — decide what/how much logging to test and how to inject loggers
  ([UTP]); monitoring finds bugs the moment they manifest ([EST]).

### C4 — Decommissioning / Migration
Thin across the sources. Nearest material:

- **Shadow testing** as a migration safety net (functional equivalence of old vs new) ([TM]).
- **Rollback / rolling / re-creating deployments** and feature flags ([TM], [Spektr]).
- **API versioning, deprecation redirects, external-API data retention** governed by local jurisdiction
  ([API]).
- **ISO/IEC 25010 Portability** (adaptability, installability, replaceability) and **Maintainability**
  (modifiability, analysability) as conceptual hooks ([ISO25010]).
- ⚠️ **No source addresses data deletion, access revocation, or archival completeness** — a genuine
  lacuna across the sources.

---

## QA Methodology by Conditioning Factor (rows)

### R1 — Environment
- **Technological**: compatibility matrices (Chrome 90+, Firefox 90+, Safari 15+), cloud device farms,
  parallel/orchestrated test execution, provider security, and *when not to use the cloud* ([TM]);
  cross-compilation against the production tool chain to catch environment drift ([TDD-EC]).
- **Regulatory / compliance**: "Compliance testing falls in the local jurisdiction where the API is
  being consumed"; data-retention rules by geo-location ([API]).
- **Corporate**: internal-API IP whitelisting; external-API consistency, security and scalability
  reviews ([API]).
- **Natural / geo**: geo-distribution of users and Disaster Recovery by geography ([QM]); simulator-based
  behavior coverage for cyber-physical systems ([STA]).
- ⚠️ Social/cultural factors are essentially absent across the sources.

### R2 — Ergonomics
- **Test-code ergonomics (developer-facing)**: readability, naming (SUT + scenario + expected behavior),
  no magic values, asserts separated from actions, no logic in tests ([Art], [UTP], [pytest]).
- **UI ergonomics**: localization handling (multi-locale element/text), visual testing (screenshot vs
  approved baseline), accessibility checks, voice testing ([TM], [behave]).
- **Usability as a quality-in-use characteristic** ([ISO25010]).
- **BDD as collaboration ergonomics** — shared understanding of requirements between product owner,
  QA and developers ([behave], [STA]).
- ⚠️ WCAG conformance levels, RTL, cognitive-load measurement are **not** developed by any source.

### R3 — Functions
- **Specification-based testing** — 7-step process: understand requirement → explore → identify
  partitions → analyze boundaries → devise cases → automate → augment with experience ([EST]).
- **Boundary testing** — on-points and off-points; "Bugs love boundaries" ([EST], [Kulikov]).
- **Structural / coverage-based testing** — statement, branch, condition+branch, path, MC/DC, data-flow;
  subsumption orders their strength ([EST], [Kulikov], [STA]).
- **Design by contract** — pre-conditions, post-conditions, invariants; a *design* technique that guides
  what to test and fails fast ([EST]).
- **Property-based testing** — express a property, let the framework generate hundreds of inputs
  ([EST]).
- **Decision tables, state transition, cause-effect, pairwise/n-wise, classification trees, syntax
  testing** — the full catalog ([Kulikov]).
- **Mutation testing** — "purposefully insert a bug … and check whether the test suite breaks" ([EST]).
- **Logging/observability functions are testable functions** ([UTP]).

### R4 — Accidents / Disasters
- **Failure-path testing with doubles** — force exceptions, simulate network failure at an exact point,
  drive timeouts ([EST], [TDD-EC], [Art]); **exploding fakes** assert a collaborator must not be called
  ([TDD-EC]).
- **Negative testing** — invalid/garbage input, missing/incorrect headers, malformed tokens, injection;
  "negative test cases pass when the application behaves correctly" ([Kulikov], [API]).
- **Security testing** — OWASP Top 10, authn/authz (Basic, session, JWT, OAuth2, RBAC/ABAC), session
  hijacking, parameter tampering, SQL injection/RCE ([API], [TM]).
- **Reliability testing** — load/stress/soak, RPO/RTO, circuit breaker, rate limiting, graceful
  degradation, "not-performance" probes that detect silently dead services ([TM], [Spektr]).
- **Fault localization** after failures (SBFL, diagnosis matrix, coincidental-correctness detection)
  ([STA]).
- **Quality gates as accident prevention** — coverage gate, strict compiler checks / fail build on
  unverified null ([Spektr]).

### R5 — Lifecycle technical support
- **Toolchain**: harnesses (Jest, JUnit, NUnit, pytest, Unity, CppUTest), isolation/mock libraries
  (Moq, Mockito, jest.mock, unittest.mock), coverage (JaCoCo, coverage.py), mutation (Pitest),
  property-based (jqwik), E2E (Selenium + Page Object), BDD (behave, SpecFlow, Cucumber) ([Art], [EST],
  [pytest], [TDD-EC], [behave], [STA]).
- **Build automation**: "The goal is a single command build"; "As a precondition to check in, all tests
  must pass" ([TDD-EC]).
- **CI/CD**: tests on every build and on PR open; single report reflecting the current release branch;
  release-branch testing instead of master builds ([Spektr], [pytest]).
- **Test-data & environment management**: dedicated test-data components, fixtures with setup/teardown,
  real DB with versioned schema and migrations (avoid in-memory DBs for integration tests) ([API],
  [pytest], [UTP]).
- **Competencies**: learning tests, Boy Scout rule, pairing on test recipes, code review with a test
  expert ([TDD-EC], [Art], [TM]).
- **Automation ROI discipline**: automate only when ROI is positive; `(manual time + value of potential
  issues) / (time to build automation)` ([TM]).

---

## Matrix Coverage Map

Which technique families close which cells (● strong, ○ partial, — not covered by the sources):

| Factor \ Stage | C1 Design & Dev | C2 Operation / Needs | C3 Operation / Maintenance | C4 Decommissioning |
|---|---|---|---|---|
| **R1 Environment** | ○ compat/toolchain, dual-targeting, CI envs | ○ device farms, cloud parallelization, perf on real env | ○ env-specific skips, external-API monitoring | ○ (only inferred: portability hooks) |
| **R2 Ergonomics** | ● test readability/AAA, BDD collaboration | ● a11y, visual, usability/E2E, localization | ○ failure-diagnostics UX, log ergonomics | — |
| **R3 Functions** | ● spec-based, boundaries, structural, contracts, property-based, TDD, mutation | ● integration/system/E2E, acceptance, API, shadow testing | ● regression, characterization, contract/CDCT, versioning | ○ shadow testing, migration equivalence |
| **R4 Accidents** | ● failure-path doubles, negative testing, security baked early, coverage gate | ● load/stress/soak, security, monitoring, "not-perf" probes | ● fault localization, flakiness handling, rollback, bug-rate tracking | ○ rollback strategy, migration data safety |
| **R5 Lifecycle support** | ● test framework/CI, testability metrics, refactoring tooling, automation ROI | ● CI/CD pipelines, unified reporting, release dashboards | ● maintainable tests, test-suite cleanup, runbooks | ○ (nothing dedicated) |

---

## Core Technique Toolkit

### Test levels & the pyramid
- Levels: **unit → integration → E2E** ([Art], [EST], [UTP], [Kulikov]); API/service sits in the middle
  tier ([API], [TM]).
- **Ratio rule of thumb**: "at least one to five between levels" — e.g. 100 unit : 10 integration : 1 E2E
  ([Art]); keep tests at the correct level and **do not repeat a scenario at multiple levels** ([Art],
  [TM]).
- **Push testing down**: test business rules at unit level, integration points at integration level
  ([EST]); move business-logic tests out of API tests into unit tests ([Spektr]).
- **Placement**: structural/unit tests live in the same project and language as the code ([TM]).
- Anti-patterns: **end-to-end-only** (slow, flaky, expensive confidence) and **low-level-only** (fast but
  insufficient confidence) ([Art]).

### Test-design techniques (catalog)
| Technique | What it is | When to use | Cell |
|---|---|---|---|
| Equivalence partitioning | Group inputs with identical behavior; test one representative per partition | Default technique for any parameter range | 3.1 |
| Boundary value analysis | On-points and off-points at partition edges; "bugs love boundaries" | Building on partitions; high defect yield | 3.1 |
| Domain analysis | Multi-variable classes + boundaries, minimal representative set | Several interdependent parameters | 3.1 |
| Decision table testing | Cases from combinations of conditions (causes) → actions (effects) | Business rules with condition/action logic | 3.1 |
| State transition testing | Cases for valid/invalid transitions from a state diagram/table | Stateful flows | 3.1 |
| Cause-effect graphing | Cases from a cause↔effect graph (black-box) | Complex logical input/output interdependencies | 3.1 |
| Pairwise / n-wise, orthogonal arrays | Cover all *pairs* of values instead of all combinations | Combinatorial explosion | 3.1 |
| Classification tree | Cases from hierarchically ordered equivalence classes | Structured multi-criteria input space | 3.1 |
| Syntax testing | Cases from the syntax definition of the input/output domain | Parsers, formats, protocols | 3.1 |
| Property-based testing | Express a property; the framework generates hundreds of inputs | When example-based tests feel insufficient | 3.1 |
| Structural / coverage-based | Statement, branch, condition+branch, path, MC/DC, data-flow | Complement to specification testing — never alone | 3.1 |
| Mutation testing | Insert artificial bugs; measure how many the suite kills | Sensitive/high-risk parts; gate on fault-detection strength | 3.1 |
| Design by contract | Pre/post-conditions, invariants | Modeling class/method contracts; fail fast | 3.1, 4.1 |
| Error guessing / failure-directed | Use knowledge of past mistake types | Tester experience available | 4.1 |
| Exploratory testing | Simultaneous learning, design and execution; crawlers | Unknown behavior; finished product | 3.2 |
| Random testing (operational profile) | (Pseudo)random data matching an operational profile | Reliability/performance attributes | 4.1 |
| A/B (split) testing | Vary one parameter/UI variant; compare user reaction | Usability/feature experiments (often in production) | 2.2 |
| Parallel / back-to-back testing | Compare new vs reference system on the same data | Migration/replacement validation | 4.4 |

**Selection heuristics**: the "gentleman's kit" of any tester is equivalence partitioning + boundary
values; escalate to pairwise/domain testing only when combinations explode ([Kulikov]). Combine
techniques — the **pesticide paradox** means "every method you use to prevent or find bugs leaves a
residue of subtler bugs against which those methods are ineffectual" ([EST]).

### Test doubles
| Double | Role | Assert against it? |
|---|---|---|
| **Dummy** | passed but never used | no |
| **Stub** | breaks **incoming** dependencies (indirect inputs); returns canned data | **never** — "stubs represent waypoints, not exit points" ([Art]) |
| **Fake** | simplified real implementation (e.g. in-memory DB) | no |
| **Spy** | wraps the real object, records calls/parameters | yes, sparingly |
| **Mock** | breaks **outgoing** dependencies; verifies the call happened | yes — "no more than a single mock per test" ([Art]) |

Rules: use the real collaborator when you can, a double only when you must ([TDD-EC]); **mock only at
system boundaries**, keep intra-system communications mock-free ([UTP]); prefer **state testing over
interaction testing** when mocking ([EST]); mocks should appear in only ~2–5% of tests ([Art]); mock only
types you own ([UTP]); use `autospec`/spec so mocks cannot drift from the real interface ([pytest]).
C-specific substitution: link-time, function-pointer, preprocessor (last resort) ([TDD-EC]).

### TDD / BDD
- **TDD** = test-first development, a *defect-prevention* practice, "not a testing technique… a way to
  solve programming problems" ([TDD-EC]). Cycle: red → green → refactor ([TDD-EC], [Art], [EST]).
  "you're basically testing the test itself" when you see it fail then pass ([Art]).
- **BDD** = outside-in, collaboration-focused; express requirements as executable examples
  (Gherkin: Given/When/Then; Scenario Outline + Examples; Background; Tags) ([behave], [STA], [EST]).
  "BDD advises you to test WHAT your application should do, not HOW it is done" ([behave]). Don't test
  the UI through BDD — exercise the model layer / REST API instead ([behave]).
- **Caution**: prefer plain xUnit over BDD when the outcome is equivalent and BDD adds only incidental
  complexity ([Spektr]).

### Test-quality criteria
**Khorikov's four pillars of a good test** ([UTP]): (1) protection against regressions, (2) resistance to
refactoring, (3) fast feedback, (4) maintainability. A test that fails when implementation details change
without behavior change produces **false positives**, which train developers to ignore real failures.

**Osherove's good-test properties** ([Art]): easy to understand intent, easy to read and write,
automated, consistent in results, actionable on failure, one-button runnable; a *unit* test additionally
runs fast, has full control, is fully isolated, runs in memory, is as synchronous/linear as possible.
Three criteria: **readability, maintainability, trust**.

**FIRST** ([TDD-EC]): Fast, Isolated, Repeatable, Self-verifying, Timely.

**Aniche's maintainable-test principles** ([EST]): fast; cohesive, independent and isolated; a reason to
exist; repeatable and not flaky; strong assertions; break if behavior changes; a single clear reason to
fail; easy to write; easy to read; easy to change.

**Universal rule**: "Only write tests that will eventually catch a bug" ([EST]).

### Coverage & mutation
- Metrics: line coverage, branch coverage, condition+branch, path, MC/DC; subsumption orders strength
  ([EST], [Kulikov]); branch coverage is more informative than line coverage but still insufficient
  ([UTP]).
- Two inherent limits ([UTP]): coverage cannot prove that *all components of a result* are asserted
  (assertion-free tests reach 100%), and no metric sees branches inside external libraries.
- **Coverage as a goal is an anti-goal**: "Метрики покрытия — хороший негативный, но плохой позитивный
  признак" — useful as a low-end alarm (e.g. <60% signals a problem), harmful as a target ([UTP]).
- **Mutation testing** is a stronger fault-detection signal than branch coverage; use it on sensitive
  parts, triage surviving mutants manually ([EST]).

### Automation, CI/CD & quality gates
- **Four-step automation method** ([TM]): recognize repetitive tasks and compute savings → write code →
  identify when it must run (post-feature/trigger/schedule) → define success measures (log, alert on
  failure, notify on success).
- **CI definition** ([pytest]): tools "build and run tests all on their own, usually triggered by a merge
  request"; enables several integrations a day.
- **Delivery vs discovery pipelines** ([Art]): blocking tests (unit, E2E, system, security) must be fast
  and gate release; good-to-know tests (coverage/complexity scanning, load, long-running non-functional)
  never block release.
- **Gates observed across the sources**: minimum coverage threshold ([pytest]); coverage-based quality gate
  to prevent degradation ([Spektr]); strict compiler checks / fail build on unverified null ([Spektr]);
  all tests must pass before check-in ([TDD-EC]); mutation coverage on sensitive modules ([EST]).
- **Reporting**: a single unified report (e.g. Allure) aggregating all test types — "Качественно сделать
  без единого отчета практически невозможно" ([Spektr]).

### API testing
- **Definition**: "testing the end points of the given API based on the given contract"; gray-box,
  business-workflow oriented ([API]).
- Types: functional, performance, security, noise, error-code/message, scale, compliance, CDCT ([API]).
- **Schema validation** — data types, required params, object vs array ([API]).
- **Headers** — correct, missing, incorrect, unsupported/expired; content-type; tokens; "request headers
  can be exploited by a hacker" ([API]).
- **Negative body catalogue** — unsupported format, special chars, long strings, invalid method/value,
  wrong datatype, empty, null, missing/redundant fields, delete-already-deleted, duplicates ([API]).
- **Auth**: HTTP Basic, session, token/JWT, OAuth2; authorization via RBAC/ABAC ([API]).
- Test hygiene: one objective per test, single assertion library, no ordering/inter-test imports, no DB
  or shell access from a test, no hard sleeps ([API]).

### Test data & environments
- Fixtures implement "an elegant separation of complex system state and test code" ([pytest]); scopes
  control how often setup/teardown runs; share via `conftest.py` ([pytest]).
- Use **real dependencies unless there is a reason to mock** ([EST]); test a **real database** in
  integration tests with versioned schema and migrations, one instance per developer; **avoid in-memory
  databases** for integration tests and clean data between runs ([UTP]).
- Generate synthetic data (Faker/factories) for volume and variety, but keep assertions on *known* data
  ([pytest]).

---

## Measurability Criteria for Requirements

A requirement is **metrologically sound** only if it satisfies all three conditions ([QM]):

1. **Unambiguity** — lexically unambiguous in the target professional domain.
2. **Measurability** — expressed as numeric values, statistical distributions, or dichotomous criteria
   (yes/no) with a clear verification condition.
3. **Admissible class** — one of:
   - **base value ± tolerance** — e.g. API response time ≤ 200 ms ± 10%
   - **min/max bound** — e.g. minimum throughput 1000 RPS
   - **range** — e.g. supported browsers Chrome 90+, Firefox 90+, Safari 15+
   - **multi-dimensional distribution** — e.g. latency p50 ≤ 100 ms, p95 ≤ 200 ms, p99 ≤ 500 ms
   - **deterministic verification algorithm** — e.g. "validate the JWT with RS256 using the public key
     from `.well-known/jwks.json`"

Anything else is **metrologically unsound** (🟠) and does not close a cell.

**Ambiguity red-flag words** (unverifiable by construction, [Kulikov]): адекватно, легко, эффективно,
своевременно, быстро, удобно, просто, гибкий, устойчивый, оптимизировать, минимизировать, TBD,
if possible.

**Requirement-quality properties** ([Kulikov], used as the checklist when testing requirements):
completeness (завершённость), atomicity (атомарность), consistency (непротиворечивость),
unambiguousness (недвусмысленность), feasibility (выполнимость), obligatoriness/up-to-dateness
(обязательность и актуальность), traceability (прослеживаемость), modifiability (модифицируемость),
ranked importance (проранжированность), correctness & **verifiability** (корректность и проверяемость).
**Verifiability is the keystone** — only verifiable requirements permit an objective test case.

**Traceability** — vertical (between requirement levels) and horizontal (requirement ↔ test
plan/cases/architecture), maintained via a traceability matrix that also expresses *coverage achieved*
([Kulikov]).

---

## Metrics, Gates & Definition of Done

| Metric / gate | Definition & source |
|---|---|
| Line / branch coverage | executed lines/branches ÷ total; a low-end alarm, never a target ([UTP], [pytest], [EST]) |
| Mutation coverage | killed ÷ all mutants; stronger than branch coverage; sensitive parts only ([EST]) |
| Test-count balance | count tests per method to detect skew across the pyramid ([Spektr]) |
| Bug rate / bug-fixed rate | track both to ensure we don't create bugs we will never fix ([Spektr]) |
| Flakiness rate | false failures erode trust; detect, quarantine, fix root causes ([Art], [pytest]) |
| Test-run summary | tests, ran, checks, ignores, failures, elapsed ms ([TDD-EC]) |
| Target size/memory | CI reads the map file and computes code-area usage each iteration ([TDD-EC]) |
| Deployment sign-off time | "The ideal time should be under 15 minutes" ([TM]) |
| Quality gate (coverage) | block merge/build on coverage regression ([Spektr], [pytest]) |
| Unverified-null gate | fail the build on unverified `null` ([Spektr]) |
| DOD (testing) | a task cannot be closed unless it is verifiable per the pyramid; testing is part of task cost ([Spektr]) |

---

## Best Practices (consolidated)

1. **Design tests systematically** so any developer derives the same suite ([EST]).
2. **Start testing with requirements** — defects found there are orders of magnitude cheaper ([Kulikov]).
3. **Write the test first** — TDD as defect prevention ([TDD-EC], [Art], [EST]).
4. **Test at the right level; do not duplicate scenarios across levels** ([Art], [TM]).
5. **Push logic tests down to the unit level** ([EST], [Spektr]).
6. **Combine techniques** — no single technique is sufficient (pesticide paradox) ([EST], [Kulikov]).
7. **Prioritize by risk and bug clustering** — bugs are not uniformly distributed ([EST]).
8. **Follow the chronology positive→negative, simple→complex** — avoid an app that passes edge chaos but
   fails daily tasks ([Kulikov]).
9. **Test functional before non-functional** — non-functional is meaningless on broken functionality ([Kulikov]).
10. **Prefer the real collaborator; fake only when necessary** ([TDD-EC], [EST]).
11. **Prefer state testing over interaction testing; mock only at boundaries** ([EST], [UTP]).
12. **Keep tests fast, isolated, repeatable, strongly asserted** ([EST], [Art], [TDD-EC]).
13. **Treat test code as production code** — it is a liability with maintenance cost ([UTP]).
14. **Assess testability before testing** ([STA]).
15. **Automate only when ROI is positive** ([TM]).
16. **Integrate tests into CI on every change** ([pytest], [TDD-EC], [Spektr]).
17. **Aggregate all test evidence into one report** ([Spektr]).
18. **Write characterization tests before changing legacy code** ([TDD-EC]).
19. **Write bug reports that are easy to verify** — reproducible steps let devs fix and testers confirm ([Kulikov]).
20. **Keep every requirement atomic, unambiguous and traceable** ([Kulikov], [QM]).

---

## Common Pitfalls & Anti-patterns (consolidated)

| Pitfall | Why it hurts | Source |
|---|---|---|
| **Treating coverage as a goal** | 100% coverage with assertion-free tests proves nothing; drives `try/catch`-wrapped empty tests | [UTP], [EST], [pytest], [TM] |
| **Confusing mocks and stubs** | "mock" as a catch-all creates over-specification and fragility | [Art], [UTP] |
| **More than one mock per test / verifying stubs** | over-specification; tests break on refactoring | [Art], [UTP] |
| **Assertion-free tests** | pass forever while covering code | [UTP], [API] |
| **Logic in tests** | dynamic expected values hide bugs and cloud trust | [Art] |
| **Interleaved Arrange-Act-Assert-Act…** | any action may be the cause; hard to debug | [pytest] |
| **Looping many cases inside one test** | one reported case; failure does not identify the case | [pytest] |
| **Ordered / interdependent tests** | cascading skips; masked coupling | [API], [pytest] |
| **End-to-end-only or low-level-only suites** | expensive/flaky, or insufficient confidence | [Art] |
| **Over-flexible mocks (no spec)** | mock drift hides misspelled methods and signature changes | [pytest] |
| **Faking what you shouldn't** | e.g. faking a linked list adds fragility without benefit | [TDD-EC] |
| **Testing private methods / exposing private state** | fragility and/or insufficient coverage | [UTP], [Art] |
| **High coupling between tests** | one test changes another's result | [UTP] |
| **In-memory DB for integration tests** | tests pass in memory, fail in production | [UTP], [Art] |
| **Flaky tests left unaddressed** | erode trust; the suite stops adding value | [Art], [TM] |
| **Coverage cheating / PFM on dynamic UIs** | false failures and stale-element exceptions | [TM] |
| **Shadow testing without privacy controls** | recording production data breaches privacy law | [TM] |
| **Ambiguous requirement wording** | unverifiable by construction | [Kulikov], [QM] |
| **Zero-defect expectation** | unattainable target; strategy must state a balance | [Spektr] |
| **Reporting only one test layer** | fire-and-forget load tests; ignored E2E results | [Spektr] |
| **Refactoring that degrades testability** | e.g. Extract Method with many parameters lowers testability | [STA] |
| **Coincidentally-correct tests** | inflate passing statistics, corrupt fault localization | [STA] |
| **Testing without a testability assessment** | "a potentially costly and ineffective approach" | [STA] |
| **AI over-trust** | models can succeed by chance; "too much accuracy" misleads | [TM] |
| **Automation for its own sake** | automating as a skill display rather than for savings | [TM] |
| **Correctness-by-design as sufficient** | "designing your code well does not mean you avoid all possible bugs" | [EST] |
| **Verification without validation** | a bug-free system nobody needs | [EST] |

---

## Coverage Gaps

Explicit lacunae across all sources (do not attribute these to any single source):

- **C4 Decommissioning / Migration** — no source treats data deletion, access revocation, archival
  completeness, or migration verification methodologically; only shadow testing, rollback and API
  versioning touch it ([TM], [API], [Spektr]).
- **R1 social/cultural factors** (languages, cultural norms, user mentality, human factor, hacking) —
  absent across the sources.
- **R2 accessibility conformance** — WCAG levels, RTL, cognitive-load measurement are not developed;
  accessibility appears only as a checklist item ([TM], [ISO25010]).
- **R1 regulatory detail** — GDPR/152-ФЗ/HIPAA/PCI DSS specifics appear only as isolated mentions
  ([API], [Kulikov]); no source provides a compliance-testing method.
- **Security testing depth** — present as checklists ([API], [TM]) but no threat-modeling methodology.
- **Performance/load methodology** — load/stress/soak are named ([TM], [Kulikov]); no modeling method.

---

## Source Map

| Short code | Work | Contributes mainly to |
|---|---|---|
| [QM] | `quality-matrix` skill (Quality Programming Matrix 5×4) | Base framework: cells, statuses, measurability criteria, open questions |
| [ISO25010] | ГОСТ Р ИСО/МЭК 25010-2015 (= ISO/IEC 25010:2011) — **scanned PDF, reconstructed** | Quality vocabulary: 8 characteristics, quality-in-use, measurement framing |
| [Kulikov] | Software Testing: Base Course (С. Куликов) | Test-design technique catalog, requirement quality, documentation, defect reports, test levels/types |
| [Art] | The Art of Unit Testing, 3rd ed. (Osherove / Khorikov) | Unit of work, entry/exit points, test doubles, test pyramid, pipelines, legacy strategies |
| [UTP] | Принципы юнит-тестирования (V. Khorikov) | Four pillars, false positives/negatives, mocks vs stubs, coverage limits, DB integration testing |
| [EST] | Effective Software Testing (M. Aniche) | Systematic test design, specification/structural/mutation/property-based testing, contracts, testability, test-code quality |
| [TDD-EC] | TDD for Embedded C (J. Grenning) | TDD micro-cycle, FIRST, C test doubles, seams, characterization/learning tests, CI for embedded |
| [STA] | Software Testing Automation (S. Parsa) | Testability metrics, TsDD, automated refactoring, coverage criteria, fault localization, test-data generation |
| [TM] | How to Test a Time Machine (N. Ferrera) | Test architecture, pyramid in 3 dimensions, automation ROI, CI/CD, cloud, AI testing, shadow testing |
| [pytest] | Python Testing with pytest (B. Okken) | Fixtures, parametrization, markers, coverage, tox/CI, flakiness engineering |
| [API] | Learn API Testing (J. Jain) | API test types, schema/header/payload validation, authn/authz, contract testing, framework design |
| [behave] | behave Documentation | BDD/Gherkin, scenarios, hooks/fixtures, tags, BDD anti-patterns (don't test the UI) |
| [Spektr] | Спектр — Тест-стратегия (slide deck) | Test strategy vs plan, pyramid layers, CI/CD gates, unified reporting, DOD, bug-rate metrics |

**Provenance.** Content was distilled from the works listed in the [Bibliography](#bibliography). The
ГОСТ Р ИСО/МЭК 25010-2015 source is a scanned, image-only document with no machine-readable text layer,
so its section is explicitly marked as reconstructed from the ISO/IEC 25010:2011 standard. Other
sources were read selectively (table of contents + methodology chapters); items marked ⚠ or "uncertain"
are flagged in place above.

---

## How to Use This Reference

1. **Auditing requirements (primary use).** Walk the 20 cells of the [matrix](#the-quality-programming-matrix-base-framework).
   For each cell, ask its check question, then apply the
   [measurability criteria](#measurability-criteria-for-requirements) to every candidate answer. Assign
   🔴/🟠/🟡/🟢 and flag ⬆️ hierarchy violations. Emit the verdict and a prioritized list of open
   questions (critical questions for 🔴/🟠 in C2/C3 first — see the `quality-matrix` skill for the full
   question-format).
2. **Choosing techniques.** For a cell you need to close, look it up in the
   [Matrix Coverage Map](#matrix-coverage-map) and the [Core Technique Toolkit](#core-technique-toolkit),
   then pick the technique family and its quality criteria.
3. **Reviewing test suites.** Apply the [test-quality criteria](#test-quality-criteria) and the
   [pitfalls table](#common-pitfalls--anti-patterns-consolidated) as a review checklist.
4. **Setting gates.** Use [Metrics, Gates & DoD](#metrics-gates--definition-of-done) to wire CI gates
   that do not degrade into coverage theatre.

---

## Bibliography

Works distilled into this reference. Inline citations use the short codes defined in the [Source map](#source-map).

- Khorikov, *Unit Testing Principles, Practices, and Patterns* («Принципы юнит-тестирования», RU)
- Osherove & Khorikov, *The Art of Unit Testing*, 3rd ed. (with examples in JavaScript)
- Aniche, *Effective Software Testing: A Developer's Guide*
- Grenning, *Test Driven Development for Embedded C*
- Куликов, *Тестирование программного обеспечения. Базовый курс*
- Parsa, *Software Testing Automation* (Springer)
- Ferrera, *How to Test a Time Machine*
- Okken, *Python Testing with pytest*, 2nd ed.
- Jain, *Learn API Testing: Norms, Practices, and Guidelines*
- *behave* documentation — Behaviour-Driven Development for Python
- ГОСТ Р ИСО/МЭК 25010-2015 (= ISO/IEC 25010:2011) — *Информационные технологии. SQuaRE. Модели качества систем и программного обеспечения*
- Спектр, «Тестирование: Тест-стратегия» (slide deck)

**See also**

- `quality-matrix` skill — `.agents/skills/quality-matrix/SKILL.md` (base methodology)
- `.ai-factory/references/software-requirements-wiegers-beatty.md` — requirements engineering
