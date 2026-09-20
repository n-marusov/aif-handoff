# GitLab MCP Server — Tools Reference

> Source: https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/
> Created: 2026-09-20
> Updated: 2026-09-20

Tool catalog and parameter tables for the GitLab MCP server. Connection setup, toolsets, authentication, and versioning are in [INDEX.md](INDEX.md).

Parameter semantics are condensed from the official tools page. Names in `backticks` are exact tool names.

## Tool Catalog

### Meta

| Tool | Since | Purpose |
| --- | --- | --- |
| `get_mcp_server_version` | 18.3 | Returns the current version of the GitLab MCP server. |

### Projects, groups, users

| Tool | Since | Purpose |
| --- | --- | --- |
| `get_project` | 19.4 | Project metadata: numeric ID, full path, default branch, visibility, web URL. |
| `list_projects` | 19.4 | List projects, optionally scoped to a group. |
| `list_groups` | 19.4 | List top-level groups or the subgroups of a group. |
| `get_user` | 19.4 | Resolve a username, numeric ID, or the authenticated user. |
| `list_project_members` | 19.4 | List project members with role and access level. |

### Repository

| Tool | Since | Purpose |
| --- | --- | --- |
| `add_commit` | 19.3 | Add a commit with one or more file actions to a branch in one call. |
| `add_branch` | 19.3 | Create a branch from a ref. Alias: `create_branch`. |
| `list_branches` | 19.4 | List branches, optionally filtered by name. |
| `get_repository_file` | 19.3 | Read one file at a ref, with line windowing. |
| `list_repository_tree` | 19.4 | List files/directories at a path and ref (metadata only). |
| `get_commit` | 19.3 | One commit's metadata, plus diff or notes. |
| `list_commits` | 19.4 | List commits, filtered by ref, author, path, date. |
| `list_tags` | 19.4 | List tags, most recently updated first. |
| `list_releases` | 19.4 | List releases, most recent first. |
| `fork_repository` | 19.4 | Fork a project into a namespace (asynchronous). |

### Merge requests

| Tool | Since | Purpose |
| --- | --- | --- |
| `save_merge_request` | 18.5 | Create or update a merge request (presence of `merge_request_iid` selects the operation). Aliases: `create_merge_request`, `update_merge_request`. |
| `get_merge_request` | 18.4 | One merge request, optionally with one associated facet. |
| `list_merge_requests` | 19.3 | List/search merge requests in a project or group. |
| `get_merge_request_diffs` | 18.4 | Diffs (patch text) for a merge request. |
| `get_merge_request_commits` | 18.4 | Commits in a merge request. |
| `get_merge_request_pipelines` | 18.4 | Pipelines for a merge request. |
| `get_merge_request_notes` | 19.2 | Notes (comments and system notes) for a merge request. |
| `get_merge_request_conflicts` | 18.10 | Raw conflict markers for a merge request that cannot be merged. |
| `save_merge_request_review` | 19.4 | Review artifacts: notes, diff notes, discussion replies/resolution, review submission, Duo review, approve/unapprove. |
| `save_note` | 19.2 | Comment on a merge request or work item, or reply to a discussion. Aliases: `create_merge_request_note`, `create_workitem_note`. |
| `accept_merge_request` | 19.4 | Merge a merge request, or arm auto-merge. |

### Work items

| Tool | Since | Purpose |
| --- | --- | --- |
| `save_work_item` | 19.4 | Create or update a work item (issue, task, epic). Aliases: `create_work_item`, `update_work_item`. |
| `get_work_item` | 19.4 | One work item, optionally with notes or related merge requests. |
| `list_work_items` | 19.4 | List/search work items in a group or project. |
| `get_work_item_types` | 19.1 | Work item types available in a namespace, with enabled widgets. |
| `link_work_items` | 19.0 | Link work items with a relationship type. |
| `get_saved_view_work_items` | 18.11 | Retrieve a saved view and its work items. |

### CI/CD

| Tool | Since | Purpose |
| --- | --- | --- |
| `list_pipelines` | 19.3 | List pipelines with filters. |
| `get_pipeline` | 19.3 | One pipeline, optionally with jobs, downstream pipelines, bridge jobs, or artifacts. |
| `get_pipeline_jobs` | 18.4 | Jobs of a pipeline. |
| `save_pipeline` | 19.3 | Create, retry, cancel, or rename a pipeline. |
| `manage_pipeline` | 18.10 | Update pipeline metadata or delete a pipeline. |
| `get_job` | 19.3 | One job's metadata, optionally its log or artifacts. Alias: `get_job_log` (always returns `log`, capped at `byte_limit`). |
| `get_artifact_file` | 19.5 | Read a file from inside a job's artifacts archive. |

### Duo Agent Platform

| Tool | Since | Purpose |
| --- | --- | --- |
| `start_duo_session` | 19.5 | Start a Duo Agent Platform session running an AI Catalog flow. |
| `list_duo_sessions` | 19.3 | List your Duo Agent Platform sessions (excludes Duo Chat). |
| `get_duo_session` | 19.4 | Check a Duo session's status. Alias: `get_duo_workflow_status`. |
| `send_duo_session_input` | 19.5 | Answer a Duo session waiting for input. |

### Security, search, wiki

| Tool | Since | Purpose |
| --- | --- | --- |
| `save_vulnerability` | 19.4 | Dismiss, confirm, revert, re-severity, or create an issue for a vulnerability. |
| `attach_scan_profile` | 19.2 | Attach a security scan profile to projects or groups. |
| `search` | 18.4 | Instance-wide search (renamed from `gitlab_search` in 18.8). |
| `search_labels` | 18.9 | Search labels in a project or group. |
| `semantic_search` | 18.5 | Meaning-based code search (renamed from `semantic_code_search` in 19.4). |
| `list_wiki_pages` | 19.3 | List wiki pages in a project or group. |

