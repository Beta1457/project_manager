# API reference

Base URL: `http://<server>:<port>` (port 8080 unless you chose another one in `npm run setup`). All bodies are JSON unless noted. Errors return `{"error": "message"}` with a 4xx/5xx status.

## Authentication

| Method | How |
|---|---|
| Scripts / coding agents | `Authorization: Bearer pm_...`. Each person creates their own tokens in **Settings → API tokens**. A token acts as the person who made it, in any of their projects. Its name is recorded as the actor in activity logs and owns its own running timer, so token names are unique on the server and can't match a username (e.g. `claude`, `claude-bob`). |
| Web UI | `POST /api/auth/login {username, password, remember}` sets an HTTP-only cookie. Cookie-authenticated writes must send header `x-pm-client: web` (CSRF guard). |

`GET /api/auth/me` → `{user: {id, username, isAdmin}, actor, via}` · `POST /api/auth/logout` · `POST /api/auth/password {currentPassword, newPassword}` · `GET /api/auth/status` → `{setupRequired}` (no auth) · `GET /api/health` (no auth)

## Projects

Every project belongs to one account, and only that account can see or change anything in it (through the web app or its own tokens). Admins can't see other people's projects either. Anything outside your projects answers **404**, exactly like an id that doesn't exist.

**Which project a request works in.** List and create endpoints (tasks, epochs, folders, tree, files, docs, time, diagrams, meta, categories, types, statuses) work in the *current project*:

1. the `X-PM-Project` header (project id or key), else
2. the `?project=` query parameter (id or key), else
3. your only project, if you have exactly one.

With several projects and none named, they answer 400 and list your projects. Requests for a single item by id (`/tasks/APP-12`, `/epochs/3`, `/files/7`...) find its project themselves and need no header. Ids inside a body (`epochId`, `folderId`, a linked task...) must belong to the same project.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/projects` | `{projects[]}`, oldest first |
| `GET /api/v1/projects/current` | The project this request would work in (see above) |
| `GET /api/v1/projects/:id` | `:id` is the id or the key |
| `POST /api/v1/projects` | `{key*, name*, color?, copyFrom?: projectId, categories?: [[name, color]]}` → 201. The key prefixes task keys (`APP` → `APP-12`): a letter, then up to 9 letters or digits, unique on the server. `copyFrom` copies task types, categories, column colours and task templates from another of your projects; otherwise you get the default types and `categories`. |
| `PATCH /api/v1/projects/:id` | `{key?, name?, color?}`. A new key renames every task key in the project (`APP-12` → `WEB-12`). |
| `DELETE /api/v1/projects/:id?confirm=KEY` | Web session only, and the key must be repeated as `confirm`: deletes the project's tasks, epochs, folders, files, diagrams and time. Backups keep their copies. |

A project is `{id, key, name, color, taskCount, openTaskCount, createdAt, updatedAt}`; `openTaskCount` counts tasks that aren't Ready to Ship.

## Reference data

Each project has its own categories, task types and column colours.

- `GET /api/v1/meta` → `{project{id,key,name,color}, statuses[{id,label,color}], priorities[], types[], typeColors{name: color}, categories[]}`
- Categories: `GET|POST /api/v1/categories {name, color}` · `PATCH|DELETE /api/v1/categories/:id`
- Task types: `GET|POST /api/v1/types {name, color?}` · `PATCH /api/v1/types/:name {color}` · `DELETE /api/v1/types/:name` (409 if in use)
- Kanban column colours: `GET /api/v1/statuses` · `PATCH /api/v1/statuses/:id {color}`

Colours are `#RRGGBB`. Epochs have their own `color` (see Epochs).

Statuses accept the id (`alpha_qa`) or label (`Alpha QA`), case-insensitive.

## Tasks

