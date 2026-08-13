# GitLab REST API Reference

> Source:
> - https://docs.gitlab.com/api/rest/
> - https://docs.gitlab.com/api/issues/
> - https://docs.gitlab.com/api/merge_requests/
> - https://docs.gitlab.com/api/notes/
> - https://docs.gitlab.com/api/commits/
> - https://docs.gitlab.com/api/merge_request_approvals/
> - https://docs.gitlab.com/api/projects/
> Created: 2026-08-13
> Updated: 2026-08-13

## Overview

The GitLab REST API (major version `4`, path prefix `/api/v4`) lets external services automate project, issue, merge request, CI/CD, and repository operations. It is the API consumed by the project's GitLab integration (`packages/api/src/services/gitlab.ts`, class `GitLabClient`), which performs:

- Connect-time validation of a `namespace/project` path (`GET /projects/:id`)
- Issue fetching + comments for backlog/sync (`GET /projects/:id/issues`, `GET /projects/:id/issues/:issue_iid/notes`)
- Merge-request discovery, publication, and update (`GET/POST/PUT /projects/:id/merge_requests[...]`)
- Review-state checks via MR approvals (`GET /projects/:id/merge_requests/:merge_request_iid/approvals`)
- CI status folding via commit statuses (`GET /projects/:id/repository/commits/:sha/statuses`)
- Idempotent comment upsert via MR notes (`GET/POST/PUT /projects/:id/merge_requests/:merge_request_iid/notes[...]`)

The API is versioned per semantic versioning. The major version (`4`) is stable; the minor version is implicit, so new fields and endpoints can be added without a version bump. Breaking changes are only introduced with a major version change (planned v5). Experimental/beta elements and fields behind disabled feature flags can be removed at any time without notice.

All responses are JSON. List endpoints are paginated and return 20 results by default.

## Authentication

All endpoints require authentication except a few read-only public-project endpoints.

| Method | Header / mechanism | Notes |
|---|---|---|
| Personal access token | `PRIVATE-TOKEN: <token>` | The token this project sends on every request in `GitLabClient.request()`. Scopes: `api`, `read_api`, `read_repository`, `write_repository`. |
| OAuth2 token | `Authorization: Bearer <token>` | OAuth2 access tokens from the `/oauth/token` endpoint. |
| Job token | `JOB-TOKEN: <token>` | Used inside CI/CD jobs. |
| Session cookie | Cookie-based | Interactive UI sessions. |
| Deploy token | `Deploy-Token: <token>` | For read-only repository access. |

Personal access tokens are the preferred method for automation (recommended by GitLab docs for private project access).

## Request Format

### Base URL and versioning

```
GET https://<gitlab-host>/api/v4/<path>
```

### Path parameters

Documented with a leading colon, e.g. `DELETE /projects/:id/share/:group_id`. Replace with the actual value; never include the colon. `:id` for project-scoped endpoints is either the numeric project `id` **or** the URL-encoded `namespace%2Fpath` string.

### `id` vs `iid`

- `id` — globally unique across all projects.
- `iid` — internal ID shown in the web UI, unique within a single project.

Resources that have both (issues, merge requests, milestones) are fetched by `iid`. Example: project `id: 42`, issue `id: 46`, `iid: 5` → `GET /projects/42/issues/5` is valid, `GET /projects/42/issues/46` is not.

### Encoding

- Namespaced project paths must be URL-encoded: `/` → `%2F`. `GET /api/v4/projects/diaspora%2Fdiaspora`.
- File paths, branches, and tags containing `/` must be URL-encoded (e.g. `src%2FREADME.md`, `my%2Fbranch`).
- If a required path parameter is not encoded, GitLab responds `404` (the route does not match).
- `+` in query parameters must be encoded as `%2B` (W3C: `+` decodes to a space). Relevant for ISO 8601 timestamps with a timezone offset: `2017-10-17T23:11:13.000%2B05:30`.
- Array params use `[]` suffix: `iids[]=42&iids[]=43`. Hashes use `[key]=value`.

The project's `GitLabClient.projectPath(namespace, name)` uses `encodeURIComponent(`${namespace}/${name}`)` so `namespace/name` becomes `namespace%2Fname` — matching the documented encoding requirement.

