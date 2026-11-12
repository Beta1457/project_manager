---
name: project-tracker
description: Track development work in the user's self-hosted Project Manager (projects with a Kanban board, epochs, folders/files, time tracking, architecture diagram, design docs). Use whenever the user asks for a new feature, content, bug fix or refactor; when starting or finishing implementation or testing of tracked work; when the user mentions a task key like APP-12, an epoch, the board, QA status, or time spent; or when adding/changing a major system that belongs on the architecture diagram.
---

# Project Tracker

The project's tasks live in a self-hosted Project Manager. You operate it with the `pm` CLI that sits next to this file:

```
node .claude/skills/project-tracker/pm.mjs <command>
```

(Below, `pm` means that full command.) Connection settings come from `.pm.json` in the repo root (git-ignored): the server, an API token, and the **project** this repo belongs to. Run `pm whoami` if unsure it is configured; it shows the project too. Run `pm help` for every command and `pm meta` for the valid statuses, types and categories — never guess these.

## Projects and task keys

- The user can have several projects; each has its own board, epochs, folders, files, diagram, types and categories. Every command works in the project from `.pm.json`. Stay in it.
- Task keys are `<PROJECT KEY>-<number>`, e.g. `APP-12`. A bare number (`pm task get 12`) means task 12 of the current project. Always copy keys from command output; never invent them.
- Only if the user asks about another of their projects: `pm project list`, then add `--project KEY` to individual commands. `pm project use KEY` changes this repo's project permanently, so only run it when the user asks for exactly that.
- Tasks can only be linked to tasks in the same project.

## Kanban flow

`Open → In Progress → Alpha QA → Alpha Complete → Beta In Progress → Beta QA → Beta Complete → Ready to Ship`

**You may move tasks through `Open → In Progress → Alpha QA` on your own.** Everything after Alpha QA is a human QA gate: only move a task to Alpha Complete, Beta *, or Ready to Ship when the user explicitly tells you to (e.g. "alpha QA passed for APP-12", "start beta on the onboarding epoch"). In the beta phase the same pattern repeats: you may move `Beta In Progress → Beta QA` for work you do; the user approves Beta Complete and Ready to Ship.

## Workflow for a new request

When the user asks for something new (e.g. "add a settings page with a dark mode toggle"):

1. **Look for an existing task first**: `pm task list --q "<2-3 keywords>"`. If one matches, use it (tell the user its key).
2. **Otherwise create one**, filling in real details — not placeholders:
   ```
   pm task create --title "Add dark mode toggle to settings" --type Feature --category UI \
     --epoch "<epoch name>" --priority medium --estimate 1h30m \
     --desc-file <tmp-file.md> --check "Toggle and saved preference" --check "Dark palette" --check "Tests"
   ```
   - Title: an imperative phrase (`Fix tooltip clipping`, `Add CSV export`), or `<Kind>: <Name>` for content items (`Level: Ice Cave`, `Enemy: Slime Boss`).
   - Description (markdown) should contain: **Summary**, **Acceptance criteria** (bullet list, testable), and **Implementation notes** (files/systems likely touched). Write it to a temp file and pass `--desc-file` for anything longer than one line, then delete the temp file.
   - Type: one of the project's types (`pm meta`; by default Feature / Bug / Content / Art / Audio / Refactor / Test / Chore).
   - Categories must exist (`pm meta`). If a clearly needed category is missing, create it with `pm category create --name X --color #hex` and mention that to the user.
   - Epoch: use the one the user names, or the default in the project instructions (CLAUDE.md or AGENTS.md). If neither exists and it's ambiguous, ask. `pm epoch list` shows options.
   - Give a realistic `--estimate`.
3. **Tell the user** the task key you created or reused.

## Picking up work the user added

The user often captures ideas on their phone. When they say things like "work on APP-12", "look at my new ideas", "what's in the inbox" or "pick up the next open task":

1. Find it: `pm task get APP-12`, or list candidates with `pm task list --status open` / `pm task list --folder inbox` (quick ideas without a folder or epoch) / `pm task list --created-by <username>` / `pm task list --q "<keywords>"`.
2. Read everything: the description, checklist, links and recent activity from `pm task get`. If it says **BLOCKED**, its blockers (`blocked by` links) aren't at Alpha Complete yet. Tell the user and suggest doing the blocker first, rather than starting it anyway. Images in the description look like `![name](/api/v1/files/<id>/content)`. Download them with `pm file download <id> --out <tmp path>` and look at them, since sketches and screenshots often carry the actual idea. Linked documents can be read with `pm doc read <id>`.
3. Phone notes are usually short. Before coding, flesh the task out: fill in the description (summary, acceptance criteria, implementation notes), the type, the categories and an estimate with `pm task update`, and tell the user what you understood. If the idea is genuinely ambiguous, ask first.
4. Then follow "While working" and "Finishing" below.

