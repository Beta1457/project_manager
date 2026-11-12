# Project Manager — Build Plan

> The original plan the app was built from, kept for reference. [README.md](README.md) describes the app as it is now.

A self-hosted, LAN-only project tracker for game development. You use it from a phone or desktop browser, and Claude (VS Code) uses it through an API.

**Target:** usable by end of Day 5.
**Server:** a home server on the local network (Windows Server 2025).
**Access URL:** `http://<server-ip>:8080`

---

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24 LTS** (needs installing; nothing is on the box yet) | One language for server, UI and the Claude CLI helper |
| Server | **Fastify** + TypeScript | Small and fast, with built-in schema validation, so the API documents itself |
| Database | **SQLite** (a single file in `data/pm.db`) | No database server to run; back up by copying one file |
| UI | **React + Vite**, plain CSS, mobile-first | Quick to build, easy to read |
| Drag & drop | **dnd-kit** | Works with touch, which matters on the phone |
| Architecture diagram | **React Flow** (diagram stored as JSON in the DB) | Drag nodes around on screen, and Claude can edit the same JSON through the API |
| Markdown | `marked` + DOMPurify | For task descriptions and notes |
| Run as service | **NSSM** (or the Windows Task Scheduler as a fallback) | Starts on boot |

Everything runs as **one process on one port**: Fastify serves both the API (`/api/*`) and the built UI.

---

## 2. Data model

```
Folder  (tree: a folder can contain folders, epochs, tasks, files)
 ├─ Epoch  (container of tasks; lives in a folder)
 │    └─ Task
 ├─ Task   (can also sit directly in a folder, outside an epoch)
 └─ File   (stored on disk under data/files/, metadata in DB)
```

**Task**
- `id`, `key` (a readable ID such as `PM-42`), `title`, `description` (markdown)
- `type`: Feature, Bug, Content, Art, Audio, Refactor, Test, Chore (editable list)
- `status`: one of the 8 Kanban columns (below)
- `categories`: many-to-many tags with colours, e.g. *Trinket, Card, Enemy, UI, Combat*
- `priority` (Low/Med/High/Critical), `epoch_id`, `folder_id`, `sort_order`
- `created_by` (user name or `claude`), timestamps
- **Activity log**: every status change and edit is recorded with who made it and when, so you can see Claude's progress on a task.
- **Checklist / subtasks** (lightweight). Claude can use these for testing steps.

**Kanban statuses (fixed order)**
`Open → In Progress → Alpha QA → Alpha Complete → Beta In Progress → Beta QA → Beta Complete → Ready to Ship`

**Epoch**: name, description, colour, folder, optional target date, and a progress bar (the share of its tasks in each status).

**Diagram**: name, nodes and edges as JSON; a node can link to a folder, epoch or task.

**Users & tokens**: users (bcrypt password hashes) and API tokens (hashed, named, revocable).

---

## 3. Features

### Web UI (mobile-first)
- **Kanban board**: 8 columns. On a phone it shows one column at a time; swipe or tap the column tabs to switch, and long-press to drag a card. On desktop all columns scroll sideways.
  - Moving a card between columns on the phone: drag it, or use the "Move to →" button on the card (more reliable on small screens).
- **Filters** (on the board and in list view): text search, type, category, epoch, folder, priority, status, created-by. Filters are kept in the URL, so filtered views can be bookmarked.
- **List view**: a sortable table of the same tasks, easier to scan on a phone.
- **Explorer**: a collapsible folder tree. Drag folders, epochs, tasks and files into other folders. Upload files (drag & drop on desktop, the file picker on the phone) and preview images, text and markdown.
- **Epoch view**: the tasks in an epoch plus its progress bar, with the same board and filters scoped to that epoch.
- **Task detail**: a full-screen sheet on the phone and a side panel on desktop. It has inline editing, a markdown description, the checklist and the activity log.
- **Quick add**: a floating "+" button that is always visible. Type a title and save; type, epoch and the rest can be filled in later. This is the "I just had an idea" path.
- **Architecture diagram**: pan and zoom, add and connect boxes, colour-code them by layer, click a node to jump to its linked epoch or task. Read-only on phones by default (editing on a touchscreen is fiddly), with an edit toggle.
- **Visual touches borrowed from ClickUp**: coloured status pills, category chips, epoch progress bars, and a count on each column header.

### API (for Claude and scripts)
- REST + JSON under `/api/v1`, authenticated with `Authorization: Bearer <token>`.
- Covers everything the UI can do: tasks, epochs, folders, files, categories, diagrams and search.
- Shortcut endpoints for agents:
  - `POST /api/v1/tasks/{key}/advance`: moves the task to the next status, with an optional note
  - `POST /api/v1/tasks/{key}/status`: sets any status, with a note
  - `POST /api/v1/tasks/{key}/comments`: adds a progress note
  - `GET /api/v1/tasks?status=…&category=…&q=…`: filtering
- Auto-generated OpenAPI docs at `/api/docs`.