### Response quirks

- Boolean fields can legitimately be `null`; GitLab treats `null` booleans as `false`. When sending boolean arguments, only send `true`/`false`.
- After a project path change, GETs on the old path may redirect with the new location in the `Location` header. Follow it.

## Pagination

Offset-based pagination is the default (except `users` endpoint, which is keyset-only from GitLab 17.0+).

| Parameter | Description |
|---|---|
| `page` | Page number (default `1`). |
| `per_page` | Items per page (default `20`, max `100`). |

Pagination response headers:

| Header | Description |
|---|---|
| `x-next-page` | Index of the next page. |
| `x-page` | Current page (starts at 1). |
| `x-per-page` | Items per page. |
| `x-prev-page` | Index of the previous page. |
| `x-total` | Total items. |
| `x-total-pages` | Total pages. |
| `Link` | Full URLs with `rel="prev"`, `"next"`, `"first"`, `"last"`. Prefer these over generating your own URLs. |

Notes:
- GitLab.com may omit some pagination headers.
- If a query returns more than 10,000 records, GitLab omits `x-total`, `x-total-pages`, and the `rel="last"` link (performance).
- The Commits API never returns `x-total` / `x-total-pages`.

`GitLabClient.list<T>()` implements offset pagination by requesting `per_page=100` and following pages until a page returns fewer than 100 items — a valid approach for collections under ~50k records.

### Keyset pagination (advanced)

Enabled with `pagination=keyset`, requires `order_by` and `sort`. Server adds `id_after=` / `cursor=` filters to the `rel="next"` `Link` header. Only a subset of resources/orderings support it (projects `order_by=id`, project issues `order_by=created_at|updated_at|title|id|weight|due_date|relative_position` from GitLab 18.3, users, etc.). Use only the provided `Link` for the next page.

## Rate Limiting and Errors

REST API requests are subject to instance rate limits. GitLab.com has its own documented limits. On `429 Too Many Requests`, GitLab returns a `Retry-After` header (seconds). Some rate-limited endpoints return 429 only under specific conditions (e.g. MR list `search`).

HTTP error semantics used by GitLabClient (`classifyHttpError`):

| Status | `GitLabApiError.adapterCode` | Typical cause |
|---|---|---|
| `401` | `authentication` | Invalid/missing token. |
| `403` | `forbidden` | Token lacks permission; e.g. issues disabled on the project → `403 {"message":"403 Forbidden"}`. |
| `404` | `not_found` | Project/resource missing, OR the token cannot see a private project (GitLab hides existence), OR unencoded path. |
| `422` | `validation` | Request validation failed. |
| `429` | `rate_limited` | Rate limit exceeded; check `Retry-After` header. |
| other | `upstream` | Server/transient errors. |

For `429`, the project's client reads `retry-after` (seconds) or `ratelimit-reset` (epoch seconds) headers to compute `retryAt`.

## Projects API

### Get single project

`GET /projects/:id`

Validates a project and returns its attributes. Accessible without auth if public.

Key response fields used by the project's `GitLabClient.getRepository()`:

```json
{
  "id": 3,
  "name": "Diaspora Project Site",
  "path_with_namespace": "diaspora/diaspora-project-site",
  "default_branch": "main",
  "web_url": "http://example.com/diaspora/diaspora-project-site",
  "visibility": "private",
  "archived": false,
  "empty_repo": false,
  "merge_requests_enabled": true,
  "issues_enabled": true
}
```

Optional params: `statistics` (boolean, Reporter+), `license` (boolean), `with_custom_attributes` (boolean, admin).

### Project-scoped identifiers

For all project-scoped endpoints, `:id` is either the numeric project `id` or the URL-encoded `path_with_namespace` (`namespace%2Fproject`). The project's client always uses the encoded path so connect/sync/publish never needs an extra resolution request.

## Issues API

### List project issues

`GET /projects/:id/issues`

Project-scoped issue listing. 20 per page by default; paginated.

Useful filters: `state` (`opened` | `closed` | `all`), `scope` (`created_by_me` | `assigned_to_me` | `all`, default `all` for project scope), `assignee_username[]`, `author_username`, `labels` (comma-separated, AND semantics), `milestone` (title), `iids[]`, `order_by` (`created_at` default), `sort` (`desc` default), `search`, `updated_after`, `updated_before`, `confidential`, `not[...]`.

