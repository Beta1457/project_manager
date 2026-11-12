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
| `POST /api/v1/projects` | `{key*, name*, color?, copyFrom?: projectId, categories?: [[name, color]]}` → 201. The key prefixes task keys (`APP` → `APP-12`): a letter, then up to 9 letters or digits, unique on the server. `copyFrom` copies task types, categories and column colours from another of your projects; otherwise you get the default types and `categories`. |
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
| `GET /api/v1/tasks` | Query: `q` (text, or a key like `APP-12`; keys of other projects match nothing), `status`, `type`, `category`, `priority` (comma-separated lists), `epoch` (id or `none`), `folder` (id — includes sub-folders and their epochs — or `inbox`), `createdBy`, `limit`, `summary=1` (omit descriptions) |
| `GET /api/v1/tasks/:ref` | Includes `checklistItems`, `links` and `activity` |
| `POST /api/v1/tasks` | `{title*, description, type, status, priority, epochId, folderId, categories: [names or ids], checklist: [text], estimate: "1h30m" \| estimateMinutes, note}` |
| `PATCH /api/v1/tasks/:ref` | Any of the create fields. Setting `epochId` moves the task into the epoch; setting `folderId` (or `null` = inbox) removes it from its epoch. `note` is logged with a status change. |
| `POST /api/v1/tasks/:ref/advance` | `{note?}` → next status |
| `POST /api/v1/tasks/:ref/status` | `{status*, note?}` |
| `POST /api/v1/tasks/:ref/move` | Board ordering: `{status*, beforeId?}` (null = end of column) |
| `POST /api/v1/tasks/:ref/comments` | `{message*}` |
| `POST /api/v1/tasks/:ref/checklist` | `{text*}` |
| `PATCH /api/v1/checklist/:itemId` | `{text?, done?}` |
| `DELETE /api/v1/checklist/:itemId`, `DELETE /api/v1/tasks/:ref` | Deleting a task also removes its links (noted in the linked tasks' activity) |
| `POST /api/v1/tasks/:ref/links` | `{task*: "APP-9" \| 9, kind?}`. `kind` is one of `relates` (default), `blocks`, `blocked_by`, `duplicates` or `duplicated_by`, read from this task's side; labels like `"blocked by"` also work. Both tasks must be in the same project (400 otherwise). 409 if the two tasks are already linked: one link per pair. Returns the task, including `links`. |
| `DELETE /api/v1/tasks/:ref/links/:other` | Removes the link between the two tasks, whichever direction it was made in |

Each entry in `links` is `{id, kind, outgoing, label, task: {id, key, title, status, statusLabel, type}}`, where `label` reads from this task's side, e.g. `"blocked by"`. Task lists include `openBlockers`: the number of tasks blocking this one that haven't reached Alpha Complete.

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

Each project starts with one diagram, "Code Architecture".

- `GET /api/v1/diagrams` → `{layers[], diagrams[]}` · `POST {name}` · `GET /:id` · `DELETE /:id`
- `PUT /api/v1/diagrams/:id {version, name?, nodes[], edges[]}` — full replace; 409 if `version` is stale
- Node/edge operations (node refs may be the id or the label):
  - `POST /:id/nodes {label*, layer?, description?, x?, y?, link?: {kind: "task"|"epoch"|"folder"|"file", id}}` (auto-positioned if x/y omitted; a `link` to something outside the diagram's project is dropped)
  - `PATCH /:id/nodes/:node` · `DELETE /:id/nodes/:node` (also removes its edges)
  - `POST /:id/edges {source*, target*, label?}` · `DELETE /:id/edges/:edgeId`

## Accounts, tokens and backups

The first account created on a server is an admin. Admins manage accounts and see the backup list; they still can't see other people's projects.

- Tokens (web session only; everyone manages their own): `GET /api/v1/tokens` · `POST /api/v1/tokens {name}` (the plain token is returned once and only its hash is stored; 409 if the name is taken by a token or user) · `DELETE /api/v1/tokens/:id`
- Accounts (web session, admins only): `GET /api/v1/users` → `{users[{id, username, isAdmin, createdAt, projectCount}]}` · `POST /api/v1/users {username, password, admin?}` · `DELETE /api/v1/users/:id[?deleteProjects=true]` (409 while the account owns projects, unless `deleteProjects=true`, which deletes them too; you can't delete yourself)
- Backups: `GET /api/v1/backups` (web session, admins only: a backup holds every account's projects) · `POST /api/v1/backups` (back up now; anyone, tokens included; for non-admins at most one new backup a minute, otherwise the latest is returned)

## Coding agent integration files

`GET /integration/<file>` (no login; none of these contain secrets): `install.mjs`, `SKILL.md`, `pm.mjs`, `API.md`, `instructions.md`. They're served as plain text. `install.mjs` sets up Claude Code or any agent that reads `AGENTS.md`, and defaults to the server address it was downloaded from, so `node install.mjs` in a repo needs no URL.

## Live updates

`GET /api/events` — Server-Sent Events stream; each message is `{"kind": "tasks"|"epochs"|"folders"|"files"|"categories"|"types"|"diagrams"|"time"|"projects", "id"?, "actor"?, "origin"?, "projectId"?}`. A stream only receives changes in the caller's own projects (and to their own project list). `origin` echoes the optional `x-pm-client-id` request header of the browser tab that made the change.