### Superseded (still callable, unlisted)

These no longer appear in `tools/list` but remain callable while callers migrate:

| Tool | Since | Superseded by |
| --- | --- | --- |
| `create_issue` | 18.4 | `save_work_item` |
| `get_issue` | 18.4 | `get_work_item` |
| `get_workitem_notes` | 18.7 | `get_work_item` with `include: ["notes"]` |

Behavioral difference: `create_issue` creates label names that do not exist and silently drops an unknown milestone title, whereas `save_work_item` resolves milestone titles and label names in the project and its ancestor groups and returns an error naming anything it cannot find.

## Tool Parameter Reference

### Projects, groups, users

#### `get_project`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the project. Provide exactly one of `url` or `project_id`. |
| `project_id` | string | No | ID or full path of the project. Provide exactly one of `url` or `project_id`. |

`default_branch` is `null` when the project has no repository yet. To find a project you cannot name yet, use `search` with the `projects` scope.

#### `list_projects`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `group_id` | string | No | ID or full path of a group. Omit to list across the instance (defaults to projects where you have at least the Guest role). |
| `min_access_level` | string | No | One of `guest`, `planner`, `reporter`, `developer`, `maintainer`, `owner`. |
| `search` | string | No | Search by name, path, or description. |
| `visibility` | string | No | `public`, `internal`, or `private`. |
| `archived` | string | No | `only`, `include`, or `exclude` (default). |
| `after` | string | No | Cursor for forward pagination. |
| `first` | integer | No | Results per page. Default 20, max 100. |

With `group_id`, lists every project in that group and its subgroups regardless of access level. Adding `min_access_level` or `visibility` narrows the listing to that group only (not subgroups), because GitLab cannot combine subgroup traversal with those filters when listing a group's projects. The response includes `subgroupsIncluded`.

#### `list_groups`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `group_id` | string | No | Parent group to list subgroups of. Omit to list top-level groups where you are a member. |
| `search` | string | No | Search by name or full path. |
| `visibility` | string | No | `public`, `internal`, or `private`. |
| `include_subgroups` | boolean | No | Recurse into all descendant subgroups instead of direct children only. |
| `after` | string | No | Cursor for forward pagination. |
| `first` | integer | No | Results per page. Default 20, max 100. |

Archived groups and groups pending deletion are excluded. With no `group_id`, `include_subgroups: true` lists your groups at any depth.

#### `get_user`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `username` | string | No | Username to look up. |
| `id` | integer | No | Numeric ID to look up. |
| `me` | boolean | No | `true` looks up the authenticated user. Must be `true` when provided. Omit `username` and `id`. |

Provide exactly one of `username`, `id`, or `me`. Returns `id`, `username`, `name`, `state`, `web_url`. Use it to resolve usernames to numeric IDs before setting assignees or reviewers.

#### `list_project_members`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | Yes | Full path or numeric ID (for example `gitlab-org/gitlab` or `278964`). |
| `include_inherited` | boolean | No | Also return members inheriting their role from a parent group or subgroup. Default `false`. |
| `query` | string | No | Return only members whose name or username contains this text. |
| `first` | integer | No | Results per page. Default 20, max 100. |
| `after` | string | No | Cursor for forward pagination. |

Returns user ID, username, name, numeric `access_level`, `access_level_name`, and `expires_at`. Members invited by email who have not accepted are not returned. More pages are signalled by `metadata.end_cursor`.

### Repository

#### `add_commit`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `commit_message` | string | Yes | Commit message. |
| `actions` | array of objects | Yes | File actions to commit as a single batch. |
| `branch` | string | Yes | Name of the branch to commit into. |
| `project_id` | string | No | ID or path of the project. Required if `url` is not provided. |
| `url` | string | No | GitLab URL of the project. Required if `project_id` is not provided. |
| `start_branch` | string | No | Branch to start the new branch from. Required when `branch` does not exist. |
| `start_sha` | string | No | SHA to start a new branch from. Mutually exclusive with `start_branch`. |
| `start_project` | string | No | Full path of the project to start the commit from. Must be the project itself or a project it was forked from. |

Each entry in `actions`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | Yes | `create`, `update`, `delete`, `move`, or `chmod`. |
| `file_path` | string | Yes | Full path to the file. |
| `content` | string | No | File content. Used by `create`, `update`, `move`. Mutually exclusive with `old_str` and `new_str`. |
| `old_str` | string | No | Existing text to replace in an `update`. Requires `new_str`. |
| `new_str` | string | No | Replacement text for `old_str` in an `update`. |
| `previous_path` | string | No | Original file path. Required for `move`. |
| `encoding` | string | No | `text` or `base64`. Default `text`. |
| `last_commit_id` | string | No | Last known commit ID for the file (optimistic concurrency). |
| `execute_filemode` | boolean | No | Whether the file is executable. Required for `chmod`. |

Partial edits (`old_str`/`new_str`) replace exactly one occurrence. If it occurs more than once, provide more surrounding context. Partial edits read the complete file on the server, so they are not supported for files larger than 10 MiB — commit full content instead. Partial edits are not supported for binary files or files stored in LFS.

#### `get_repository_file`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | File URL, for example `https://gitlab.example.com/my-group/my-project/-/blob/main/app/models/user.rb`. Provide this, or `project_id`, `file_path`, and `ref`. |
| `project_id` | string | No | ID or full path. Required if `url` is not provided. |
| `file_path` | string | No | Path relative to the repository root. Required if `url` is not provided. |
| `ref` | string | No | Branch, tag, or commit SHA. Use `HEAD` for the default branch. Required if `url` is not provided. |
| `offset` | integer | No | Zero-indexed line to start reading from. Default `0`. |
| `limit` | integer | No | Maximum lines to return. Default and maximum `2000`. |