### Claude VS Code integration
Delivered as files you copy into your game repo:
1. **`pm` CLI** (`tools/pm.mjs`): a small Node script that wraps the API, so Claude runs short commands instead of fragile `curl` lines with JSON quoting on Windows. For example:
   ```
   pm task create --title "Trinket: Cracked Hourglass" --type Content --category Trinket --epoch "Act 1 Relics" --desc-file notes.md
   pm task advance PM-42 --note "Unit tests passing"
   pm task list --status "In Progress"
   ```
   The server URL and token come from env vars `PM_URL` and `PM_TOKEN` (or a git-ignored `.pm.json`).
2. **Skill file** (`.claude/skills/project-tracker/SKILL.md`): tells Claude when and how to track work:
   - When you ask for a new feature (e.g. "add a trinket"), check whether a matching task exists. If it doesn't, create one with a title, type, category, epoch and a description containing acceptance criteria.
   - When it starts coding, move the task to **In Progress**.
   - When its implementation and tests pass, move it to **Alpha QA** with a note listing what was tested.
   - Never move a task past **Alpha QA** without your approval. Alpha Complete and the beta stages are human QA gates. You can loosen this rule.
   - Log notes on progress, blockers and the files touched.
3. **`CLAUDE.md` snippet**: a few lines for the game repo that point at the skill and say which epoch and project to default to.
4. *(Optional, stretch goal)* An **MCP server** that exposes the same operations as native tools. The skill + CLI approach works today; MCP can be added later if you want it.

### Security (reasonable for a LAN)
- A login page with username and password (bcrypt hashes), an HTTP-only session cookie, and a 30-day "remember me" option so you aren't logging in on your phone every time.
- Login rate limiting: lockout after repeated failures.
- Separate **API tokens** for Claude, created and revoked on a Settings page. Claude never uses your password.
- A **Windows Firewall rule** that allows port 8080 from the local subnet only.
- The first user is created with a one-time setup command (`npm run create-user`).
- Not included: HTTPS. Plain HTTP is acceptable on a trusted home LAN. If you want it later, a self-signed certificate or Caddy can be added in about an hour.

### Backups
- A nightly scheduled task copies `data/pm.db` and `data/files/` to `data/backups/` and keeps the last 14 days.

---

## 4. Timeline (5 days)

### Day 1 — Foundation & backend core
- Install Node 24 LTS, scaffold the monorepo (`server/`, `web/`, `tools/`)
- SQLite schema and migrations for all entities, plus seed data (the statuses, default types and categories)
- Auth: users, login and logout, sessions, the `create-user` script, API tokens
- Tasks / epochs / folders CRUD API, with filtering and the activity log
- **End of day:** the API works end-to-end with `curl`; you can log in and create and move tasks.

### Day 2 — Kanban board & tasks UI
- App shell: mobile nav (bottom tab bar: Board · List · Explorer · Diagram · Settings), login page
- Kanban board with dnd-kit (desktop columns plus the one-column-at-a-time mobile layout), the "Move to" fallback
- Task detail sheet, the quick-add "+" button, filters and list view
- **End of day:** you can use the board from your phone and desktop for real tasks.

### Day 3 — Explorer, epochs, files
- Folder tree UI with drag & drop for folders, epochs, tasks and files
- File upload, download and preview; files stored on disk
- Epoch views with progress bars; categories management
- **End of day:** the full organisational structure works.

### Day 4 — Claude integration & architecture diagram
- `pm` CLI, skill file, `CLAUDE.md` snippet, OpenAPI docs
- A test run: drive the "new trinket" scenario end-to-end with Claude against a sample repo
- Architecture diagram editor (React Flow), saved to the DB, plus API endpoints so Claude can add and update nodes
- **End of day:** Claude can create and advance tasks on its own, and the diagram works.

### Day 5 — Hardening, deploy, polish
- Run as a Windows service (NSSM), firewall rule, nightly backup task
- Mobile usability pass on a real phone: tap targets, font sizes, landscape mode
- Bug fixing, empty states, a README with setup steps and how to add the integration to a game repo
- **End of day:** the service starts on boot and is reachable at `http://<server-ip>:8080` from your phone and other PC.

**Buffer:** the MCP server, diagram polish and nice-to-haves (dark mode, due dates, a calendar view) are kept off the critical path. They get done only if a day finishes early.

---

## 5. Repo layout

```
project_manager/
├─ server/          Fastify API, SQLite, auth
├─ web/             React UI (built into server/public)
├─ tools/
│  ├─ pm.mjs        CLI for Claude/scripts
│  └─ claude/       SKILL.md + CLAUDE.md snippet to copy into game repos
├─ scripts/         create-user, backup, install-service
├─ data/            (git-ignored) pm.db, files/, backups/
└─ PLAN.md
```

---

## 6. Open questions (defaults in brackets)

1. **Users**: just you, or several people with their own logins? [several logins supported; no per-user permissions]
2. **Multiple projects**: one board for the game, or several projects? [Top-level folders act as projects, and the board can filter by them]
3. **How far Claude may advance a task**: [up to Alpha QA; anything later needs you]
4. **Installing software**: OK to install Node.js 24 LTS and NSSM on this server via `winget`? [yes, needed to proceed]
5. **Port**: [8080]
