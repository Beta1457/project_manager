#!/usr/bin/env node
// Connects one of your code projects to the Project Manager for your coding agent: Claude Code, or any agent
// that reads AGENTS.md (OpenAI Codex, Cursor, GitHub Copilot and others). Runs on the server or on any other
// computer (Windows, macOS or Linux) and needs only Node.js 18+.
//
// On the server, from your code project's folder:
//   node /path/to/project_manager/scripts/install-agent.mjs
// On another computer, from your code project's folder (it downloads this script from your server):
//   macOS/Linux:  curl -fsSL http://SERVER:8080/integration/install.mjs -o /tmp/pm-install.mjs && node /tmp/pm-install.mjs
//   Windows:      irm http://SERVER:8080/integration/install.mjs -OutFile $env:TEMP\pm-install.mjs; node $env:TEMP\pm-install.mjs
//
// It asks for anything it needs and checks every step:
//   - the server answers and your API token works (Settings > API tokens in the web app)
//   - which of your projects this code project tracks (or creates a new one)
//   - which coding agent will use it, and puts the project-tracker skill (SKILL.md, the pm tool, API.md) where
//     that agent looks:
//       Claude Code    .claude/skills/project-tracker, plus a "Project tracking" section in CLAUDE.md
//                      (in .claude/CLAUDE.md instead, when that's where the project keeps its instructions)
//       other agents   .agents/skills/project-tracker (the shared Agent Skills folder), plus a section in AGENTS.md
//       both           .claude/skills/project-tracker, plus sections in CLAUDE.md and AGENTS.md
//   - writes <project>/.pm.json (server, token, project) and git-ignores it
//   - tests the connection with the pm tool
// Re-run it any time to update the skill files or to add another agent; the saved token and project are kept.
//
// Options: --url <server>  --dir <folder>  --project <KEY>  --agent claude|agents|both  --new-token
//          --epoch <name>  --yes (no questions)
// The token can also come from the PM_TOKEN environment variable (keeps it out of your shell history).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// Filled in by the server when this file is downloaded from /integration/install.mjs.
const SERVED_FROM = '%%PM_SERVER_URL%%';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const interactive = Boolean(process.stdin.isTTY) && !flag('yes');
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const step = (s) => console.log(`\n${paint(36, `== ${s}`)}`);
const ok = (s) => console.log(paint(32, `   OK: ${s}`));
const say = (s) => console.log(`   ${s}`);
function stop(s) {
  console.error(`\n${paint(31, `STOPPED: ${s}`)}`);
  console.error('Nothing else was changed. Fix that, then run the installer again.');
  process.exit(1);
}