Content comes from the repository, not the local filesystem, so uncommitted local changes are not included. The response contains `metadata` with `total_lines`, `returned_lines`, `truncated`, `size_bytes`; when partial, `system_instruction` states the `offset` for the next call. Text only — binary files, Git LFS files, and files a project excludes from GitLab Duo context return an error.

#### `list_repository_tree`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL of the project. Provide exactly one of `url` or `project_id`. |
| `project_id` | string | No | ID or full path. Provide exactly one of `url` or `project_id`. |
| `path` | string | No | Directory to list, relative to the repository root. Defaults to the root. |
| `ref` | string | No | Branch, tag, or commit SHA. Defaults to the default branch. |
| `recursive` | boolean | No | List all subdirectories recursively. Default `false`. |
| `after` | string | No | Cursor for forward pagination (previous `pageInfo.endCursor`). |

Entry metadata only, never file contents. Up to 100 entries per call; when `pageInfo.hasNextPage` is `true`, pass `pageInfo.endCursor` as `after`.

#### `add_branch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL of the project. Provide this, or `project_id`. |
| `project_id` | string | No | ID or path. Required if `url` is not provided. |
| `branch` | string | Yes | Name of the new branch. |
| `ref` | string | Yes | Branch name or commit SHA to create the new branch from. |

Alias: `create_branch`.

#### `list_branches`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | ID or full path of the project. |
| `search` | string | No | Filters branches by name. |
| `page` | integer | No | Page number. Default `1`. |
| `per_page` | integer | No | Items per page. Default `20`. |

#### `get_commit`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the commit. Required if `project_id` and `commit_sha` are not provided. |
| `project_id` | string | No | ID or full path. Required if `url` is not provided. |
| `commit_sha` | string | No | Full or short SHA, branch name, or tag name. Required if `url` is not provided. |
| `include` | array | No | One facet per call: `diff` or `notes`. Base metadata is always returned. |
| `diff_detail` | string | No | Applies only when `include` contains `diff`. `stats` (default) or `full_patch`. |
| `notes_after` | string | No | Next page of notes. Applies only with `notes`. |
| `notes_first` | integer | No | Notes per page, max 100. Applies only with `notes`. |

#### `list_commits`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL of the project. Provide exactly one of `url` or `project_id`. |
| `project_id` | string | No | ID or full path. Provide exactly one of `url` or `project_id`. |
| `ref_name` | string | No | Branch or tag. Defaults to the default branch. |
| `author` | string | No | Filter by author name or email. |
| `path` | string | No | Only commits touching this file path. |
| `since` | string | No | Only commits committed after this ISO 8601 date/time. |
| `until` | string | No | Only commits committed before this ISO 8601 date/time. |
| `order` | string | No | `topo` or `date`. Defaults to reverse chronological. |
| `first_parent` | boolean | No | Follow only the first parent of merge commits. |
| `with_stats` | boolean | No | Include per-commit line-count stats. |
| `after` | string | No | Cursor for forward pagination (previous `endCursor`). |
| `first` | integer | No | Commits to return. Default 20, max 100. |

Each commit costs a Gitaly call when `with_stats` is `true`. The docs state that with `with_stats` the `first` value defaults to `10` and must not exceed `10` — note this conflicts with the table's default of `20`, so set `first` explicitly when using `with_stats`.

#### `list_tags`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL of the project. Required if `project_id` is not provided. |
| `project_id` | string | No | ID or full path. Required if `url` is not provided. |
| `search` | string | No | Filter by name. Supports `^` (start anchor), `$` (end anchor), and `*` (wildcard). |
| `first` | integer | No | Tags to return. Default 20, max 100. |
| `after` | string | No | Cursor for forward pagination (`metadata.end_cursor`). |

Most recently updated first; an exact `search` match is listed first. Each entry returns `name` and `commit` (tip `sha` and `title`); `commit` is `null` for a tag not pointing at a commit. Tag messages are not returned.

#### `list_releases`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL of the project. Required if `project_id` is not provided. |
| `project_id` | string | No | ID or full path. Required if `url` is not provided. |
| `page` | integer | No | Page number. Default `1`. |
| `per_page` | integer | No | Releases per page. Default 20, max 100. |
| `state` | string | No | `released` (default), `upcoming`, or `all`. |

Most recent first. Returns `tag_name`, `name`, `released_at`, `upcoming`, and `assets` (`count` plus up to five `links`). Source archives are excluded. Release notes are not returned. A release with a future `released_at` is scheduled and sorts ahead of published releases. `metadata` carries `page`, `per_page`, `has_more`.

#### `fork_repository`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | ID or full path of the project. |
| `namespace_id` | integer | No | Namespace ID to fork into. |
| `namespace_path` | string | No | Namespace path to fork into. |
| `name` | string | No | Name for the fork. |
| `path` | string | No | Path for the fork. |
| `description` | string | No | Description for the fork. |
| `visibility` | string | No | Visibility of the fork. |

Created asynchronously; the response includes an `import_status` (for example `scheduled`). Fails with `409` when the namespace already has a fork of the project, and `404` when the project or namespace does not exist or you lack permission.

### Merge requests

#### `save_merge_request`