The project's client calls: `GET /projects/:id/issues?scope=all&state=opened&order_by=updated_at`.

### Issue object (relevant fields)

```json
{
  "id": 41,
  "iid": 1,
  "project_id": 4,
  "state": "opened",
  "title": "Ut commodi ullam eos dolores perferendis nihil sunt.",
  "description": "Omnis vero earum sunt corporis dolor et placeat.",
  "labels": ["foo", "bar"],
  "author": { "id": 18, "username": "eileen.lowe", "name": "Alexandra Bashirian" },
  "assignees": [{ "id": 1, "username": "root", "name": "Administrator" }],
  "milestone": { "id": 11, "iid": 3, "title": "v3.0", "state": "closed" },
  "created_at": "2016-01-04T15:31:39.788Z",
  "updated_at": "2016-01-04T15:31:46.176Z",
  "web_url": "http://gitlab.example.com/my-group/my-project/issues/1"
}
```

Notes:
- `labels` may be a string array (`["bug"]`) by default; with `with_labels_details=true` they become objects `{name, color, ...}`. The project's client tolerates both (`label.name ?? label`).
- `assignee` (singular) is deprecated; use `assignees`.
- Premium/Ultimate add `weight`, `epic`, `iteration`; Ultimate adds `health_status`.

### Retrieve a project issue

`GET /projects/:id/issues/:issue_iid`

### Create an issue

`POST /projects/:id/issues`

Required: `title`. Optional: `description` (≤1,048,576 chars), `labels` (comma-separated), `assignee_ids[]`, `milestone_id`, `confidential`, `due_date` (`YYYY-MM-DD`), `issue_type`, `weight`, `epic_id`, `start_date`.

If the project has **Issues** turned off → `403`.

Create requests are rate-limited per user per minute (issue/epic creation rate limits).

### Update an issue

`PUT /projects/:id/issues/:issue_iid`

At least one updatable attribute required. `state_event` (`close` | `reopen`) closes/reopens. Others: `title`, `description`, `labels`, `add_labels`, `remove_labels`, `assignee_ids` (empty to unassign), `milestone_id` (`0`/empty to unassign), `due_date`, `discussion_locked`, `confidential`, `issue_type`, `severity`, `updated_at` (admin/owner only).

### Delete / other issue ops

`DELETE /projects/:id/issues/:issue_iid` → `204 No Content`. `PUT .../reorder`, `POST .../move`, `POST .../clone`. Subscribe/unsubscribe/todo endpoints return `304` when already in the target state.

### Issue → MR relationships

- `GET /projects/:id/issues/:issue_iid/related_merge_requests` — MRs related to the issue.
- `GET /projects/:id/issues/:issue_iid/closed_by` — MRs that close the issue when merged.
- `GET /projects/:id/issues/:issue_iid/participants` — participating users.

## Merge Requests API

### List project merge requests

`GET /projects/:id/merge_requests`

Filters: `state` (`opened` | `closed` | `locked` | `merged` | `all`, default `all`), `source_branch`, `target_branch`, `iids[]`, `author_username`, `assignee_username[]`, `reviewer_username`, `labels`, `milestone`, `scope`, `order_by` (`created_at` default, `merged_at` from 17.2), `sort`, `search`, `draft` (from 19.0; `wip` deprecated in 19.0), `with_merge_status_recheck`.

The project's client lists with `?state=all` and can find an MR by source branch: `?state=all&source_branch=<branch>` (used by `findMergeRequest`).

### Merge request object (relevant fields)

```json
{
  "id": 1,
  "iid": 1,
  "project_id": 3,
  "title": "test1",
  "description": "fixed login page css paddings",
  "state": "merged",
  "source_branch": "test1",
  "target_branch": "main",
  "sha": "8888888888888888888888888888888888888888",
  "merged_at": "2018-09-07T11:16:17.520Z",
  "merge_commit_sha": null,
  "merge_status": "can_be_merged",
  "detailed_merge_status": "not_open",
  "draft": false,
  "web_url": "http://gitlab.example.com/my-group/my-project/merge_requests/1"
}
```