async function ask(question, fallback = '') {
  if (!interactive) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`   ${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

/** Reads a line without showing it (for the API token). */
function askHidden(question) {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    process.stdout.write(`   ${question}: `);
    let value = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(), resolve(value);
        if (ch === '\u0003') return done(), reject(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** GET/POST to the server; returns parsed JSON or throws with the server's message. */
async function api(base, method, url, { token, project, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (project) headers['x-pm-project'] = String(project);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

function suggestKey(name) {
  const words = name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 4);
  return key.replace(/^[0-9]+/, '').slice(0, 10);
}

/** Where each choice puts the skill (paths relative to the code project) and which instruction files get a section. */
const AGENTS = {
  claude: { label: 'Claude Code', skill: '.claude/skills/project-tracker', instructions: ['CLAUDE.md'] },
  agents: { label: 'agents that read AGENTS.md', skill: '.agents/skills/project-tracker', instructions: ['AGENTS.md'] },
  both: { label: 'Claude Code and agents that read AGENTS.md', skill: '.claude/skills/project-tracker', instructions: ['CLAUDE.md', 'AGENTS.md'] },
};
const SKILL_LOCATIONS = ['.claude/skills/project-tracker', '.agents/skills/project-tracker'];
/** The skill and the instructions template name the Claude location; other installs get their own path. */
const SOURCE_SKILL_PATH = '.claude/skills/project-tracker';
const forSkillDir = (text, skill) => text.replaceAll(SOURCE_SKILL_PATH, skill);
const hasTrackingSection = (file) => fs.existsSync(file) && /^## Project tracking/m.test(fs.readFileSync(file, 'utf8'));

/**
 * The file that has (or gets) the Project tracking section. Claude Code also reads .claude/CLAUDE.md, so a project
 * that keeps its instructions there gets the section there rather than a second CLAUDE.md.
 */
function instructionFile(dir, name) {
  const candidates = name === 'CLAUDE.md' ? [path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md')] : [path.join(dir, name)];
  return candidates.find((f) => hasTrackingSection(f)) ?? candidates.find((f) => fs.existsSync(f)) ?? candidates[0];
}
/** The instruction files as this project has them, e.g. ".claude/CLAUDE.md and AGENTS.md". */
const shownInstructions = (dir, agent) =>
  agent.instructions.map((name) => path.relative(dir, instructionFile(dir, name)).split(path.sep).join('/')).join(' and ');

/** What an earlier run installed in this folder, as the default choice for this one. */
function detectAgent(dir) {
  const claude = fs.existsSync(path.join(dir, '.claude', 'skills', 'project-tracker', 'SKILL.md')) || hasTrackingSection(instructionFile(dir, 'CLAUDE.md'));
  const other = fs.existsSync(path.join(dir, '.agents', 'skills', 'project-tracker', 'SKILL.md')) || hasTrackingSection(instructionFile(dir, 'AGENTS.md'));
  return claude && other ? 'both' : other ? 'agents' : 'claude';
}

/** --agent value or menu answer -> key of AGENTS. */
function parseAgent(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['1', 'claude', 'claude-code'].includes(v)) return 'claude';
  if (['2', 'agents', 'agents.md', 'agents-md', 'other'].includes(v)) return 'agents';
  if (['3', 'both', 'all'].includes(v)) return 'both';
  return undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const runningFromRepo = fs.existsSync(path.join(repoRoot, 'tools', 'pm.mjs')) && fs.existsSync(path.join(repoRoot, 'server', 'config.ts'));

/** Where the server probably is: where this file came from, or this computer if run from the repo. */
function defaultUrl() {
  if (!SERVED_FROM.includes('%%')) return SERVED_FROM;
  let port = 8080;
  try {
    const m = /^\s*PM_PORT\s*=\s*["']?(\d+)/m.exec(fs.readFileSync(path.join(repoRoot, '.env'), 'utf8'));
    if (m) port = Number(m[1]);
  } catch {
    /* no .env: default port */
  }
  return `http://localhost:${port}`;
}