A task reference is its key (`APP-12`, case-insensitive) or its numeric `id`. A bare number is always the internal id, not the number within the project: use keys whenever you can. Tasks include `key`, `number` (the part after the dash) and `projectId`. Numbers are never reused, even after a delete.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/tasks` | Query: `q` (text, or a key like `APP-12`; keys of other projects match nothing), `status`, `type`, `category`, `priority` (comma-separated lists), `epoch` (id or `none`), `folder` (id — includes sub-folders and their epochs — or `inbox`), `parent` (a task's key or id for its sub-tasks, `none` for top-level tasks only, `any` for sub-tasks only), `createdBy`, `limit`, `summary=1` (omit descriptions) |
| `GET /api/v1/tasks/:ref` | Includes `checklistItems`, `links`, `children` (its sub-tasks, oldest first, without descriptions) and `activity` |
| `POST /api/v1/tasks` | `{title*, description, type, status, priority, epochId, folderId, parent: "APP-3" \| 3, categories: [names or ids], checklist: [text], estimate: "1h30m" \| estimateMinutes, note}`. With `template` (a name or id), the task and its sub-tasks come from that template: see [Task templates](#task-templates). |
| `PATCH /api/v1/tasks/:ref` | Any of the create fields. Setting `epochId` moves the task into the epoch; setting `folderId` (or `null` = inbox) removes it from its epoch. `note` is logged with a status change. `parent` makes it a sub-task of another task; `null` (or `"none"`) makes it a top-level task again. |
| `POST /api/v1/tasks/:ref/advance` | `{note?}` → next status |
| `POST /api/v1/tasks/:ref/status` | `{status*, note?}` |
| `POST /api/v1/tasks/:ref/move` | Board ordering: `{status*, beforeId?}` (null = end of column) |
| `POST /api/v1/tasks/:ref/comments` | `{message*}` |
| `POST /api/v1/tasks/:ref/checklist` | `{text*}` |
| `PATCH /api/v1/checklist/:itemId` | `{text?, done?}` |
| `DELETE /api/v1/checklist/:itemId` | Removes the item |
| `DELETE /api/v1/tasks/:ref` | `?withSubtasks=true` also deletes its sub-tasks; without it they stay, as top-level tasks. Links go too. Tasks that stay get a note in their activity. → `{ok, deleted}` (how many tasks were deleted) |
| `POST /api/v1/tasks/bulk` | Changes up to 500 tasks of one project in one go, all or nothing. `{action*, ids*: ["APP-12", 13, ...]}` and, by action: `"update"` with `set: {type, status, priority, epochId, folderId, estimate, estimateMinutes, categories, note, parent}` (any of them, the same as in a PATCH; not the title, description or checklist, which are each task's own); `"move"` with `status*` and `beforeId?` (the tasks end up together, in the order given, before that task or at the end of the column); `"categories"` with `add` and/or `remove`: [names or ids]; `"delete"` with `withSubtasks?`. A task that doesn't exist or isn't yours fails the whole request (404), and so do tasks from two projects (400); nothing changes until every task has been checked. Each task gets its own activity entry. → `{ok, tasks}` (the tasks as they are now), or `{ok, deleted}` |
| `POST /api/v1/tasks/:ref/links` | `{task*: "APP-9" \| 9, kind?}`. `kind` is one of `relates` (default), `blocks`, `blocked_by`, `duplicates` or `duplicated_by`, read from this task's side; labels like `"blocked by"` also work. Both tasks must be in the same project (400 otherwise). 409 if the two tasks are already linked: one link per pair. Returns the task, including `links`. |
| `DELETE /api/v1/tasks/:ref/links/:other` | Removes the link between the two tasks, whichever direction it was made in |

Each entry in `links` is `{id, kind, outgoing, label, task: {id, key, title, status, statusLabel, type}}`, where `label` reads from this task's side, e.g. `"blocked by"`. Task lists include `openBlockers`: the number of tasks blocking this one that haven't reached Alpha Complete.

**Sub-tasks.** A sub-task is a full task with a `parent` in the same project: it has its own status, estimate, time, epoch and folder (often a different epoch from its parent's). One level only: a sub-task can't have sub-tasks, and a task with sub-tasks can't become one (400). Tasks include `parentId`, `parent: {id, key, title} | null` and `subtasks: {done, total}`, where `done` counts sub-tasks at Alpha Complete or later. Adding, moving and removing a sub-task is noted in the activity of the task and of its parent.

## Task templates

A template holds a task's fields and, if you like, sub-tasks, saved in a project under a name (unique in the project, ignoring case, and with at least one letter: a bare number means a template id). Types, categories and epochs are stored by name and looked up each time the template is used, so a template keeps working after they change, and in new projects that copy it (`copyFrom`). `{title}` in a title, description or checklist item becomes the title given when the template is used.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/templates` | The current project's templates, by name |
| `GET /api/v1/templates/:ref` | One template, by id or name |
| `POST /api/v1/templates` | `{name*, title, description, type, priority, categories: [names], estimate: "1h30m" \| estimateMinutes, checklist: [text], epoch: name, subtasks: [{title*, description, type, priority, categories, estimate, checklist, epoch}]}` → 201. `title` defaults to `"{title}"`. Or `{name*, fromTask: "APP-12", includeSubtasks?}` saves an existing task (checklist texts, unticked); other fields sent along replace what it copies. 409 if the name is taken. At most 50 sub-tasks, 100 checklist items and 50 categories per task, and 200 KB in all, `fromTask` included (400). |
| `PATCH /api/v1/templates/:ref` | Any of the fields; `subtasks` replaces the whole list. 409 if a new name is taken |
| `DELETE /api/v1/templates/:ref` | Tasks already made from it stay as they are |