Key notes:
- `state` values: `opened`, `closed`, `merged`, `locked`. `locked` is short-lived/transitional.
- `merge_status` is deprecated (GitLab 15.6); use `detailed_merge_status`.
- `detailed_merge_status` values include: `mergeable`, `conflict`, `not_open`, `draft_status`, `not_approved`, `need_rebase`, `checking`, `unchecked`, `preparing`, `ci_must_pass`, `ci_still_running`, `discussions_not_resolved`, `commits_status`, `merge_request_blocked`, `merge_time`, `requested_changes`, `status_checks_must_pass`, `security_policy_violations`, `locked_paths`, `locked_lfs_files`, `title_regex`, `jira_association_missing`, `approvals_syncing`.
- Listing may not proactively refresh `merge_status`; use `with_merge_status_recheck=true` if you need it fresh (costly).
- `merged_by` deprecated (14.7) → use `merge_user`. `reference` deprecated (12.7) → use `references`.
- `changes_count` and `diff_refs` are empty/asynchronous for newly created MRs.
- `work_in_progress` deprecated → use `draft`.
- `approvals_before_merge` deprecated (16.0) → use the merge request approvals API.

### Retrieve a merge request

`GET /projects/:id/merge_requests/:merge_request_iid`

Optional params: `render_html`, `include_diverged_commits_count`, `include_rebase_in_progress`. Additional fields vs. list: `diff_refs` (`base_sha`, `head_sha`, `start_sha`), `changes_count` (string, capped at `"1000+"`), `head_pipeline`, `subscribed`, `user.can_merge`, `merge_error`.

`GitLabClient.getMergeRequest()` uses this endpoint.

### Create a merge request

`POST /projects/:id/merge_requests`

Required: `source_branch`, `target_branch`, `title`. Optional: `description` (≤1,048,576 chars), `labels`, `assignee_ids[]`, `reviewer_ids[]`, `milestone_id`, `squash`, `remove_source_branch`, `allow_collaboration`, `target_project_id`, `merge_after` (17.8+).

The project's client creates MRs with `remove_source_branch: false`.

### Update a merge request

`PUT /projects/:id/merge_requests/:merge_request_iid`

At least one non-required attribute required. Supports `title`, `description`, `labels`/`add_labels`/`remove_labels`, `assignee_ids` (`0`/empty to unassign), `reviewer_ids`, `milestone_id`, `target_branch`, `state_event` (`close`/`reopen`), `squash`, `remove_source_branch`, `discussion_locked`.

### Merge a merge request

`PUT /projects/:id/merge_requests/:merge_request_iid/merge`

Optional `sha` (must match source HEAD — prevents merging unreviewed commits), `squash`, `merge_commit_message`, `squash_commit_message`, `should_remove_source_branch`, `auto_merge` (replaces `merge_when_pipeline_succeeds`, deprecated 17.11).

Failure statuses: `400` (missing `sha` when required), `401` (no permission), `405` (cannot merge), `409` (SHA mismatch), `422` (branch cannot be merged).

### Other MR endpoints

- `GET .../merge_requests/:merge_request_iid/changes` — deprecated (15.7); use `GET .../diffs`.
- `GET .../merge_requests/:merge_request_iid/commits` — commits in the MR.
- `GET .../merge_requests/:merge_request_iid/closes_issues` — issues closed on merge.
- `GET .../merge_requests/:merge_request_iid/pipelines` — MR pipelines.
- `PUT .../merge_requests/:merge_request_iid/rebase` — async; returns `202` + `{"rebase_in_progress": true}`; poll retrieve-MR with `include_rebase_in_progress`.
- `POST .../merge_requests/:merge_request_iid/cancel_merge_when_pipeline_succeeds`.
- `GET .../merge_requests/:merge_request_iid/approvals` — approval state (see Approvals API).

## Notes (Comments) API

Notes are comments/system records on issues, MRs, epics, snippets, commits, and wikis. `GET` lists return 20 per page (pagination applies). Note creation is rate-limited per minute.

### List issue notes

`GET /projects/:id/issues/:issue_iid/notes`

Params: `sort` (`asc`|`desc`, default `desc`), `order_by` (`created_at`|`updated_at`, default `created_at`), `activity_filter` (`all_notes`|`only_comments`|`only_activity`).