The presence of `merge_request_iid` selects the operation: omit it to create, provide it to update. Aliases: `create_merge_request`, `update_merge_request`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | Yes | ID or full path of the project. |
| `merge_request_iid` | integer | No | Provide to update; omit to create. |
| `title` | string | No | Required when creating. |
| `source_branch` | string | No | Required when creating. |
| `target_branch` | string | No | Required when creating. |
| `target_project_id` | integer | No | Applies when creating. |
| `description` | string | No | Description of the merge request. |
| `labels` | array of strings | No | Replaces all existing labels. Pass an empty array to remove all. |
| `add_labels` | array of strings | No | Labels to add. Applies when updating. |
| `remove_labels` | array of strings | No | Labels to remove. Applies when updating. |
| `assignees` | array of strings | No | Usernames to assign. Alternative to `assignee_ids`; provide one. Empty array removes all. |
| `assignee_ids` | array of integers | No | User IDs to assign. Alternative to `assignees`; provide one. Empty array removes all. |
| `reviewers` | array of strings | No | Usernames to request review from. Alternative to `reviewer_ids`; provide one. Empty array removes all. |
| `reviewer_ids` | array of integers | No | User IDs to request review from. Alternative to `reviewers`; provide one. Empty array removes all. |
| `milestone_id` | integer | No | ID of the milestone. |
| `milestone` | string | No | Title of a project or ancestor-group milestone. Mutually exclusive with `milestone_id`. |
| `remove_source_branch` | boolean | No | Remove the source branch when merged. |
| `squash` | boolean | No | Squash commits into a single commit when merging. |
| `state_event` | string | No | `close` or `reopen`. Applies when updating. |
| `discussion_locked` | boolean | No | Lock the discussion. Applies when updating. |
| `allow_collaboration` | boolean | No | Allow commits from members who can merge to the target branch. Applies when updating. |

#### `get_merge_request`

Only the base merge request is returned unless you request one associated facet with `include`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL of the merge request. Provide this, or `project_id` and `merge_request_iid`. |
| `project_id` | string | No | ID or full path. Required if `url` is missing. |
| `merge_request_iid` | integer | No | Internal ID. Required if `url` is missing. |
| `include` | array | No | One of `diffs`, `commits`, `notes`, `pipelines`, `discussions`, `conflicts`. Limited to one facet per call. |
| `notes_after` | string | No | Cursor for forward pagination of notes. Only with `include: ["notes"]`. |
| `notes_first` | integer | No | Notes after the cursor, up to 100. Only with `include: ["notes"]`. |

The `diffs` facet returns change statistics only (totals and per-file additions/deletions); use `get_merge_request_diffs` for patch text. The `conflicts` facet returns raw conflict file content including Git conflict markers, is available only when the merge request cannot be merged and you can push to the source branch, and is `null` until mergeability has been checked.

#### `list_merge_requests`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the project or group. Provide exactly one of `url`, `project_id`, `group_id`. |
| `project_id` | string | No | ID or full path of the project. Provide exactly one of the three. |
| `group_id` | string | No | ID or full path of the group. Provide exactly one of the three. |
| `author_username` | string | No | Filter by author username. |
| `assignee_username` | string | No | Filter by assignee username. |
| `reviewer_username` | string | No | Filter by reviewer username. |
| `state` | string | No | `opened`, `closed`, `merged`, `locked`, or `all`. Omit for any state. |
| `scope` | string | No | `created_by_me`, `assigned_to_me`, or `review_requested`. An explicit username wins for that field. |
| `milestone` | string | No | Filter by milestone title. |
| `labels` | string | No | Comma-separated label names; only MRs with all of them are returned. |
| `search` | string | No | Matched against title and description. |
| `after` | string | No | Cursor for forward pagination. |
| `first` | integer | No | Results. Default 20, max 100. |

Group scope always includes every project in the group and its subgroups, but excludes archived projects, and each result includes the owning project path for use with `get_merge_request`.

#### `save_merge_request_review`

Each call performs exactly one operation, selected with `method`.

| Method | Action |
| --- | --- |
| `create_note` | Adds a top-level comment. |
| `reply_discussion` | Replies in an existing discussion. |
| `create_diff_note` | Comments on a specific diff line. |
| `resolve_discussion` | Resolves or unresolves a discussion. |
| `submit_review` | Posts multiple diff comments and an optional summary in one call. |
| `post_duo_review` | Asks GitLab Duo to review the MR. Requires GitLab Duo Code Review. |
| `approve` | Approves the MR. Already-approved calls succeed with status `already_approved`. |
| `unapprove` | Removes your approval. Calls without a prior approval succeed with status `not_approved`. |

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the merge request. Required if `project_id` and `merge_request_iid` are missing. |
| `project_id` | string | No | ID or path. Required if `url` is missing. |
| `merge_request_iid` | integer | No | Internal ID. Required if `url` is missing. |
| `method` | string | Yes | The operation to perform. Parameters belonging to a different method are rejected. |
| `body` | string | No | Note text. Required for `create_note`, `reply_discussion`, `create_diff_note`. Lines cannot start with `/` (quick actions). |
| `discussion_id` | string | No | Required for `reply_discussion` and `resolve_discussion`. Accepts a global ID or a bare discussion ID. |
| `internal` | boolean | No | For `create_note`, marks the note internal. |
| `resolved` | boolean | No | For `resolve_discussion`: `true` resolves, `false` unresolves. Required for that method. |
| `old_path` | string | No | For `create_diff_note`, file path before the change. Provide `old_path` or `new_path`, or both. |
| `new_path` | string | No | For `create_diff_note`, file path after the change. |
| `old_line` | integer | No | For `create_diff_note`, line number in the old version. Provide `old_line` or `new_line`, or both. |
| `new_line` | integer | No | For `create_diff_note`, line number in the new version. |
| `comments` | array | No | For `submit_review`, 1-20 diff comments. Each entry requires `file` and `body`; optional `old_line`, `new_line`, `suggestion`. Required for that method. `file` is the post-change path. |
| `verdict` | string | No | For `submit_review`, an overall verdict prefixed to the summary note. |
| `summary` | string | No | For `submit_review`, a summary note posted after the diff comments. |
| `summary_internal` | boolean | No | For `submit_review`, marks the summary note internal. |
| `sha` | string | No | For `approve`, a head SHA guard. When it no longer matches the MR head, the approval is refused. Pass the full 40-character `diff_head_sha` from `get_merge_request`. |