A template is `{id, projectId, name, title, description, type, priority, categories, estimateMinutes, checklist, epoch, subtasks, createdBy, createdAt, updatedAt}`, where `type`, `priority`, `estimateMinutes` and `epoch` may be null (the default type and priority; no estimate; where the task is added).

**Using a template.** `POST /api/v1/tasks {template: "Card", title: "Fireball", ...}` creates the task and its sub-tasks in one go. Fields in the request replace the template's; `categories` and `checklist` replace the whole list. A title is needed only when the template's title has `{title}` in it; otherwise a title sent replaces the template's. The task goes to the template's epoch unless the request gives `epochId` or `folderId`. Sub-tasks start in the first status, in the epoch their template names, else where the new task is. A task made from a template with sub-tasks can't be a sub-task itself (400). The response is the new task, with `children`, plus `warnings`: a type, category or epoch name the project doesn't have is skipped with a note there instead of failing, and an epoch name that several epochs share goes to the first of them.

## Epochs

- `GET /api/v1/epochs` · `GET /api/v1/epochs/:id` — include `counts` per status, `loggedMinutes` (epoch + its tasks), `estimateMinutes`, `taskEstimateMinutes`
- `POST /api/v1/epochs {name*, description, color, folderId, targetDate: "YYYY-MM-DD", estimate}`
- `PATCH /api/v1/epochs/:id` · `DELETE /api/v1/epochs/:id[?deleteTime=true]` (tasks are kept and moved to the epoch's folder; if time was logged directly on the epoch the delete is refused with 409 unless `deleteTime=true`, because that time is deleted with it)

## Folders, tree and files

- `GET /api/v1/folders` · `POST {name*, parentId}` · `PATCH /:id {name?, parentId?}` (cycles rejected) · `DELETE /:id` (contents move to the parent)
- `GET /api/v1/tree` — folders, epochs, tasks and files in one response (used by the explorer)
- `GET /api/v1/files?folder=<id|root>` · `GET /api/v1/files/:id`
- `POST /api/v1/files` — `multipart/form-data`; optional field `folderId` before one or more file parts
- `GET /api/v1/files/:id/content[?download=1]` — text/code files are served as `text/plain` (never executed)
- `PATCH /api/v1/files/:id {name?, folderId?}` · `DELETE /api/v1/files/:id`
- `POST /api/v1/copy {item | items, to*, dryRun?}` — the explorer's Copy, Paste and Duplicate. Send `item: {kind: "folder"|"epoch"|"task"|"file", id}`, or `items`: a list of up to 500 of them, all in one project. `to` is `{folderId}`, `{epochId}`, or `{inPlace: true}` to put each copy next to its original (Duplicate) → 201 `{ok, folders, epochs, tasks, files, bytes, subtasksElsewhere, item, items}`: how many of each were made, and the copies of the items asked for as `{kind, id, name}` (`item` is the first). `dryRun: true` returns the same counts and makes nothing.
  - A folder brings everything inside it (sub-folders, epochs, tasks and files), an epoch its tasks, a task its sub-tasks. `folderId: null` is the top level, or for a task the Inbox. Only tasks go into an epoch, and a folder can't go into itself or a folder inside it (400).
  - An item that is inside another of the items (a file in a folder that is copied too, a task in a copied epoch, a sub-task whose parent is copied) is copied once, along with what it is in.
  - Copied tasks get new keys and start in the first status, checklists unticked; their time, comments, links and activity aren't copied. A sub-task copied with its parent goes under the parent's copy: into the copy of its epoch or folder if that is copied too, else next to the parent's copy if it was next to the parent, else into its own epoch or folder (`subtasksElsewhere` counts these). A sub-task copied on its own keeps its parent.
  - Each file gets its own copy of the stored content, and `/api/v1/files/<id>` links in copied documents and descriptions point at the copies of files copied with them.
  - Only the items asked for are renamed, to "Name (copy)" or "Name (copy 2)", when the name is taken where they land.
  - At most 2,000 items and 500 MB of files in one copy (400). All or nothing: if anything fails, nothing is made.
- `POST /api/v1/explorer/move {items*, to*: {folderId} | {epochId}}` — the explorer's multi-select: moves up to 500 items of any kinds (same `{kind, id}` list as copy) → `{ok, moved}`. What is inside a folder or epoch that moves goes with it, including any of the items inside it, and items already there stay as they are. The rules are the same as for one item: only tasks go into an epoch, and a folder can't go into itself or a folder inside it (400, naming the item). All or nothing.
- `POST /api/v1/explorer/delete {items*, withSubtasks?, deleteTime?}` — deletes up to 500 items of any kinds → `{ok, deleted: {folders, epochs, tasks, files}}`. Each goes as it would on its own: tasks (with their checklists, comments, links and time) and files are deleted for good, the rest of a folder's contents move up to its parent, and the rest of an epoch's tasks move to its folder. Sub-tasks of deleted tasks become top-level tasks unless `withSubtasks: true`. If an epoch has time logged directly on it, the request is refused with 409 unless `deleteTime: true`. All or nothing.
- Upload field `purpose=attachment` (without `folderId`) stores the file in the project's root **Attachments** folder. The web editors use this for images pasted into task and epoch descriptions.
- Markdown/text documents: `POST /api/v1/docs {name*, folderId?, content?}` (`.md` added if there's no extension) · `PUT /api/v1/files/:id/content {content}` (text files only, max 2 MB)
- Embed images in any markdown field with `![alt](/api/v1/files/<id>/content)` (SVG: use `/render` instead of `/content`)
- `GET /api/v1/files/:id/render` — live preview of an `.html`, `.htm` or `.svg` file (max 5 MB; other types get 400). The response carries a CSP `sandbox` (no `allow-same-origin`), so the page gets its own opaque origin. Its scripts run, but they can't see the login cookie, call this API, submit forms or navigate the app.
  - Images, stylesheets, scripts and fonts the page references by a path relative to its explorer folder (`images/a.png`, `../shared/site.css`) or by `/api/v1/files/<id>/content` are embedded as `data:` URIs, up to 10 MB each and 25 MB per page.
  - Links to other uploaded pages, by relative path (`setup.html#install`) or `/api/v1/files/<id>/...`, open that page's preview in the app; links to the page itself become `#fragment` links.
  - External `https:` resources and links work as usual.

## Time tracking

Each user (web) and each API token has at most one running timer across all their projects; starting another stops the first.

Durations accept minutes (`90`) or units: `45m`, `45 min`, `1.5h`, `1h30m`, `2h 15m`, `2 hours`, `1hr`. Dates are ISO; a bare date (`2026-11-11`) means that day in the server's time zone — entries land at local noon, and `from`/`to` cover whole days (`to` is inclusive).

- `GET /api/v1/time?taskId=&epochId=&actor=&from=&to=` → `{entries[], totalMinutes}` for the current project (`epochId` includes the epoch's tasks)
- `GET /api/v1/time/running` → `{entry | null}` for the caller, in whichever project it runs
- `POST /api/v1/time/start {taskId | epochId, note?}`
- `POST /api/v1/time/stop {note?}`
- `POST /api/v1/time {taskId | epochId, duration: "1h30m" | minutes: 90, note?, date?}` — manual entry
- `PATCH /api/v1/time/:id {duration?|minutes?, note?, date?}` (stop a running timer before changing its duration or date) · `DELETE /api/v1/time/:id`

## Architecture diagrams

Each project starts with one diagram, "Code Architecture". The web app lays diagrams out automatically (ELK) unless a diagram is switched to the manual layout, where boxes keep the positions people give them.

- **Box (node):** `id` (1-128 characters; made for you if left out), `label*` (unique inside its group), `layer` (colour; `layers[]` lists the usual ones), `description`, `role` (one line on what it does, ≤200), `path` (file or folder, ≤300), `weight` (0-1e9: bigger boxes for busier code, e.g. lines of code), `width` 40-4000 and `height` 24-4000 (fixed size in px; otherwise it fits the text), `parent` (the box it sits in; up to 6 levels, no loops), `x`/`y` (relative to the parent; only the manual layout uses them), `link {kind: "task"|"epoch"|"folder"|"file", id}` (dropped if it points outside the diagram's project).
- **Arrow (edge):** `id`, `source*`, `target*`, `label` (≤200), `count` (1-1e6: how many references it stands for; shown as "×N"). One arrow per direction between two boxes; an arrow between a box and a group it is inside is a 400.
- **Settings:** `{layout: "auto"|"manual", direction: "DOWN"|"RIGHT"}`.
- Wherever a request names a box (`:node`, `parent`, `source`, `target`), it may give the id or the label; a label several boxes share is a 409 (use the id). Limits: 2000 boxes, 5000 arrows (`limits` in the list).

Endpoints:

- `GET /api/v1/diagrams` → `{layers[], limits {nodes, edges, depth}, diagrams[{id, name, version, updatedAt, nodeCount, edgeCount}]}` · `POST {name}` · `GET /:id` → `{id, name, version, nodes[], edges[], settings, …}` · `DELETE /:id`
- `PATCH /api/v1/diagrams/:id {name?, settings?}` — rename, or change the layout or direction
- `PUT /api/v1/diagrams/:id {version, schema: 2, name?, nodes[], edges[], settings?}` — full replace (the web editor's save); 409 if `version` is stale. Without `schema: 2` the body is taken to come from an older page: box fields and settings it leaves out are kept from the stored diagram.
- `POST /api/v1/diagrams/:id/import {mode?: "merge"|"replace", nodes[], edges?, settings?, version?, dryRun?}` — many changes in one save (one version, one event) → `{mode, dryRun, version, nodes: {added, updated, removed}, edges: {…}, settingsChanged}`. Each box is matched to a stored one by id, then by label in a parent with the same label, then by label anywhere; a matched box keeps the fields the import leaves out (position, size, link…) and takes the import's id if it gives one. Unmatched boxes are added. `merge` (the default) keeps everything the import doesn't list; `replace` removes it. An arrow listed more than once becomes one arrow whose count is the total. `updated` counts only boxes and arrows that actually change, and `settingsChanged` says whether `settings` changes the layout or direction, so importing a diagram's own export reports nothing. `dryRun: true` reports without saving. Same JSON as `GET /:id` (or the web app's export) works as input.
- `POST /:id/nodes {label*, …box fields}` (placed automatically if x/y are left out) · `PATCH /:id/nodes/:node {…box fields}` (fields left out keep their values; `null` clears one; moving it to another group places it again unless x/y are given)
- `DELETE /:id/nodes/:node[?withChildren=true]` → `{ok, removed}` — also removes its arrows. The boxes inside it move up a level (409 if a label would clash there), or with `withChildren=true` are removed too, at every depth.
- `POST /:id/edges {source*, target*, label?, count?}` (if the two boxes are already joined that way, returns that arrow unchanged) · `PATCH /:id/edges/:edge {label?, count?}` (`count: null` resets it to 1) · `DELETE /:id/edges/:edge`

## Accounts, tokens and backups

The first account created on a server is an admin. Admins manage accounts and see the backup list; they still can't see other people's projects.

- Tokens (web session only; everyone manages their own): `GET /api/v1/tokens` · `POST /api/v1/tokens {name}` (the plain token is returned once and only its hash is stored; 409 if the name is taken by a token or user) · `DELETE /api/v1/tokens/:id`
- Accounts (web session, admins only): `GET /api/v1/users` → `{users[{id, username, isAdmin, createdAt, projectCount}]}` · `POST /api/v1/users {username, password, admin?}` · `DELETE /api/v1/users/:id[?deleteProjects=true]` (409 while the account owns projects, unless `deleteProjects=true`, which deletes them too; you can't delete yourself)
- Backups: `GET /api/v1/backups` (web session, admins only: a backup holds every account's projects) · `POST /api/v1/backups` (back up now; anyone, tokens included; for non-admins at most one new backup a minute, otherwise the latest is returned)

## Coding agent integration files

`GET /integration/<file>` (no login; none of these contain secrets): `install.mjs`, `SKILL.md`, `pm.mjs`, `API.md`, `instructions.md`. They're served as plain text. `install.mjs` sets up Claude Code or any agent that reads `AGENTS.md`, and defaults to the server address it was downloaded from, so `node install.mjs` in a repo needs no URL.

## Live updates

`GET /api/events` — Server-Sent Events stream; each message is `{"kind": "tasks"|"epochs"|"folders"|"files"|"categories"|"types"|"diagrams"|"time"|"templates"|"projects", "id"?, "actor"?, "origin"?, "projectId"?}`. A stream only receives changes in the caller's own projects (and to their own project list). `origin` echoes the optional `x-pm-client-id` request header of the browser tab that made the change.

<!-- Part of Project Manager. Copyright (c) 2026 Bettafish Games, LLC. MIT License. -->