### List merge request notes

`GET /projects/:id/merge_requests/:merge_request_iid/notes`

Same params as issue notes.

### Note object

```json
{
  "id": 302,
  "body": "Text of the comment\r\n",
  "author": { "id": 1, "username": "pipin", "name": "Pip", "state": "active" },
  "created_at": "2013-10-02T09:22:45Z",
  "updated_at": "2013-10-02T10:22:45Z",
  "system": false,
  "confidential": false,
  "internal": false,
  "resolvable": false,
  "noteable_id": 377,
  "noteable_type": "Issue"
}
```

`system: true` marks auto-generated records (state changes etc.). `body` can be `null` for system notes.

### Create / update / delete notes

- `POST /projects/:id/issues/:issue_iid/notes` — body: `body` (required, ≤1,000,000 chars), `internal` (bool, overrides deprecated `confidential`).
- `PUT /projects/:id/issues/:issue_iid/notes/:note_id`
- `DELETE /projects/:id/issues/:issue_iid/notes/:note_id`
- `POST /projects/:id/merge_requests/:merge_request_iid/notes` — `body` required; `internal`; `merge_request_diff_head_sha` required for the `/merge` quick action.
- `PUT /projects/:id/merge_requests/:merge_request_iid/notes/:note_id`
- `DELETE /projects/:id/merge_requests/:merge_request_iid/notes/:note_id`

The project's `upsertMarkerNote` lists MR notes, searches `note.body` for a marker, then either `PUT`s the existing note (idempotent refresh) or `POST`s a new one — matching the notes create/update semantics above.

## Commits API

### List commit statuses

`GET /projects/:id/repository/commits/:sha/statuses`

Used by `GitLabClient.getCommitChecks()` to fold CI state into one of `pending | success | failure | null`.

Params: `ref`, `name`, `stage`, `all` (include all statuses, not just latest), `order_by` (`id`|`pipeline_id`, 17.9+), `sort`, `pipeline_id`.

Status object:

```json
{
  "status": "pending",
  "name": "test",
  "allow_failure": false,
  "created_at": "2016-01-19T08:40:25.832Z",
  "sha": "18f3e63d05582537db6d183d9d557be09e1f90c8",
  "ref": "main",
  "id": 90,
  "author": { "id": 28, "username": "janedoe", "name": "Jane Doe" }
}
```

`status` values: `pending`, `running`, `success`, `failed`, `canceled`, `skipped`. `allow_failure: true` means a `failed` status is non-blocking.

The project's folding logic (`getCommitChecks`):
- `failed` + `allow_failure` → treated as `success`
- `failed` → `failure`
- `success`/`canceled`/`skipped` → `success`
- anything else (`pending`, `running`) → `pending`
- no statuses at all → `null`

### Set a commit status

`POST /projects/:id/statuses/:sha`

Required: `state` (`pending`|`running`|`success`|`failed`|`canceled`|`skipped`). Optional: `name`/`context` (default `default`), `ref`, `target_url`, `description`, `coverage`, `pipeline_id`. Returns `201`.

### Other commit endpoints

- `GET /projects/:id/repository/commits/:sha` — single commit; `sha` may also be a branch/tag name.
- `GET /projects/:id/repository/commits/:sha/diff` — diff of the commit.
- `POST /projects/:id/repository/commits` — create commit(s) via `actions[]` (`create`/`delete`/`move`/`update`/`chmod`).
- `GET /projects/:id/repository/commits/:sha/merge_requests` — MRs that introduced the commit (adds `state` filter from 18.2).
- `GET /projects/:id/repository/commits/:sha/refs`, `/sequence`, `/cherry_pick`, `/revert`, `/signature`, `/comments`, `/discussions`.

The Commits API does **not** return `x-total`/`x-total-pages` headers.

## Merge Request Approvals API

### Retrieve approval state for a merge request

`GET /projects/:id/merge_requests/:merge_request_iid/approvals`

Available on all tiers. Used by `GitLabClient.getMergeRequestApprovals()` to derive a `reviewState` of `approved` or `pending`.