async function main() {
  console.log(paint(1, 'Project Manager: coding agent installer'));
  if (option('agent') && !parseAgent(option('agent'))) stop(`--agent must be claude, agents or both (got "${option('agent')}").`);

  // ---- 1. Node.js -------------------------------------------------------------------------------
  step('Checking Node.js (the pm tool your agent runs needs version 18 or newer)');
  if (Number(process.versions.node.split('.')[0]) < 18) {
    stop(`Node.js ${process.versions.node} is too old. Install the current LTS from https://nodejs.org and run this again.`);
  }
  ok(`Node.js ${process.versions.node}`);

  // ---- 2. Server --------------------------------------------------------------------------------
  step('Finding the Project Manager server');
  let url = option('url') ?? (await ask('Server address', defaultUrl()));
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  try {
    if ((await api(url, 'GET', '/api/health')).ok !== true) throw new Error('unexpected answer');
  } catch (err) {
    stop(
      `Can't reach the server at ${url} (${err.cause?.code ?? err.message}).\n` +
        `  - Open ${url} in a browser on this computer. If it doesn't load, this computer can't see the server.\n` +
        '  - Is the server switched on, and is this computer on the same network (or VPN)?\n' +
        '  - Different address or port? Run the installer with --url http://ADDRESS:PORT',
    );
  }
  ok(`server is up at ${url}`);

  // ---- 3. Code project folder -------------------------------------------------------------------
  step('Choosing your code project folder');
  let dir = option('dir') ?? (await ask('Folder of the code project to connect', process.cwd()));
  dir = path.resolve(dir.replace(/^["']|["']$/g, ''));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) stop(`Folder not found: ${dir}`);
  if (path.parse(dir).root === dir || dir === os.homedir()) {
    stop(`${dir} is a whole drive or your home folder. Go to your code project's folder first (cd path/to/project), or pass --dir.`);
  }
  if (process.env.windir && dir.toLowerCase().startsWith(process.env.windir.toLowerCase())) {
    stop(`That's a Windows system folder (${dir}). Go to your code project's folder first, or pass --dir.`);
  }
  if (fs.existsSync(path.join(dir, 'server', 'routes', 'integration.ts'))) {
    stop("That's the Project Manager's own folder. Run this from your CODE project's folder instead, or pass --dir.");
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    say(paint(33, `Note: ${dir} has no .git folder. Make sure it's the TOP folder of your project (the one you open in your editor).`));
    if (interactive && !/^y/i.test(await ask('Install here anyway? (y/n)', 'n'))) stop('Cancelled.');
  }
  ok(dir);

  // ---- 3b. Coding agent -------------------------------------------------------------------------
  step('Choosing your coding agent');
  let agentKey = parseAgent(option('agent'));
  if (!agentKey) {
    const detected = detectAgent(dir);
    if (!interactive) agentKey = detected;
    while (!agentKey) {
      say('1. Claude Code');
      say('2. An agent that reads AGENTS.md: OpenAI Codex, Cursor, GitHub Copilot and others');
      say('3. Both (for example while you try another agent)');
      agentKey = parseAgent(await ask('Your choice', { claude: '1', agents: '2', both: '3' }[detected]));
    }
  }
  const agent = AGENTS[agentKey];
  ok(`${agent.label}: skill in ${agent.skill}, instructions in ${shownInstructions(dir, agent)}`);

  // ---- 4. API token -----------------------------------------------------------------------------
  step('Connecting with your API token');
  const cfgPath = path.join(dir, '.pm.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    /* none yet */
  }
  let token = flag('new-token') ? undefined : (process.env.PM_TOKEN ?? saved.token);
  const reused = Boolean(token) && token === saved.token;
  if (!token) {
    if (!interactive) stop('No API token. Set the PM_TOKEN environment variable (no one is here to paste it).');
    say('Create a token in the web app: Settings > API tokens (name it after this computer, e.g. claude-laptop).');
    say('Paste it below and press Enter. Nothing appears while you paste; that is normal.');
    token = await askHidden('API token');
  }
  token = token.trim();
  if (!/^pm_[A-Za-z0-9_-]{20,}$/.test(token)) {
    stop('That does not look like an API token (they start with pm_ and are about 46 characters). Copy it again from Settings > API tokens.');
  }
  let me;
  try {
    me = await api(url, 'GET', '/api/auth/me', { token });
  } catch {
    stop('The server rejected that token (deleted or mistyped?). Create a new one in Settings > API tokens and copy it right away; it is only shown once.');
  }
  ok(`${reused ? 'the saved token works' : 'token works'}: you are ${me.user.username}, and your agent's changes show up as "${me.actor}"`);

  // ---- 5. Project -------------------------------------------------------------------------------
  step('Choosing the project this code belongs to');
  let { projects } = await api(url, 'GET', '/api/v1/projects', { token });
  const byKey = (k) => projects.find((p) => p.key.toUpperCase() === String(k).toUpperCase());
  let project = option('project') ? byKey(option('project')) : saved.project ? byKey(saved.project) : undefined;
  if (option('project') && !project) stop(`You have no project with the key ${option('project')}. Your projects: ${projects.map((p) => p.key).join(', ') || 'none'}.`);
  if (!project && projects.length === 1 && !interactive) project = projects[0];
  if (!project && !interactive) stop('Pick a project with --project KEY (no one is here to choose).');
  while (!project) {
    projects.forEach((p, i) => say(`${i + 1}. ${p.key}  ${p.name}  (${p.openTaskCount} open tasks)`));
    say(`${projects.length ? 'N' : 'You have no projects yet. N'}. Create a new project`);
    const pick = await ask('Your choice', projects.length ? '1' : 'N');
    if (/^\d+$/.test(pick) && projects[Number(pick) - 1]) {
      project = projects[Number(pick) - 1];
    } else if (/^n/i.test(pick)) {
      const name = await ask('Project name (e.g. My game)');
      if (!name) continue;
      const key = (await ask('Key: tasks are numbered KEY-1, KEY-2, ... (1-10 letters/digits)', suggestKey(name))).toUpperCase();
      try {
        project = await api(url, 'POST', '/api/v1/projects', { token, body: { name, key } });
        ({ projects } = await api(url, 'GET', '/api/v1/projects', { token }));
      } catch (err) {
        say(paint(33, `Could not create it: ${err.message}`));
      }
    }
  }
  ok(`${project.key}  ${project.name}`);

  // ---- 6. Save the settings ---------------------------------------------------------------------
  const cfg = { url, token, project: project.key };
  if (JSON.stringify(cfg) !== JSON.stringify({ url: saved.url, token: saved.token, project: saved.project })) {
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(cfgPath, 0o600); // also when the file already existed
    ok('saved to .pm.json');
  }
  const gitignore = path.join(dir, '.gitignore');
  const ignoreText = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!/^\/?\.pm\.json\s*$/m.test(ignoreText)) {
    fs.appendFileSync(gitignore, `${ignoreText && !ignoreText.endsWith('\n') ? '\n' : ''}\n# Project Manager API token\n.pm.json\n`);
    ok('.pm.json added to .gitignore (the token never gets committed)');
  }

  // ---- 7. Skill files ---------------------------------------------------------------------------
  step('Installing the project-tracker skill');
  const sources = {
    'SKILL.md': 'tools/agent/project-tracker/SKILL.md',
    'pm.mjs': 'tools/pm.mjs',
    'API.md': 'docs/API.md',
    'instructions.md': 'tools/agent/instructions.md',
  };
  const files = {};
  for (const [name, rel] of Object.entries(sources)) {
    try {
      if (runningFromRepo) files[name] = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      else {
        const res = await fetch(`${url}/integration/${name}`, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        files[name] = await res.text();
      }
    } catch (err) {
      stop(`Could not get ${name} (${err.message}).`);
    }
  }
  // The chosen location, plus any copy an earlier run left in the other one, so no stale copy stays behind.
  const skillDirs = [agent.skill, ...SKILL_LOCATIONS.filter((s) => s !== agent.skill && fs.existsSync(path.join(dir, s, 'SKILL.md')))];
  for (const skill of skillDirs) {
    const target = path.join(dir, ...skill.split('/'));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), forSkillDir(files['SKILL.md'], skill));
    fs.writeFileSync(path.join(target, 'pm.mjs'), files['pm.mjs']);
    fs.writeFileSync(path.join(target, 'API.md'), files['API.md']);
    ok(`SKILL.md, pm.mjs and API.md are in ${target} (${runningFromRepo ? 'copied from the Project Manager folder' : 'downloaded from the server'})`);
  }

  // ---- 8. Instruction files (CLAUDE.md / AGENTS.md) ---------------------------------------------
  step(`Telling your agent about it in ${shownInstructions(dir, agent)}`);
  let epochLine;
  for (const name of agent.instructions) {
    const file = instructionFile(dir, name);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (/^## Project tracking/m.test(existing)) {
      ok(`${path.relative(dir, file)} already has a Project tracking section (left as it is)`);
      continue;
    }
    if (epochLine === undefined) {
      let epoch = option('epoch') ?? '';
      if (!epoch && interactive) {
        try {
          const { epochs } = await api(url, 'GET', '/api/v1/epochs', { token, project: project.key });
          if (epochs.length) say(`Epochs in ${project.key}: ${epochs.map((e) => e.name).join(', ')}`);
        } catch {
          /* just a hint */
        }
        epoch = await ask('Default epoch for new tasks (optional: press Enter to skip; you can tell your agent later)');
      }
      epochLine = epoch
        ? `- Default epoch for new work: **${epoch}** (ask me if a request clearly belongs elsewhere)`
        : '- Default epoch for new work: not set yet; ask me which epoch to use (`pm epoch list` shows them)';
    }
    const snippet = forSkillDir(files['instructions.md'], agent.skill).replace(/^- Default epoch for new work:.*$/m, () => epochLine);
    fs.appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${snippet}`);
    ok(`added a Project tracking section to ${file}`);
  }

  // ---- 9. Test ----------------------------------------------------------------------------------
  step('Testing the pm tool your agent will use');
  const pmTool = path.join(dir, ...agent.skill.split('/'), 'pm.mjs');
  const test = spawnSync(process.execPath, [pmTool, 'whoami'], { cwd: dir, encoding: 'utf8' });
  if (test.status !== 0) stop(`The pm tool failed: ${(test.stderr || test.stdout).trim()}`);
  ok(test.stdout.trim().replace(/\r?\n/g, '\n       '));

  console.log(`\n${paint(32, 'ALL DONE.')}`);
  if (agentKey !== 'agents') {
    say('Claude Code: reopen your editor on this folder (or start a new Claude Code chat) so Claude loads the skill.');
    say('The first time Claude runs a pm command it asks for permission; choose to always allow it.');
  }
  if (agentKey !== 'claude') {
    say('Other agents: start a new chat in this folder so the agent reads AGENTS.md. If yours reads a different');
    say(`instruction file, add this line to it: Follow ${agent.skill}/SKILL.md to track all work in the Project Manager.`);
  }
  say('Then ask: "What tasks are open in the project tracker?"');
}

main().catch((err) => stop(err.message));