If the user asks which of their ideas to do next, list them and recommend an order. Don't start several at once.

## While working

- **Starting work**: `pm task status APP-12 "In Progress" --note "<plan in one line>"` then `pm time start --task APP-12`.
- **Progress notes** for meaningful decisions, blockers or surprises: `pm task note APP-12 "<what and why>"`. Keep notes short and factual; no notes for trivial steps.
- **Checklist**: `pm task get APP-12` shows item ids; tick with `pm item <id>` (`--undo` to untick); add items with `pm task check APP-12 "text"`; reword with `pm item <id> --text "..."`; remove with `pm item <id> --remove`.
- **Scope changes**: keep the task current with `pm task update APP-12 --title/--desc-file/--category/--priority/--estimate ...` rather than letting the description go stale.
- **Bugs found along the way** that are out of scope: create a separate `--type Bug` task in the same epoch rather than silently fixing or forgetting them. Link it to the task you were on: `pm task link APP-31 relates to APP-12`.
- **Links between tasks**: `pm task link APP-12 blocks APP-9` (also `blocked by`, `duplicates`, `duplicated by`, `relates to`; plain `pm task link APP-12 APP-9` means relates to). Remove a link with `pm task unlink APP-12 APP-9`. Writing a key like `APP-9` in any description or note also makes it clickable in the web UI.
  - Record a dependency as soon as you find one: if APP-12 can't be finished until APP-9 is, run `pm task link APP-12 blocked by APP-9`.
  - If you find a duplicate, link it with `duplicates` and tell the user. Don't delete it.

## Finishing

When implementation is complete **and tests pass**:

1. `pm time stop --note "<what was done>"`
2. `pm task status APP-12 "Alpha QA" --note "Implemented X. Tests: <which tests/commands ran> — <results>. Files: <main files touched>."`
3. Tell the user it is ready for Alpha QA and what they should check manually.

If tests fail and you cannot fix them, leave the task In Progress, add a note describing the failure, and stop the timer.

## Architecture diagram

When you add a new system/module/service or change how major systems connect, update the diagram. The web app arranges it automatically, so never set x/y or sizes. Boxes are named by label (case-insensitive) or id.

```
pm diagram show                                     # boxes as a tree (with ids), then the arrows
pm diagram add-node --label "Combat" --layer gameplay --path src/combat/ --role "Runs fights" --link-task APP-12
pm diagram add-node --label "DamageCalc" --parent "Combat" --path src/combat/DamageCalc.cs --role "Works out hit damage" --weight 420
pm diagram connect "DamageCalc" "Stats" --label "reads" --count 3
pm diagram update-node "DamageCalc" --role "..."    # "none" clears a field; --parent none moves it to the top level
pm diagram update-edge "DamageCalc" "Stats" --count 5
pm diagram rm-node "Combat" --with-children         # without --with-children the boxes inside move up a level
```

- **Groups:** a box with `--parent` sits inside that box, which becomes a group the user can open and close. Use one group per system (its folder or namespace) with its main classes inside; groups can nest up to 6 levels. Labels only need to be unique inside a group, so two systems can each have a "Config".
- **Fields:** `--role` is one line on what it does; `--path` is its file or folder; `--weight` makes busier boxes bigger (use one measure everywhere, e.g. lines of code); `--layer` colours it: core, gameplay, ui, data, services, tools, external.
- **Arrows** point from the box that uses something to what it uses; `--count` says how many references one arrow stands for. Between two systems, add either the class-to-class arrows (a closed group shows them added up, e.g. "uses ×42") or one arrow between the two groups with a count, not both. Big groups also add up the arrows leaving them at their edge; selecting a box shows its own.
- **Many changes** (a first build, a restructure, or more than about 20 boxes or arrows): write a JSON file and import it in one save instead of running many commands.

```json
{
  "nodes": [
    { "id": "combat", "label": "Combat", "layer": "gameplay", "path": "src/combat/", "role": "Runs fights" },
    { "id": "damage-calc", "label": "DamageCalc", "parent": "combat", "path": "src/combat/DamageCalc.cs", "weight": 420 },
    { "id": "stats", "label": "Stats", "layer": "data", "path": "src/data/Stats.cs" }
  ],
  "edges": [{ "source": "damage-calc", "target": "stats", "label": "reads", "count": 3 }]
}
```

```
pm diagram import <tmp.json>          # dry run: prints what would be added, updated and removed
pm diagram import <tmp.json> --yes    # applies it
pm diagram export --out <tmp.json>    # the current diagram in the same format
```