```json
{
  "id": 5,
  "iid": 5,
  "state": "opened",
  "merge_status": "cannot_be_merged",
  "approved": true,
  "approved_by": [
    {
      "user": { "id": 1, "username": "root", "name": "Administrator" },
      "approved_at": "2016-06-09T01:45:21.720Z"
    }
  ]
}
```

Semantics of `approved`:
- **GitLab EE** (incl. without a license): `approved` is `true` when configured approval rules are satisfied. When no approval rules apply, `approved` is `true` even with empty `approved_by`.
- **GitLab CE**: `approved` is `true` only when at least one approval exists.

The project's `latestReviewState()` maps `approved === true` → `approved`, else `pending` (no `changes_requested` state in v1).

### Approve / unapprove

- `POST /projects/:id/merge_requests/:merge_request_iid/approve` — optional `sha` (must match HEAD; mismatch → `409`), optional `approval_password` when re-auth is required. The authenticated user must be an eligible approver.
- `POST /projects/:id/merge_requests/:merge_request_iid/unapprove` — removes current user's approval.

### Reset approvals

`PUT /projects/:id/merge_requests/:merge_request_iid/reset_approvals` — bot users (project/group token) only; humans get `401`.

### Approval rules

- `GET /projects/:id/approvals` — project approval configuration (`reset_approvals_on_push`, `require_reauthentication_to_approve`, etc.).
- `GET /projects/:id/approval_rules` — list rules; `GET /projects/:id/approval_rules/:approval_rule_id`.
- `POST/PUT/DELETE /projects/:id/approval_rules[...]` — manage rules (`name`, `approvals_required`, `user_ids`, `group_ids`, `rule_type`).
- `GET /projects/:id/merge_requests/:merge_request_iid/approval_state` — detailed per-rule approval details (Premium/Ultimate).
- `GET/POST/PUT/DELETE /projects/:id/merge_requests/:merge_request_iid/approval_rules[...]` — per-MR rules (Premium/Ultimate). `report_approver`/`code_owner` rules are system-generated and cannot be edited.

### Automation caution

When creating and immediately approving an MR via API, approvals may be applied before the commit is fully processed and then reset when the commit lands. Wait until `detailed_merge_status` is not `checking`/`approvals_syncing` and the MR diff has a non-null `patch_id_sha`.

## Usage Patterns

### Endpoint ↔ project client mapping

| `GitLabClient` method | HTTP call |
|---|---|
| `getRepository(path)` | `GET /projects/:id` (encoded path) |
| `listIssues(ns, name)` | `GET /projects/:id/issues?scope=all&state=opened&order_by=updated_at` |
| `listIssueNotes(ns, name, iid)` | `GET /projects/:id/issues/:iid/notes` (paginated) |
| `listMergeRequests(ns, name)` | `GET /projects/:id/merge_requests?state=all` |
| `listMergeRequestNotes(ns, name, iid)` | `GET /projects/:id/merge_requests/:iid/notes` (paginated) |
| `getMergeRequest(ns, name, iid)` | `GET /projects/:id/merge_requests/:iid` |
| `findMergeRequest(ns, name, branch)` | `GET /projects/:id/merge_requests?state=all&source_branch=<branch>` → first item or `null` |
| `createMergeRequest(...)` | `POST /projects/:id/merge_requests` (with `remove_source_branch: false`) |
| `updateMergeRequest(...)` | `PUT /projects/:id/merge_requests/:iid` |
| `getMergeRequestApprovals(...)` | `GET /projects/:id/merge_requests/:iid/approvals` |
| `getCommitChecks(ns, name, sha)` | `GET /projects/:id/repository/commits/:sha/statuses` (paginated) |
| `upsertMarkerNote(...)` | `GET` notes → `POST` or `PUT /projects/:id/merge_requests/:iid/notes[/:note_id]` |

### Request template (TypeScript, as in the project)

```ts
const response = await fetch(`${baseUrl}/api/v4${path}`, {
  headers: {
    "PRIVATE-TOKEN": token,
    ...(body ? { "Content-Type": "application/json" } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});
```

### Paginated listing (TypeScript)

```ts
async function listAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const pageItems = await request<T[]>(`${path}${sep}per_page=100&page=${page}`);
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
}
```

## Best Practices

