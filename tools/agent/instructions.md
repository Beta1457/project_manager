## Project tracking

This project's tasks are tracked in the Project Manager. Follow the project-tracker skill in `.claude/skills/project-tracker/SKILL.md` (its `pm` tool runs as `node .claude/skills/project-tracker/pm.mjs`) for every feature, content addition, bug fix or refactor: find or create the task first, move it to In Progress when you start, and to Alpha QA (with a note listing the tests run) when the implementation is done and tests pass. Do not move tasks past Alpha QA unless I say so.

- Default epoch for new work: **<EPOCH NAME>** (ask me if a request clearly belongs elsewhere)
- Categories: use the project's existing categories (`pm meta` lists them) and don't invent new ones without asking.
- Keep the architecture diagram in sync when adding or connecting major systems.