Import matches boxes by id, then by label (in a parent with the same label first) and keeps the fields a box leaves out. It only adds and updates; `--replace` also removes every box and arrow the file doesn't list, so read its dry run first. Limits: 2000 boxes, 5000 arrows. Keep labels as the code's class/module names. Don't add boxes for small helpers.

## Organising: epochs, folders and the explorer

`pm tree` prints the whole explorer: folders, epochs with their tasks, inbox tasks and files, with ids.

```
pm epoch create --name "Version 1.0" --color #f59e0b --folder "Releases" --estimate 20h --target 2026-12-15 --desc-file <tmp.md>
pm epoch update "Version 1.0" --folder root            # move an epoch (any create flag can be changed)
pm task update APP-12 --epoch "Version 1.0"            # move a task into an epoch
pm task update APP-12 --folder "Backlog"               # take it out of its epoch into a folder (inbox = no folder)
pm folder create --name "Releases" [--parent "Planning"]
pm folder rename "Releases" --name "Milestones"  |  pm folder move "Milestones" --parent root  |  pm folder delete "Old"
```

Deleting a folder moves its contents up a level; deleting an epoch keeps its tasks. Folder and epoch names are case-insensitive; if a name is ambiguous the CLI says so — use the id. Before a large reorganisation the user asked for, run `pm backup` first.

## Design documents & images

Longer design notes (e.g. a feature overview, balancing tables) can live as markdown documents in the explorer:

```
pm doc create --name "Onboarding design.md" --folder "<folder>" --file <tmp.md>
pm doc write <id> --file <tmp.md>      # replace content
pm doc read <id>
pm file upload ./screenshot.png --folder "<folder>"   # prints the embed line: ![alt](/api/v1/files/<id>/content)
pm file list --folder "<folder>"  |  pm file download <id> --out <path>
pm file rename <id> --name "new.md"  |  pm file move <id> --folder "<folder>"|root  |  pm file delete <id>
```

Uploaded images can be embedded in any markdown field (task/epoch descriptions, documents) with the printed embed line.

HTML pages (`.html`/`.htm`) and `.svg` files get a live preview in the explorer. To publish a set of HTML pages with their images, stylesheets and scripts, upload them into one explorer folder with the same relative layout as on disk (`pm folder create --name images --parent "<folder>"`, then upload into it), so `src="images/banner.png"`, `href="style.css"` and links between the pages (`href="setup.html#install"`) keep working. The preview runs scripts in a sandbox with no access to the app's API, so pages can't fetch data from it. External `https:` images, fonts and scripts load normally. Max 5 MB per page. `pm doc write <id> --file page.html` updates an uploaded page in place.

Only create documents when the user asks for a design write-up or the information clearly outlives a single task; otherwise keep details in the task description.

## Time tracking

- Timers are per API token (token names are unique); starting a new timer stops the previous one automatically.
- Log time after the fact with `pm time log --task APP-12 --duration 45m --note "..."`.
- Epoch-level work (planning, balancing passes) can be logged with `--epoch "<name>"` instead of `--task`.
- `pm time list --epoch "<name>"` summarises time spent (`--from`/`--to` take dates, `--to` inclusive); `pm time status` shows the running timer.
- Fix mistakes with `pm time edit <entry id> --duration 30m --note "..." --date YYYY-MM-DD` (stop a running timer first) or `pm time delete <entry id>`.

## Categories, types and colours

Only change these when the user asks (they affect the whole board of this project):

```
pm category list | create --name Backend --color #f59e0b | update Backend --color #eab308 | delete Backend
pm type list | create --name Balance --color #14b8a6 | color Bug #ef4444 | delete Balance
pm column list | color "Alpha QA" #a855f7               # Kanban column colours; the columns themselves are fixed
```

## Anything else

Every API endpoint is documented in `API.md` next to this file. For something the commands above don't cover (e.g. board ordering, deleting a diagram), call it directly; `pm api` sends the token and the project for you:

```
pm api GET "/api/v1/tasks?status=alpha_qa&summary=1"
pm api POST /api/v1/tasks/APP-12/move --body-file <tmp.json>      # body: {"status": "open", "beforeId": 9}
```

In API paths, use task keys (`APP-12`): a bare number there is the task's internal id, not its number. Prefer `--body-file` over `--body` for JSON (shell quoting on Windows is fragile).

## Rules

- Never delete tasks, epochs, folders, files, time entries, categories, types or projects unless the user explicitly asks.
- Never invent task keys — always read them from command output.
- If the server is unreachable, continue the coding work, tell the user tracking failed, and list the `pm` commands they (or you, later) should run to catch up.
- Use `--json` when you need to parse output programmatically.

<!-- Part of Project Manager. Copyright (c) 2026 Bettafish Games, LLC. MIT License. -->