Responses from `post_duo_review`, `approve`, and `unapprove` include the MR's current `diff_head_sha`, so you can tell whether a standing approval still covers the latest commits.

#### `accept_merge_request`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the merge request. Provide this, or `project_id` and `merge_request_iid`. |
| `project_id` | string | No | ID or path. Required if `url` is missing. |
| `merge_request_iid` | integer | No | Internal ID. Required if `url` is missing. |
| `sha` | string | Yes | Head SHA guard. When it no longer matches the MR head, the merge is refused. Pass `diff_head_sha` from `get_merge_request`. |
| `strategy` | string | No | Auto-merge strategy, for example `merge_when_checks_pass`. When given, arms auto-merge instead of merging immediately. |
| `squash` | boolean | No | Squash commits into a single commit on merge. |
| `commit_message` | string | No | Custom merge commit message. |
| `squash_commit_message` | string | No | Custom squash commit message. Applies when `squash` is `true`. |
| `should_remove_source_branch` | boolean | No | Remove the source branch after merging. |

Without `strategy`, the merge starts immediately and completes asynchronously. Already-merged calls succeed with `already_merged`; calls with a `strategy` against an already-scheduled MR succeed with `already_scheduled`.

#### `get_merge_request_diffs`, `get_merge_request_commits`, `get_merge_request_pipelines`

| Tool | Parameters |
| --- | --- |
| `get_merge_request_diffs` | `id` (string, required), `merge_request_iid` (integer, required), `per_page` (integer, optional), `page` (integer, optional) |
| `get_merge_request_commits` | `id` (string, required), `merge_request_iid` (integer, required), `per_page` (integer, optional), `page` (integer, optional) |
| `get_merge_request_pipelines` | `id` (string, required), `merge_request_iid` (integer, required) |

#### `get_merge_request_conflicts`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | Yes | ID or full path (for example `gitlab-org/gitlab`). |
| `merge_request_iid` | integer | Yes | Internal ID of the merge request. |

Returns raw conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) grouped under a `# File:` heading; renamed files show the path in each branch. You must have permission to push to the source branch. Returns an error when there are no conflicts, mergeability has not been checked, or a branch or diff ref is missing.

#### `get_merge_request_notes`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the MR. Required if `project_id` and `merge_request_iid` are missing. |
| `project_id` | string | No | ID or full path. Required if `url` is missing. |
| `merge_request_iid` | integer | No | Internal ID. Required if `url` is missing. |
| `after` | string | No | Cursor for forward pagination. |
| `before` | string | No | Cursor for backward pagination. |
| `first` | integer | No | Notes for forward pagination. |
| `last` | integer | No | Notes for backward pagination. |

Each note includes its discussion ID, so related notes can be grouped into threads.

#### `save_note`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the merge request or work item. The URL determines the target type. |
| `project_id` | string | No | ID or path. Required with `merge_request_iid`, and with `work_item_iid` for project-level work items. |
| `group_id` | string | No | ID or path. Required with `work_item_iid` for group-level work items. |
| `merge_request_iid` | integer | No | Provide with `project_id`. Mutually exclusive with `work_item_iid`. |
| `work_item_iid` | integer | No | Provide with `project_id` or `group_id`. Mutually exclusive with `merge_request_iid`. |
| `body` | string | Yes | Note content. Lines cannot start with `/` (quick actions such as `/merge`). |
| `internal` | boolean | No | Marks the note internal (Reporter or above). Default `false`. |
| `discussion_id` | string | No | Discussion to reply to, format `gid://gitlab/Discussion/<id>`. If missing, creates a new top-level note. |

Aliases: `create_merge_request_note`, `create_workitem_note`.

### Work items

#### `save_work_item`

