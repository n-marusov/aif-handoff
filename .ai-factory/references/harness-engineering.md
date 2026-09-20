# Harness Engineering Reference

> Source:
> - https://www.anthropic.com/engineering/building-effective-agents
> - https://github.com/humanlayer/12-factor-agents
> - https://raw.githubusercontent.com/humanlayer/12-factor-agents/main/content/factor-02-own-your-prompts.md
> - https://raw.githubusercontent.com/humanlayer/12-factor-agents/main/content/factor-03-own-your-context-window.md
> - https://raw.githubusercontent.com/humanlayer/12-factor-agents/main/content/factor-08-own-your-control-flow.md
> - https://raw.githubusercontent.com/humanlayer/12-factor-agents/main/content/factor-09-compact-errors.md
> - https://github.com/openai/evals
> - https://www.promptfoo.dev/docs/intro/
> Created: 2026-09-20
> Updated: 2026-09-20

## Overview

Harness engineering is the practice of building deterministic software layers around an LLM so quality, safety, and cost are controlled by code rather than prompt-only instructions. In production terms, model quality is necessary but insufficient: reliability mostly comes from constraints, orchestration, verification, and observability.

Across published guidance and practitioner material, the same pattern repeats: successful systems use simple, composable control loops and explicit tool interfaces instead of deep framework abstraction. The LLM is a decision component inside a larger system, not the whole system.

For software quality, harness engineering translates to classic QA principles adapted for stochastic components: define invariants, test with representative datasets, gate risky actions, monitor runtime behavior, and make failure states explicit and recoverable.

## Core Concepts

### 1) LLM loop + deterministic executor
A practical agent loop is:
1. Model chooses next action (often structured/tool call).
2. Deterministic code executes the action.
3. Result (or error) is fed back as context.
4. Stop on success/limits/escalation.

This framing makes QA concrete: you can test each boundary (selection, execution, result handling, stopping policy) independently.

### 2) Workflows vs fully autonomous agents
Per Anthropic guidance, start with the simplest architecture:
- **Workflows**: predefined orchestration paths; higher predictability.
- **Agents**: model-directed multi-step execution; higher flexibility and risk.

Quality implication: prefer workflow patterns until metrics show you need agent autonomy.

### 3) Four practical harness functions
A robust harness usually implements:
- **Constrain**: what is physically allowed (permissions, limits, tool scope).
- **Inform**: clear prompts/tool descriptions/context shaping.
- **Verify**: pre- and post-execution checks, evals, policy gates.
- **Correct**: retries, fallback paths, rollback/escalation.

### 4) Own prompts, context, and control flow
From 12-factor-agents methodology:
- prompts are first-class artifacts (versionable/testable),
- context construction is engineered (not accidental chat logs),
- control flow is application code (pause/resume/handoff),
- errors are compacted and fed back intentionally (with thresholds).

### 5) ACI (Agent–Computer Interface)
Tool interfaces are part of quality-critical design. Better tool schemas/descriptions reduce model confusion and failure rates. Treat tool docs as executable interface contracts.

## API / Interface

### OpenAI Evals (repository-level interface cues)
From `openai/evals` README:

- Minimum runtime: `Python 3.9`
- Install:
```sh
pip install evals
```
- Dev install:
```sh
pip install -e .
```
- Key environment variable:
- `OPENAI_API_KEY`

Optional logging-related env vars mentioned in repo docs:
- `SNOWFLAKE_ACCOUNT`
- `SNOWFLAKE_DATABASE`
- `SNOWFLAKE_USERNAME`
- `SNOWFLAKE_PASSWORD`

### Promptfoo (intro-level interface cues)
From docs intro:
- `promptfoo` is an open-source CLI/library for LLM evaluation and red teaming.
- Focus areas: automated testing, benchmarking, security testing.

(For full command-level interface, use Promptfoo configuration/usage docs in subsequent references.)

## Usage Patterns

### Pattern A: Bounded autonomous loop
Use a hard limit on steps and per-tool retries. Escalate when exceeded.

```python
while True:
  next_step = await llm.determine_next_step(context)
  context.append(next_step)

  if (next_step.intent === "done"):
    return next_step.final_answer

  result = await execute_step(next_step)
  context.append(result)
```

(Adapted from 12-factor-agents conceptual loop.)

