# Project Manager

A self-hosted project tracker that runs on your own computer or home server. You use it from a phone or desktop browser, and **your AI coding agent uses it too** (Claude Code, or agents that read `AGENTS.md` such as Codex, Cursor and Copilot): it creates and updates tasks, tracks its time and keeps an architecture diagram in sync while it codes. Your data stays in one folder on your machine, and nothing is sent anywhere else.

- **Projects**: as many as you like, each with its own task keys (`APP-12`, `WEB-3`), board, epochs, files, diagram, task types and categories. Each account only ever sees its own projects.
- **Kanban board**: Open → In Progress → Alpha QA → Alpha Complete → Beta In Progress → Beta QA → Beta Complete → Ready to Ship. Drag and drop on desktop; on phones, one column at a time with ◀ / Move to… / ▶ buttons.
- **Tasks**: title, type, status, priority, categories, markdown description, checklist, estimate, links between tasks (blocks / blocked by / duplicates / relates to) and an activity log of who moved what, Claude included.
- **Filters**: search (text or a key like `APP-12`), status, type, category, priority, epoch, folder, creator. They live in the URL, so filtered views can be bookmarked.
- **Epochs**: containers for tasks (a release, a milestone, a feature area), with progress bars, target dates, estimates and their own board.
- **Explorer**: a folder tree holding folders, epochs, tasks and uploaded files. Drag and drop, or ⋯ → Move to on phones.
  - **Markdown documents** can be created and edited in the browser, and they autosave.
  - **HTML pages and SVGs** show a live preview (Preview/Source tabs, "Open full page"). Upload a page's images, stylesheets and other pages in the same folder layout as on disk, and they load and link to each other. Scripts run sandboxed, with no access to your login or the API.
- **Images in markdown**: drag, paste, or use 🖼 Add image (camera or gallery on phones) in any markdown field. Images are stored with your files and shown inline.
- **Time tracking**: start/stop timers or manual entries on tasks and epochs. Epoch totals include their tasks, and a Time page shows totals by day and by task.
- **Architecture diagram**: boxes and arrows colour-coded by layer, linked to tasks and epochs. Editable in the browser and through the API.
  - **Automatic layout** with right-angled arrows, top to bottom or left to right, so a diagram with hundreds of boxes stays readable. Or switch a diagram to manual and place and size the boxes yourself.
  - **Groups**: boxes can sit inside other boxes (a system and its classes). Close a group and its arrows are added up ("uses ×42"); hide whole layers.
  - Each box can show its file path, a one-line role, and a size that follows how big the code is. Agents can rebuild the whole diagram in one import.
- **Colour coding**: each Kanban column, task type, category, epoch and project has its own colour, editable in Settings.
- **Live sync**: every change is saved immediately and shows up on every open device.
- **Backups**: a snapshot every 4 hours (skipped if nothing changed), keeping 7 days.

## Requirements