Omit `work_item_iid` to create; provide it or a work item URL to update. Send only the fields you intend to set. Aliases: `create_work_item`, `update_work_item`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL for the project, group, or work item. Provide exactly one of `url`, `project_id`, `group_id`. |
| `group_id` | string | No | ID or path of the group. Required if `url` and `project_id` are missing. |
| `project_id` | string | No | ID or path of the project. Required if `url` and `group_id` are missing. |
| `work_item_iid` | integer | No | Positive internal ID to update. Omit to create. |
| `title` | string | No | Required when creating. |
| `type_name` | string | No | For example `Issue`, `Task`, `Epic`. Required when creating. Valid types depend on namespace and license. |
| `description` | string | No | GitLab Flavored Markdown. Max 1,048,576 characters. |
| `assignee_ids` | array of integers | No | User IDs to assign. Max 100. |
| `label_ids` | array of strings | No | Label IDs or global IDs. Create only; on update use `add_label_ids` or `remove_label_ids`. Max 100. |
| `labels` | array of strings | No | Label names, resolved in the project/group and its ancestor groups. Create only. Max 100. |
| `add_label_ids` | array of strings | No | Update only. Label IDs or global IDs to add. Max 100. |
| `add_labels` | array of strings | No | Update only. Label names to add. Max 100. |
| `remove_label_ids` | array of strings | No | Update only. Label IDs or global IDs to remove. Max 100. |
| `remove_labels` | array of strings | No | Update only. Label names to remove. Max 100. |
| `milestone_id` | string | No | ID or global ID of the milestone, validated against the project/group and ancestor groups. Wins over `milestone`. |
| `milestone` | string | No | Milestone title resolved among the project/group and ancestor groups. |
| `confidential` | boolean | No | Sets confidentiality. |
| `start_date` | string | No | `YYYY-MM-DD`. |
| `due_date` | string | No | `YYYY-MM-DD`. |
| `state` | string | No | Update only. `closed` closes, `opened` reopens. |
| `parent_id` | string | No | Global ID or numeric ID of the parent work item. |
| `todo_action` | string | No | Update only. `add` adds a to-do for the current user, `mark_as_done` marks to-dos done. |
| `todo_id` | string | No | Update only. Global ID or numeric ID of the to-do. Omit to update all to-dos on the work item. |
| `health_status` | string | No | `onTrack`, `needsAttention`, or `atRisk`. Ultimate only. |
| `weight` | integer | No | Must be 0 or greater. Premium and Ultimate only. |
| `clear_weight` | boolean | No | Update only. Removes the weight. Takes precedence over `weight`. Premium and Ultimate only. |
| `status_id` | string | No | Global ID of the status to set. Premium and Ultimate only. |
| `is_fixed` | boolean | No | When `false`, dates roll up from child items and `start_date`/`due_date` are ignored. Premium and Ultimate only. |
| `agent_plan` | string | No | Markdown content of the agent plan. Ultimate only. Requires the workplan feature. |
| `readiness_score` | integer | No | 0-100. Ultimate only. Requires the `workplan_score` feature flag; errors when disabled. |

#### `get_work_item`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | Work item URL (`/-/work_items/`, `/-/issues/`, or `/-/epics/`). Provide this, or `work_item_iid` with `group_id` or `project_id`. |
| `group_id` | string | No | Required if `url` and `project_id` are missing. |
| `project_id` | string | No | Required if `url` and `group_id` are missing. |
| `work_item_iid` | integer | No | Required if `url` is missing. |
| `include` | array | No | One of `notes` or `related_merge_requests`, one facet per call. For the newest notes, use `notes_last` without `notes_first` or `notes_after`. |
| `notes_first` | integer | No | Notes after the cursor. Default 100, max 100. |
| `notes_after` | string | No | Cursor for forward pagination (`pageInfo.endCursor`). |
| `notes_last` | integer | No | Notes before the cursor. Default 100, max 100. |
| `notes_before` | string | No | Cursor for backward pagination (`pageInfo.startCursor`). |
| `related_merge_requests_first` | integer | No | Default 20, max 100. |
| `related_merge_requests_after` | string | No | Cursor for forward pagination. |
| `mr_page_size` | integer | No | Deprecated: use `related_merge_requests_first`. |
| `mr_pagination_cursor` | string | No | Deprecated: use `related_merge_requests_after`. |

Returns type, dates, assignees, labels, milestone, and parent; widgets the work item type does not support are omitted. The `related_merge_requests` facet is empty for group-level work items such as epics.

#### `list_work_items`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL for the project or group. Provide exactly one of `url`, `group_id`, `project_id`. |
| `group_id` | string | No | Required if `url` and `project_id` are missing. |
| `project_id` | string | No | Required if `url` and `group_id` are missing. |
| `state` | string | No | `opened`, `closed`, or `all` (default). |
| `search` | string | No | Free-text search in title and description. |
| `author_username` | string | No | Username of the author. |
| `assignee_usernames` | array | No | A work item must match all. Max 100 values. |
| `label_name` | array | No | A work item must have all. Max 100 values. |
| `milestone_title` | array | No | Cannot be combined with `milestone_wildcard_id`. Max 100 values. |
| `milestone_wildcard_id` | string | No | `NONE`, `ANY`, `STARTED`, or `UPCOMING`. Cannot be combined with `milestone_title`. |
| `types` | array | No | For example `["ISSUE", "TASK"]`. |
| `created_after` | string | No | ISO 8601; date-only means start of day, offsets honored. |
| `created_before` | string | No | ISO 8601. |
| `updated_after` | string | No | ISO 8601. |
| `updated_before` | string | No | ISO 8601. |
| `due_after` | string | No | ISO 8601. |
| `due_before` | string | No | ISO 8601. |
| `sort` | string | No | For example `UPDATED_DESC`. Default `CREATED_DESC`. |
| `first` | integer | No | Default 20, max 100. |
| `after` | string | No | Cursor for forward pagination. |
| `health_status_filter` | string | No | Ultimate only. `onTrack`, `needsAttention`, or `atRisk`. |
| `status` | object | No | Ultimate only. Filter by custom status name, for example `{"name": "In progress"}`. |

Group scope includes work items of descendant projects and subgroups. Each result contains only ID, IID, title, state, web URL, full reference, created/updated timestamps, and work item type, with cursor pagination. Use `get_work_item` for detail.

#### `get_work_item_types`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL for the namespace (project or group). Required if `group_id` and `project_id` are missing. |
| `group_id` | string | No | Required if `url` and `project_id` are missing. |
| `project_id` | string | No | Required if `url` and `group_id` are missing. |

Returns system-defined and custom types with global ID, name, icon, and enabled widget types — use it to avoid setting fields a type does not support.

#### `link_work_items`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `work_items_ids` | array | Yes | Plain iids (resolved in the same project or group as the source) or global IDs (`gid://gitlab/WorkItem/<id>`) for other projects/groups. Max 10 items. |
| `url` | string | No | URL for the source work item. Required if `group_id`/`project_id` and `work_item_iid` are missing. |
| `group_id` | string | No | Required if `url` and `project_id` are missing. |
| `project_id` | string | No | Required if `url` and `group_id` are missing. |
| `work_item_iid` | integer | No | Required if `url` is missing. |
| `link_type` | string | No | `relates_to` (default), `blocks`, or `blocked_by`. `blocks` and `blocked_by` require Premium or Ultimate. |