### Pattern B: Error compaction + controlled retry
Keep recoverable failures in context, but cap consecutive attempts.

```python
while True:
  next_step = await determine_next_step(thread_to_prompt(thread))
  thread["events"].append({
    "type": next_step.intent,
    "data": next_step,
  })
  try:
    result = await handle_next_step(thread, next_step) # our switch statement
  except Exception as e:
    # if we get an error, we can add it to the context window and try again
    thread["events"].append({
      "type": 'error',
      "data": format_error(e),
    })
    # loop, or do whatever else here to try to recover
```

### Pattern C: Human approval breakpoints
Interrupt between tool selection and tool invocation for high-risk actions (deploy/delete/payment/etc.). Resume only after explicit approval.

### Pattern D: Evaluator-optimizer loop for quality lift
Use a second evaluator step when criteria are explicit and measurable (e.g., coding task correctness, policy compliance). Stop after threshold or budget.

### Pattern E: Model routing by task class
Route simple requests to cheaper models and hard cases to stronger models using deterministic classification or model-assisted routing.

## Configuration

| Area | Recommended configuration | Why it matters |
|---|---|---|
| Iteration control | `max_steps` per run | Prevents infinite loops and cost runaway |
| Retry policy | `max_retries_per_tool`, backoff | Limits repeated failures, avoids hot loops |
| Budgeting | token/cost/time budgets per run | Keeps spend predictable |
| Tool scope | least privilege, per-agent tool allowlist | Reduces blast radius |
| Approval gates | required for irreversible actions | Prevents catastrophic side effects |
| Context policy | summarization/compaction strategy | Controls token growth and drift |
| Eval cadence | baseline eval set + regression checks | Detects quality drift after model/prompt/tool changes |
| Observability | traces, tool-level metrics, error taxonomy | Enables debugging and SLO management |
| Stop policy | done criteria + abort criteria | Makes termination deterministic |

## Best Practices

1. Start with the simplest architecture (single call or fixed workflow), then add autonomy only when metrics justify it.
2. Keep harness logic deterministic: constraints, validations, stop conditions, and approval gates must not depend on model mood.
3. Treat prompts and tool specs as code: version, diff, test, rollback.
4. Validate tool arguments before execution, not only outputs after execution.
5. Add explicit iteration and retry limits to every loop.
6. Separate recoverable vs terminal errors and encode different policies for each.
7. Build eval datasets from real production-like tasks, not generic benchmarks alone.
8. Observe everything at tool-call granularity: latency, success, retries, token/cost, escalation rate.
9. Add human checkpoints at high-stakes transitions.
10. Prefer many small focused agents/workers over one oversized general agent when domains diverge.
11. Use sandboxed environments for early rollouts and risky capabilities.
12. Re-test whenever model, prompt template, tool schema, or context policy changes.

## Common Pitfalls

- **Framework lock-in without visibility**: teams cannot debug prompts/context beneath abstractions.
- **No hard limits**: loops spin and costs explode.
- **Prompt-only guardrails**: model can still invoke dangerous actions unless blocked in code/policy.
- **Unstructured tool errors**: model cannot recover if errors are noisy or ambiguous.
- **No golden eval set**: model upgrades cause silent regressions.
- **Context bloat**: full raw history degrades quality and increases cost.
- **Missing pause/resume semantics**: no safe way to approve high-risk calls.
- **Post-hoc validation only**: irreversible damage can happen before checks run.

## Version Notes

- Anthropic page notes that tooling landscape has evolved since its original publication date; patterns remain useful as architectural guidance.
- `openai/evals` repo currently points users to Dashboard-based eval setup while retaining repository-based framework documentation and templates.

## Practical QA Checklist (Harness-focused)

- [ ] `max_steps` defined for every autonomous run.
- [ ] Per-tool retry ceilings and exponential backoff configured.
- [ ] Cost/time/token budgets enforced in code.
- [ ] High-risk tools protected by approval gate.
- [ ] Tool argument schema validation before execution.
- [ ] Structured error format returned to model.
- [ ] Golden eval suite runs before model/prompt/tool rollout.
- [ ] Observability includes trace IDs across full loop.
- [ ] Escalation path to human exists and is tested.
- [ ] Rollback strategy documented for prompt and model changes.