- **Node.js 24 or newer**. Windows: `winget install OpenJS.NodeJS.LTS`. macOS: `brew install node` or the installer from [nodejs.org](https://nodejs.org). Linux: [nodejs.org](https://nodejs.org) or your distribution's package (check `node --version`).
- Windows, macOS or Linux. The optional Windows service scripts use PowerShell; on macOS and Linux you run `npm start` or use the examples under [Keep it running](#keep-it-running).

## Setup

Clone this repository (or download it as a ZIP and unpack it), open a terminal in its folder and run:

```bash
npm run setup
```

Setup checks Node.js, installs the packages, builds the web app and asks two questions: which **port** to use (default 8080; any free port works) and whether **other devices on your network** may connect (your phone, other PCs) or only this computer. The answers are saved in `.env`. It then creates the first account, which is an **admin**, and prints the addresses to open.

You can re-run setup at any time, for example to change the port or after updating.

Then start the server:

- **Windows**: in an **Administrator** PowerShell, install it as a service that starts with Windows, then allow devices on your local network through the firewall:
  ```powershell
  .\scripts\install-service.ps1
  .\scripts\open-firewall.ps1
  ```
  If you change the port later, run both scripts again.
- **macOS / Linux**: `npm start`. To keep it running in the background, see [Keep it running](#keep-it-running). If you allowed network access and your computer has a firewall, let the port in: macOS asks whether `node` may accept incoming connections; with ufw on Linux, run `sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp` (use your own network and port).

Open `http://localhost:8080` on the server itself, or `http://<server address>:8080` from your phone or another computer (setup prints the address). Sign in, and the app asks you to create your first project.

**Phone tip:** in your browser's menu, choose **Add to Home screen**. The app then opens full-screen like a native app.

## Projects and accounts

- **Projects**: switch between them from the sidebar (desktop) or the **More** tab (phone), and manage them in **Settings → Projects**: name, colour, key, delete. A project's **key** is the prefix of its task keys. You can change it later, and every task key in the project changes with it (`APP-12` becomes `WEB-12`). A new project can copy the task types, categories and column colours of an existing one.
- **Accounts**: the first account is an admin. Admins add accounts in **Settings → Users** (or `npm run user -- add <name>` on the server) and see the backups. Everyone else only sees their own projects: projects are private to their owner, admins included. If friends share your server, give each one their own account.

## Connect your coding agent

The integration is a **skill** (instructions in the open Agent Skills format) plus a small CLI (`pm`). It works with Claude Code and with agents that read `AGENTS.md`, such as OpenAI Codex, Cursor and GitHub Copilot. You install it into each code project (repository) you want tracked. Your agent then reads and writes tasks as you work: ask for a feature and it finds or creates the task, moves it to **In Progress**, starts a timer, adds notes, and moves it to **Alpha QA** with a list of the tests it ran. It never moves a task past Alpha QA unless you say so.

It works both ways. Jot an idea on your phone, photos included, then tell your agent *"work on APP-14"* or *"look at my new ideas"*. It reads the task and its images, fills in the details and builds it.

**1. Create an API token.** In the web app, go to **Settings → API tokens** and create one per computer, e.g. `claude-desktop` and `claude-laptop`. Each token keeps its own timer and shows up under its own name in activity logs. The token is shown only once, so copy it straight away. It acts as you, in any of your projects.

**2. Run the installer** from the top folder of your code project (where you open your editor or start your agent). It asks which agent you use, asks for the token without showing it, lets you pick one of your projects or create a new one, and checks every step.

On the computer running the Project Manager:

```bash
node /path/to/project_manager/scripts/install-agent.mjs
```

On any other computer (it downloads the installer from your server; only needs Node.js 18 or newer). Replace `SERVER:8080` with your server's address and port.

macOS / Linux:

```bash
curl -fsSL http://SERVER:8080/integration/install.mjs -o /tmp/pm-install.mjs && node /tmp/pm-install.mjs
```

Windows (PowerShell):

```powershell
irm http://SERVER:8080/integration/install.mjs -OutFile $env:TEMP\pm-install.mjs; node $env:TEMP\pm-install.mjs
```

The installer:

- puts the skill (`SKILL.md`), the `pm` CLI and the API reference where your agent looks, and adds a **Project tracking** section to its instruction file (creating the file if needed):

  | Agent | Skill folder | Instruction file |
  |---|---|---|
  | Claude Code | `.claude/skills/project-tracker/` | `CLAUDE.md`, or `.claude/CLAUDE.md` if that's where your project keeps its instructions |
  | Agents that read `AGENTS.md` (Codex, Cursor, Copilot and others) | `.agents/skills/project-tracker/` | `AGENTS.md` |
  | Both | `.claude/skills/project-tracker/` | `CLAUDE.md` and `AGENTS.md` |

- writes `.pm.json` with the server address, your token and the project, and adds it to `.gitignore` (it holds your token: never commit it)
- finishes with a connection test

Re-run it after updating the Project Manager to refresh the skill files; it keeps your token and project. Switching agents later is a re-run too: pick the new agent, or **Both** while you try it out. The installer never deletes anything, so remove the old agent's folder and section yourself once you're done with it. If your agent reads a different instruction file, add a line telling it to follow the skill's `SKILL.md`.

Options: `--agent claude|agents|both`, `--project KEY`, `--epoch "Version 1.0"` (default epoch for new work), `--url http://SERVER:PORT`, `--dir <folder>`, `--new-token`, `--yes`. The token can also come from the `PM_TOKEN` environment variable.

**3. Start a new chat with your agent** in that folder so it picks up the skill (in VS Code, reload the window). Claude Code asks for permission the first time it runs a `pm` command. To allow all tracker calls up front, add this to the repo's `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(node .claude/skills/project-tracker/pm.mjs:*)"] } }
```

### CLI quick reference

`pm` is short for `node .claude/skills/project-tracker/pm.mjs` (`.agents/skills/...` for other agents). A bare task number means that task in the repo's project.

```
pm whoami                                   # server, account and project
pm project list   /   pm project use WEB
pm task create --title "Add CSV export" --type Feature --category Backend --epoch "Version 1.0" --estimate 1h
pm task advance APP-5 --note "starting"
pm task status APP-5 "Alpha QA" --note "12 tests pass"
pm task link APP-5 blocked by APP-3
pm time start --task APP-5   /   pm time stop   /   pm time log --task APP-5 --duration 45m
pm diagram add-node --label AuthService --layer services --parent Backend   /   pm diagram connect AuthService Database
pm diagram import diagram.json --yes        # many boxes and arrows in one save
pm help
```

The REST API is documented in [docs/API.md](docs/API.md).

## Using it away from home

The server speaks plain HTTP and is meant for your own network. **Don't forward its port on your router**, not even on an unusual port. To reach it from a laptop or phone while travelling, use a VPN that ends on the server: [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md) walks through WireGuard and Tailscale, set up so that only this app is reachable rather than your whole network.

## Keep it running

**Windows**: `install-service.ps1` (above) runs it as the `ProjectManager` service. Its log is `data\logs\service.log`.

**Linux (systemd)**: save this as `/etc/systemd/system/project-manager.service`, replacing the user, folder and Node path (`which node`):

```ini
[Unit]
Description=Project Manager
After=network-online.target
Wants=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/project_manager
ExecStart=/usr/bin/node server/index.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable --now project-manager`. View the log with `journalctl -u project-manager`.

**macOS (launchd)**: save this as `~/Library/LaunchAgents/local.project-manager.plist`, replacing the folder and Node path (`which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.project-manager</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/node</string><string>server/index.ts</string></array>
  <key>WorkingDirectory</key><string>/Users/you/project_manager</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/project_manager/data/server.log</string>
  <key>StandardErrorPath</key><string>/Users/you/project_manager/data/server.log</string>
</dict>
</plist>
```

Then run `launchctl load ~/Library/LaunchAgents/local.project-manager.plist`. It starts whenever you log in.

## Operations

| Task | How |
|---|---|
| Add an account / reset a password | Settings → Users (admins), or on the server: `npm run user -- add <name> [--admin]` · `npm run user -- passwd <name>` · `npm run user -- list` |
| Back up now | Settings → Backups (admins), or `npm run backup` on the server |
| Restore a backup | Stop the server. Copy `data/backups/pm-YYYYMMDD-HHMMSS.db` over `data/pm.db` and delete `data/pm.db-wal` and `data/pm.db-shm` if present. Copy any missing files from `data/backups/files/` to `data/files/`. Start the server. |
| Update to a new version | Stop the server, run `git pull` and `npm run setup -- --yes` (keeps your settings), then start the server again |
| Start / stop the server | Windows (Administrator): `Start-Service ProjectManager` · `Stop-Service ProjectManager` · `Restart-Service ProjectManager`. Linux: `sudo systemctl start\|stop\|restart project-manager`. macOS: `launchctl load` / `launchctl unload` with the plist path. |
| Change the port or network access | `npm run setup` again, then restart. On Windows, re-run `install-service.ps1` and `open-firewall.ps1`. |
| Remove the Windows service | `.\scripts\uninstall-service.ps1` (your data is kept) |

Everything lives in `data/`: `pm.db` (SQLite), `files/` (uploads), `backups/`, and `logs/` for the Windows service. Copying that folder backs up everything.

### Settings

`npm run setup` writes these to `.env` in the project folder; you can also edit it by hand (restart afterwards). Environment variables override `.env`.

| Setting | Default | Meaning |
|---|---|---|
| `PM_PORT` | `8080` | Port the server listens on |
| `PM_HOST` | `0.0.0.0` | `0.0.0.0` lets other devices connect; `127.0.0.1` allows only this computer |
| `PM_DATA_DIR` | `./data` | Database, uploads, backups and logs |
| `PM_BACKUP_HOURS` | `4` | Hours between automatic backups (`0` turns them off) |
| `PM_BACKUP_KEEP` | `42` | Backups kept (42 × 4 h = 7 days) |
| `PM_MAX_UPLOAD_MB` | `200` | Largest upload |
| `PM_WEB_DIST` | `./web/dist` | Built web app to serve |

## Development

```
npm run dev              # API server with auto-reload, on PM_PORT
npm --prefix web run dev # UI dev server on :5173 (proxies /api to PM_PORT)
npm test                 # API integration tests
npm run typecheck
```

Layout: `server/` (Fastify + node:sqlite, TypeScript run natively by Node), `web/` (React + Vite), `tools/` (CLI + agent skill), `scripts/` (setup, installers, accounts, backup, Windows service), `test/`.

## Security

This app is built for a trusted home or office network, or a VPN into it:

- There are no default accounts or passwords; setup asks you to create the first account.
- Passwords are hashed with scrypt. Sessions and API tokens are stored only as hashes; tokens can be revoked and are shown once.
- Each account can only see its own projects. Anything else answers "not found", so ids reveal nothing about other people's data.
- Logins are throttled after repeated failures (10 per 15 minutes per address).
- Cookie-authenticated writes require a custom header, which blocks cross-site request forgery.
- Uploaded files are never served as runnable HTML on the app's own origin. HTML previews run in a sandbox with no access to your login or the API.
- Traffic is plain HTTP, so don't expose the port to the internet: use a VPN ([docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md)). On Windows, the firewall script only allows your local subnet.
- `.env`, `data/` and `.pm.json` are git-ignored, so your database, uploads and tokens stay out of the repository.

## License

Free and open source under the [MIT License](LICENSE). You can use, copy, change, share or sell it, as long as copies keep the copyright notice (Bettafish Games, LLC) and the license text. The libraries it uses keep their own licenses; the diagram layout engine, [elkjs](https://github.com/kieler/elkjs), is under the Eclipse Public License 2.0 and is used unchanged.