#### `get_saved_view_work_items`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `saved_view_id` | string | Yes | Global ID, format `gid://gitlab/WorkItems::SavedViews::SavedView/<id>`. |
| `url` | string | No | URL for the namespace (project or group). Required if `group_id` or `project_id` is missing. |
| `group_id` | string | No | Required if `url` and `project_id` are missing. |
| `project_id` | string | No | Required if `url` and `group_id` are missing. |
| `after` | string | No | Cursor for forward pagination. |
| `first` | integer | No | Work items to return. Max 100. |

Applies the saved view's filters and sort order.

### CI/CD

#### `list_pipelines`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | ID or full path of the project. |
| `ref` | string | No | Branch or tag name. |
| `status` | string | No | For example `running`, `success`, `failed`. |
| `source` | string | No | For example `push`, `web`, `schedule`. |
| `created_after` | string | No | ISO 8601. |
| `created_before` | string | No | ISO 8601. |
| `order_by` | string | No | `id`, `status`, `ref`, `updated_at`, or `user_id`. Default `id`. |
| `sort` | string | No | `asc` or `desc`. Default `desc`. |
| `page` | integer | No | Default `1`. |
| `per_page` | integer | No | Default `20`. |

Child pipelines are excluded by default; set `source` to `parent_pipeline` to return only child pipelines. ID order usually matches creation order but is not guaranteed — use `created_after`/`created_before` for explicit time boundaries.

#### `get_pipeline`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | ID or full path of the project. |
| `pipeline_id` | integer | Yes | ID of the pipeline. |
| `include` | array | No | One facet per call: `jobs`, `downstream_pipelines`, `bridge_jobs`, or `artifacts`. |
| `job_status` | string | No | Filters the `jobs` facet by status (for example `failed`). Only with `include: jobs`. |
| `first` | integer | No | Items for the selected facet. Default 20, max 100. |
| `after` | string | No | Cursor for forward pagination of the selected facet (`page_info.end_cursor`). |

A bridge job's `downstream_pipeline` is `null` both when the trigger job has not triggered one yet and when you lack access. Each downstream pipeline includes `project_full_path` — use it as the `id` of a follow-up call. The `artifacts` facet returns a flat list with `name`, `size`, `file_type`, expiry, and producing `job_id`/`job_name`; pagination pages over the pipeline's jobs, not the artifacts.

#### `get_pipeline_jobs`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | ID or full path of the project. |
| `pipeline_id` | integer | Yes | ID of the pipeline. |
| `per_page` | integer | No | Jobs per page. |
| `page` | integer | No | Page number. |

Prefer `get_pipeline` with `include: jobs` to get jobs alongside the rest of the pipeline's data in one call.

#### `save_pipeline`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | GitLab URL of the project. Used only to create a pipeline. Provide this, or `project_id`. |
| `project_id` | string | No | ID or full path. Used only to create a pipeline. Provide this, or `url`. |
| `pipeline_id` | integer | No | Existing pipeline to target. When set, requires `action`. Omit to create. |
| `action` | string | No | `retry`, `cancel`, or `update`. Required when `pipeline_id` is set. |
| `ref` | string | No | Branch or tag name. Required to create a pipeline. |
| `name` | string | No | New pipeline name. Required for `action: "update"`. |
| `variables` | array | No | Pipeline variables as `[{key, value, variable_type}]`. |
| `inputs` | hash | No | Pipeline input parameters as key-value pairs. |

To delete a pipeline use `manage_pipeline`; to list pipelines use `list_pipelines`.

#### `manage_pipeline`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | ID or full path of the project. |
| `pipeline_id` | integer | Yes | ID of the pipeline. If only this parameter is set, deletes the pipeline and all related data. |
| `name` | string | No | If this and `pipeline_id` are set, updates the pipeline metadata. |

The `list`, `create`, `retry`, and `cancel` actions were removed in 19.3 in favor of `list_pipelines` and `save_pipeline`.

#### `get_job`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | ID or full path of the project. |
| `job_id` | integer | Yes | ID of the job. |
| `include` | array | No | One facet per call: `log` or `artifacts`. |
| `byte_offset` | integer | No | Byte offset to start reading the log. Only with `log`. Default `0`. |
| `byte_limit` | integer | No | Max bytes of the log to return. Only with `log`. Default and max `512000`. |

When the log is longer than `byte_limit`, the response reports the total size and the `byte_offset` for the next window. The `artifacts` facet lists every artifact the job produced with `name`, `size`, `file_type`, and expiry. Alias `get_job_log` always returns the `log` facet.

#### `get_artifact_file`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the job. Provide this, or `project_id` and `job_id`. |
| `project_id` | string | No | Required if `url` is not provided. |
| `job_id` | integer | No | Required if `url` is not provided. |
| `artifact_path` | string | Yes | Path inside the artifacts archive, for example `coverage/index.html`. |
| `byte_offset` | integer | No | Default `0`. |
| `byte_limit` | integer | No | Default and max `1048576` (1 MB). |

Reads from the archive artifact only. Report artifacts stored as separate files (such as `junit` or `dotenv` artifacts) are not part of the archive and cannot be read with this tool. Binary files are not returned; the error names the file, its size and type, and where to view it in the browser.

### Duo Agent Platform

#### `start_duo_session`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | Yes | ID or full path of the project the flow runs in. |
| `ai_catalog_item_consumer_id` | integer | Yes | ID of the AI Catalog item consumer configuring which flow to run. |
| `goal` | string | Yes | What the agent should do; the prompt the flow starts from. |

