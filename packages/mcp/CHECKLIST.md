# @aif/mcp — Checklist

Run through this list whenever you touch anything under `packages/mcp/`.

- [x] New or changed MCP tools must stay consistent with the equivalent `@aif/api` routes — do not let the two drift apart. (Task 21: createTask/updateTask/pushPlan now call the SAME `@aif/data` taskOperations contract as the API use cases; `tools.contract.test.ts` pins both surfaces.)
- [x] All DB access goes through `@aif/data`. No direct drizzle/SQL imports here. (Writer tools import `createTaskManaged`/`updateTaskManaged`/`setTaskPlanContentManaged` from `@aif/data`; no raw mutation imports remain.)
- [x] Validate every tool input with Zod and return structured errors — MCP clients parse them. (Schemas unchanged; runtime-profile rejection maps `invalid_runtime_profile` → `-32602` validation error.)
- [x] Add unit tests for each new tool (happy path + one failure path). (Task 21 updated `taskToolsRuntimeContract.test.ts` + `runtimeTaskMetadata.test.ts` to the shared contract; 118/118 green.)
- [x] `npm run lint`
- [x] `npm test`