1. **Authenticate with a personal access token** via the `PRIVATE-TOKEN` header (recommended by GitLab for private-project automation), scoped to the minimum (`read_api`/`api` + `read_repository` when needed).
2. **Use encoded project paths** (`namespace%2Fproject`) instead of resolving a numeric `id` first — saves an extra round trip and is the documented pattern.
3. **Always fetch by `iid`** for issues/MRs/milestones, never by global `id`.
4. **Paginate defensively**: request `per_page=100`, follow pages until a short page, and do not rely on `x-total` headers (they are dropped for >10k results and for the Commits API).
5. **Handle `429` with the `Retry-After` header**; back off and retry rather than failing immediately.
6. **Treat 404 as both "missing" and "no permission"** for private projects — GitLab intentionally does not disclose existence.
7. **Normalize nullable fields**: `description`, `body`, `author`, `milestone`, `labels` entries can be `null`; guard before use (the project's `issueIsEligible` and `toIssueSnapshot` do this).
8. **Fold commit statuses with `allow_failure` in mind**: `failed` + `allow_failure` should not block a merge pipeline gate.
9. **Prefer `detailed_merge_status` over deprecated `merge_status`** for mergeability decisions.
10. **For note-based status markers, make them idempotent** (list → find marker → `PUT` existing / `POST` new), as the project's `upsertMarkerNote` does.
11. **Wait for MR preparation before approving via automation** (`detailed_merge_status` not `checking`/`approvals_syncing`, `patch_id_sha` non-null).

## Common Pitfalls

- **Unencoded `namespace/project` paths** → `404` even for valid projects. Always `encodeURIComponent` the full path.
- **Using global `id` instead of `iid`** for issues/MRs → wrong resource or `404`.
- **`+` in timestamps** in query params decodes to a space → use `%2B` for ISO 8601 offsets.
- **Trusting `x-total` headers** for large collections or the Commits API → they may be absent.
- **Newly created MRs** report empty `diff_refs`/`changes_count` until async preparation completes.
- **`merge_status` staleness** on list endpoints → it is not proactively refreshed; request `with_merge_status_recheck` if accuracy matters.
- **Approvals on CE vs EE** behave differently: CE requires at least one approval for `approved=true`; EE uses configured rules (and returns `true` when no rules exist).
- **`body`/`description`/`labels` nullability** in issue, MR, and note payloads — nulls are normal, not exceptional.
- **Rate-limited `search`** on MR/issue lists returns `429`; design retries around `Retry-After`.
- **`resolvable`/`system` fields on notes** — system notes (e.g. "approved this MR") are noise for comment pipelines; filter them when reconstructing human conversation.
- **Redirects after project moves** — old paths respond with a `Location` header pointing to the new project ID; follow it.

## Version Notes

- **API v5 (planned):** removes `approvals_before_merge`, `epic_iid`, deprecated `assignee`/`merged_by`/`reference`/`work_in_progress`/`merge_status`, and the Epics REST API (use Work Items API from GitLab 18.1).
- **GitLab 19.x:** `draft` filter replaces `wip` (19.0); `start_date` on issues (19.1); auto-merge `auto_merge` replaces `merge_when_pipeline_succeeds` (deprecated 17.11); `sha` required on merge when the group/instance enforces it (19.2).
- **GitLab 18.x:** keyset pagination for project issues (18.3); `collapsed`/`too_large` diff attributes (18.4); `security_policy_violations` GA (18.4); commit-MR `state` filter (18.2).
- **GitLab 17.x:** `merge_user_id`/`merge_user_username` filters (17.0); `merged_at` ordering (17.2); `order_by`/`sort`/`pipeline_id` on commit statuses (17.9); `require_reauthentication_to_approve` (17.1); `merge_after` (17.8).
- **GitLab 16.x:** `approvals_before_merge` deprecated (16.0).
- **GitLab 15.x:** `merge_status` deprecated in favor of `detailed_merge_status` (15.6); `changes` endpoint deprecated (15.7).
- **GitLab 14.x:** `merged_by` deprecated (14.7).
- **GitLab 12.x:** `reference` deprecated (12.7); project approval config fields deprecated (12.3).
- **Self-Managed EE → CE downgrade** causes breaking API changes; versions must be treated as a bundle.