Only catalog flows can be started this way, because only those sessions can later be answered with `send_duo_session_input`. The session runs in a CI job that can push commits and open merge requests. The response includes a suggested polling delay; follow progress with `get_duo_session` using the returned `workflow_id`.

#### `list_duo_sessions`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | No | URL of the project to filter by. Do not use with `project_id`. |
| `project_id` | string | No | Numeric ID or full path. Do not use with `url`. |
| `status_group` | string | No | `active`, `paused`, `awaiting_input`, `completed`, `failed`, or `canceled`. |
| `after` | string | No | Cursor for forward pagination. |
| `first` | integer | No | Default 20, max 100. |

Excludes Duo Chat sessions. Each session includes status, goal preview (possibly truncated), flow definition, and creation timestamp; project sessions also include a session URL. `status_group` can return sessions with multiple individual statuses. More pages are signalled by `pageInfo.endCursor`.

#### `get_duo_session`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `workflow_id` | integer | Yes | Workflow ID returned by `trigger_duo_flow` or `ask_duo_agent`. |

Alias: `get_duo_workflow_status`. Running sessions include a suggested polling delay; finished sessions and completed chat turns include the latest agent answer; sessions waiting for approval include instructions for continuing.

#### `send_duo_session_input`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `workflow_id` | integer | Yes | ID of the Duo session, as returned by `list_duo_sessions` or `get_duo_session`. |
| `human_approval` | boolean | Yes | `true` approves the pending plan or tool call, `false` rejects it. When the session asked a question, pass `true` with `human_message`. |
| `human_message` | string | No | Reply or instructions, up to 2000 characters. Required when the session asked a question. |

Only sessions with status `input_required` whose last CI job has finished accept input. Sessions with status `plan_approval_required` or `tool_call_approval_required` cannot be answered over MCP yet.

### Security, search, wiki

#### `save_vulnerability`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | Yes | `dismiss`, `confirm`, `revert_to_detected`, `update_severity`, or `create_issue`. |
| `vulnerability_id` | string | Yes | Numeric ID (for example `567`). |
| `comment` | string | No | Explanation. Required when `action` is `update_severity`. |
| `dismissal_reason` | string | No | `ACCEPTABLE_RISK`, `FALSE_POSITIVE`, `MITIGATING_CONTROL`, `USED_IN_TESTS`, or `NOT_APPLICABLE`. Use only with `dismiss`. |
| `severity` | string | No | `INFO`, `UNKNOWN`, `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`. Required when `action` is `update_severity`. |
| `project_full_path` | string | No | For example `namespace/project`. Required when `action` is `create_issue`. |

#### `attach_scan_profile`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `security_scan_profile_id` | string | Yes | Global ID, for example `gid://gitlab/Security::ScanProfile/1`. |
| `project_ids` | array of strings | No | Global IDs, for example `[gid://gitlab/Project/1]`. Required unless `group_ids` is provided. |
| `group_ids` | array of strings | No | Global IDs, for example `[gid://gitlab/Group/1]`. Required unless `project_ids` is provided. |

Attaches the profile to the given projects, or to all projects under the given groups.

#### `search`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | string | Yes | For example `work_items`, `merge_requests`, `projects`. Available scopes depend on the search type. |
| `search` | string | Yes | Search term. |
| `group_id` | string | No | Group to search. |
| `project_id` | string | No | Project to search. |
| `state` | string | No | For `work_items` and `merge_requests`. |
| `confidential` | boolean | No | For `work_items`. Default `false`. |
| `fields` | array of strings | No | Fields to search, for `work_items` and `merge_requests`. |
| `order_by` | string | No | Default `created_at` for basic search, relevance for advanced search. |
| `sort` | string | No | Default `desc`. |
| `per_page` | integer | No | Default `20`. |
| `page` | integer | No | Default `1`. |

Available for global, group, and project search. Renamed from `gitlab_search` in 18.8.

#### `search_labels`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `full_path` | string | Yes | Full path of the project or group, for example `group/project`. |
| `is_project` | boolean | Yes | `true` searches a project, `false` a group. |
| `search` | string | No | Filter by label title. |

Searching group labels includes labels from ancestor and descendant groups.

#### `semantic_search`

- **Add-on:** GitLab Duo Core, Pro, or Enterprise
- **Offering:** GitLab.com, GitLab Self-Managed

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | string | Yes | Type of content to search. Only `code` is supported. |
| `q` | string | Yes | Natural language search query. |
| `project_id` | string | Yes | ID or full path of the project. |
| `directory_path` | string | No | Restrict to files under this relative path (for example `app/services/`). No leading slash or `..` segments. Only with `scope: code`. |
| `knn` | integer | No | Nearest neighbors retrieved internally. Default 64, max 100. Higher values improve recall at the cost of latency. Only with `scope: code`. |
| `limit` | integer | No | Max results. Default 20, max 100. Only with `scope: code`. |

Availability is controlled by a feature flag. Results are grouped by file, each with merged line ranges, content, and a relevance score. For best results describe the functionality or behavior you want rather than using generic keywords or specific function or variable names. Renamed from `semantic_code_search` in 19.4; `semantic_query` was renamed to `q`.

#### `list_wiki_pages`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | No | Full path or numeric ID, for example `gitlab-org/gitlab` or `278964`. |
| `group_id` | string | No | Full path or numeric ID, for example `gitlab-org` or `9970`. |
| `first` | integer | No | Wiki pages to return. Max 100. |
| `after` | string | No | Cursor for forward pagination. |

Provide only one of `project_id` or `group_id`. More pages are signalled by `end_cursor`.
