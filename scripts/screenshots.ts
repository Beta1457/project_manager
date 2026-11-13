/**
 * Takes the README screenshots (docs/images/*.png) from demo data, never from yours: it builds the web app
 * into a temporary folder, fills a temporary data folder with scripts/demo-seed.ts, starts a server on a
 * free local port and drives a headless Edge, Chrome or Chromium through the DevTools protocol. It needs
 * nothing beyond the project's own packages and one of those browsers.
 *
 *   node scripts/screenshots.ts [--only board,task] [--out <folder>] [--browser <path>] [--keep]
 *
 * --browser (or PM_BROWSER) names the browser when it isn't found on its own. --keep leaves the temporary
 * folder (build, data and browser profile) in place and says where it is.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

type Json = Record<string, any>;

const ROOT = path.resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    out: { type: 'string' },
    browser: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  throw new Error(message);
}

// ---- Processes -------------------------------------------------------------

/** Runs a command to the end. Its output is shown only if it fails. */
function run(what: string, command: string, argv: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed (exit code ${code}):\n${output.trim()}`))));
  });
}

/** Waits up to `ms` for a process to end; true if it did. */
function ended(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function findBrowser(): string {
  const chosen = args.browser ?? process.env.PM_BROWSER;
  if (chosen) {
    if (!fs.existsSync(chosen)) fail(`No browser at ${chosen}`);
    return chosen;
  }
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]
          .filter((dir): dir is string => !!dir)
          .flatMap((dir) => [
            path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(dir, 'Chromium', 'Application', 'chrome.exe'),
          ])
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : (env.PATH ?? '')
            .split(path.delimiter)
            .filter(Boolean)
            .flatMap((dir) =>
              ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'].map((name) =>
                path.join(dir, name),
              ),
            );
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) fail('No Edge, Chrome or Chromium found. Name one with --browser <path> (or PM_BROWSER).');
  return found;
}

// ---- DevTools protocol -------------------------------------------------------

/** Just enough of the Chrome DevTools protocol: commands, and waiting for an event. */
class DevTools {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { method: string; resolve: (result: Json) => void; reject: (err: Error) => void }>();
  private waiting: Array<{ method: string; sessionId?: string; resolve: (params: Json) => void }> = [];
  private listeners: Array<{ method: string; handler: (params: Json, sessionId?: string) => void }> = [];
  /** Settles when the connection ends, as it does when the browser quits. */
  readonly closed: Promise<void>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e) => this.receive(JSON.parse(String(e.data)) as Json));
    this.closed = new Promise((resolve) =>
      ws.addEventListener('close', () => {
        for (const p of this.pending.values()) p.reject(new Error(`The browser went away during ${p.method}`));
        this.pending.clear();
        resolve();
      }),
    );
  }

  static connect(url: string): Promise<DevTools> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new DevTools(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Could not connect to the browser at ${url}`)), { once: true });
    });
  }

  send(method: string, params: Json = {}, sessionId?: string, timeoutMs = 30_000): Promise<Json> {
    const id = this.nextId++;
    const done = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No answer to ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      const settle = <T>(fn: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
    });
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return done;
  }

  /** Calls `handler` for every `method` event. */
  on(method: string, handler: (params: Json, sessionId?: string) => void): void {
    this.listeners.push({ method, handler });
  }

  /** The next `method` event, from the tab `sessionId` if given. */
  next(method: string, sessionId?: string, timeoutMs = 30_000): Promise<Json> {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        sessionId,
        resolve: (params: Json) => {
          clearTimeout(timer);
          resolve(params);
        },
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.waiting.push(waiter);
    });
  }

  close(): void {
    this.ws.close();
  }

  private receive(msg: Json): void {
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    } else if (typeof msg.method === 'string') {
      for (const l of this.listeners) if (l.method === msg.method) l.handler(msg.params ?? {}, msg.sessionId);
      const w = this.waiting.find((x) => x.method === msg.method && (!x.sessionId || x.sessionId === msg.sessionId));
      if (w) {
        this.waiting = this.waiting.filter((x) => x !== w);
        w.resolve(msg.params ?? {});
      }
    }
  }
}

/** One browser tab. */
class Tab {
  private devtools: DevTools;
  private session: string;

  constructor(devtools: DevTools, session: string) {
    this.devtools = devtools;
    this.session = session;
  }

  send(method: string, params: Json = {}): Promise<Json> {
    return this.devtools.send(method, params, this.session);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** Waits until `expression` is true in the page. */
  async waitFor(expression: string, what: string, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!(await this.evaluate<boolean>(`Boolean(${expression})`))) {
      if (Date.now() > until) fail(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  /** Lets fonts, images, layout and a couple of frames finish before a picture is taken. */
  async settle(ms = 300): Promise<void> {
    await this.evaluate(`(() => {
      const images = [...document.images].filter((img) => !img.complete).map((img) => new Promise((done) => {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }));
      return Promise.all([document.fonts.ready, ...images])
        .then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))));
    })()`);
    await sleep(ms);
  }

  async open(url: string): Promise<void> {
    const loaded = this.devtools.next('Page.loadEventFired', this.session);
    loaded.catch(() => {}); // awaited below; this only keeps a failed navigation from leaving it unhandled
    const res = await this.send('Page.navigate', { url });
    if (res.errorText) fail(`Could not open ${url}: ${res.errorText}`);
    await loaded;
  }

  async size(width: number, height: number, mobile: boolean): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }

  /** The middle of the first element matching `selector`, scrolled into view if it isn't. */
  async middle(selector: string): Promise<{ x: number; y: number }> {
    const point = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!point) fail(`Nothing in the page matches ${selector}`);
    return point;
  }

  /** Clicks a button from script, wherever it is: for controls inside the diagram, which scrolling would upset. */
  async press(selector: string): Promise<void> {
    const found = await this.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el?.click();
      return !!el;
    })()`);
    if (!found) fail(`Nothing in the page matches ${selector}`);
  }

  /** A real mouse click (or right-click), as a person makes it. */
  async click(selector: string, button: 'left' | 'right' = 'left'): Promise<void> {
    const { x, y } = await this.middle(selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  }

  async hover(selector: string): Promise<void> {
    const { x, y } = await this.middle(selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  /** Turns the mouse wheel at a point, in pixels like a trackpad (a negative deltaY scrolls up). */
  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }

  /** Types into whatever has the focus. */
  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async capture(file: string): Promise<number> {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(data as string, 'base64');
    fs.writeFileSync(file, bytes);
    return bytes.length;
  }
}

// ---- The screenshots ---------------------------------------------------------

interface Demo {
  /** The task with the most sub-tasks. */
  parentKey: string;
  /** The diagram of systems with classes inside. */
  diagram: number;
  /** Explorer rows to show opened: `folder-<id>` / `epoch-<id>`. */
  expanded: string[];
}

interface Shot {
  name: string;
  width: number;
  height: number;
  mobile?: boolean;
  take: (tab: Tab, base: string, demo: Demo) => Promise<void>;
}

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, mobile: true };

const boardShown = (tab: Tab) => tab.waitFor("document.querySelectorAll('.task-card').length > 5", 'the board');
const diagramShown = (tab: Tab) =>
  tab.waitFor("document.querySelectorAll('.react-flow__node').length > 0 && !document.querySelector('.diagram-busy')", 'the diagram', 60_000);
/** Leaves edit mode, which a wide screen starts in, so the boxes show no connection dots. */
const viewOnly = (tab: Tab) =>
  tab.evaluate(`(() => {
    const edit = [...document.querySelectorAll('.diagram-bar label')].find((l) => l.textContent.trim() === 'Edit')?.querySelector('input');
    if (edit?.checked) edit.click();
  })()`);

/**
 * Zooms in on the top left of a group to its boxes' full size, the way the mouse wheel does: a zoom by k around
 * the pointer p moves a point q to p + k(q - p), so p is picked to bring the group's corner near the pane's.
 */
async function zoomToGroup(tab: Tab, label: string): Promise<void> {
  const at = await tab.evaluate<{ x: number; y: number; deltaY: number } | null>(`(() => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const group = [...document.querySelectorAll('.dgroup')].find((g) => g.querySelector('.dgroup-label')?.textContent === ${JSON.stringify(label)});
    const zoom = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a;
    if (!group || zoom > 0.9) return null;
    const corner = group.getBoundingClientRect();
    const k = 1 / zoom;
    const x = (k * corner.left - (pane.left + 24)) / (k - 1);
    const y = (k * corner.top - (pane.top + 16)) / (k - 1);
    if (x < pane.left || x > pane.right || y < pane.top || y > pane.bottom) return null;
    // React Flow zooms by 2 ** (-deltaY / 500) for a wheel step measured in pixels.
    return { x, y, deltaY: -500 * Math.log2(k) };
  })()`);
  if (!at) return console.warn(`  (Left the zoom as it was: "${label}" isn't shown small enough to zoom in on.)`);
  await tab.wheel(at.x, at.y, at.deltaY);
  await sleep(300);
}

const SHOTS: Shot[] = [
  {
    name: 'board',
    ...DESKTOP,
    take: async (tab, base) => {
      await tab.open(`${base}/`);
      await boardShown(tab);
    },
  },
  {
    name: 'task',
    ...DESKTOP,
    take: async (tab, base, demo) => {
      await tab.open(`${base}/?task=${demo.parentKey}`);
      await boardShown(tab);
      await tab.waitFor(
        "[...document.querySelectorAll('[role=dialog] .section-title')].some((el) => el.textContent.startsWith('Sub-tasks ('))",
        'the task and its sub-tasks',
      );
    },
  },
  {
    // Every system folded up, with the arrows between them counted.
    name: 'diagram-overview',
    ...DESKTOP,
    take: async (tab, base, demo) => {
      await tab.open(`${base}/diagram?d=${demo.diagram}`);
      await diagramShown(tab);
      await viewOnly(tab);
    },
  },
  {
    name: 'diagram-detail',
    ...DESKTOP,
    take: async (tab, base, demo) => {
      await tab.open(`${base}/diagram?d=${demo.diagram}`);
      await diagramShown(tab);
      await viewOnly(tab);
      // Open one system (the app zooms to fit it), then get close enough to read its boxes.
      await tab.press('.dbox-open[aria-label^="Open Combat ("]');
      await sleep(200);
      await diagramShown(tab);
      await sleep(600);
      await zoomToGroup(tab, 'Combat');
    },
  },
  {
    name: 'explorer-menu',
    ...DESKTOP,
    take: async (tab, base, demo) => {
      await tab.open(`${base}/`);
      await tab.evaluate(`localStorage.setItem('pm.explorer.expanded', ${JSON.stringify(JSON.stringify(demo.expanded))})`);
      await tab.open(`${base}/explorer`);
      await tab.waitFor("document.querySelectorAll('.tree-row').length > 5", 'the folder tree');
      await tab.click('[data-row^="folder-"] .name', 'right');
      await tab.waitFor("document.querySelector('.ctx-menu')", 'the right-click menu');
      await tab.hover('.ctx-menu .ctx-sub > .ctx-item');
      await tab.waitFor("document.querySelectorAll('.ctx-menu').length > 1", 'the New submenu');
    },
  },
  {
    name: 'template',
    ...DESKTOP,
    take: async (tab, base) => {
      await tab.open(`${base}/`);
      await boardShown(tab);
      await tab.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ New task').click()");
      await tab.waitFor("document.querySelector('[role=dialog] select')", 'the New task dialog');
      await tab.evaluate(`(() => {
        const select = document.querySelector('[role=dialog] select');
        select.value = [...select.options].find((o) => o.textContent === 'Boss fight').value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await tab.waitFor("document.querySelector('.template-summary')", 'the template summary');
      await tab.evaluate("document.querySelector('[role=dialog] input[aria-label=Title]').focus()");
      await tab.type('Fire Drake');
    },
  },
  {
    name: 'phone-board',
    ...PHONE,
    take: async (tab, base) => {
      await tab.open(`${base}/`);
      await boardShown(tab);
    },
  },
];

// ---- Main ----------------------------------------------------------------------

async function main(): Promise<void> {
  const only = args.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = only?.filter((name) => !SHOTS.some((s) => s.name === name)) ?? [];
  if (unknown.length) fail(`Unknown screenshot ${unknown.join(', ')}. There are: ${SHOTS.map((s) => s.name).join(', ')}`);
  const shots = only ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  const outDir = path.resolve(ROOT, args.out ?? path.join('docs', 'images'));
  const vite = path.join(ROOT, 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) fail('The web app\'s packages are missing: run "npm run setup" (or "npm --prefix web install") first.');
  const browserPath = findBrowser();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-screenshots-'));
  const dist = path.join(tmp, 'dist');
  const dataDir = path.join(tmp, 'data');
  const profile = path.join(tmp, 'browser');
  // Only for this throwaway demo account, which lives in the temporary folder.
  const password = crypto.randomBytes(18).toString('base64url');

  // What has to be stopped and removed at the end, however the run ends (Ctrl+C included).
  let server: ChildProcess | undefined;
  let launcher: ChildProcess | undefined;
  let browserPid: number | undefined;
  let devtools: DevTools | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (devtools) {
        await Promise.race([devtools.send('Browser.close').catch(() => {}), sleep(3000)]);
        await Promise.race([devtools.closed, sleep(5000)]);
        devtools.close(); // in case the browser didn't, so the connection doesn't keep this script running
      }
      // The process started may have handed over to another one, so the browser is stopped by its own id.
      if (browserPid !== undefined && isRunning(browserPid)) process.kill(browserPid);
      if (launcher && !(await ended(launcher, 1000))) launcher.kill();
      if (server) {
        server.kill();
        await ended(server, 5000);
      }
      if (args.keep) {
        console.log(`Kept the temporary folder: ${tmp}`);
        return;
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (err) {
        console.warn(`Couldn't remove the temporary folder ${tmp} (${(err as NodeJS.ErrnoException).code}); delete it by hand.`);
      }
    })());
  const onInterrupt = () => {
    console.log('\nStopping…');
    void stop().finally(() => process.exit(130));
  };
  process.once('SIGINT', onInterrupt);

  try {
    console.log('Building the web app…');
    await run('Building the web app', process.execPath, [vite, 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: path.join(ROOT, 'web'),
    });

    console.log('Filling a demo data folder…');
    await run('The demo seed', process.execPath, [path.join(ROOT, 'scripts', 'demo-seed.ts')], {
      cwd: ROOT,
      env: { ...process.env, PM_DATA_DIR: dataDir, PM_PASSWORD: password },
    });

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let serverLog = '';
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, PM_PORT: String(port), PM_HOST: '127.0.0.1', PM_DATA_DIR: dataDir, PM_WEB_DIST: dist, PM_BACKUP_HOURS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', (chunk) => (serverLog += chunk));
    server.stderr!.on('data', (chunk) => (serverLog += chunk));
    const serverDeadline = Date.now() + 30_000;
    while (!(await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) {
      if (server.exitCode !== null) fail(`The server stopped:\n${serverLog.trim()}`);
      if (Date.now() > serverDeadline) fail(`The server didn't start:\n${serverLog.trim()}`);
      await sleep(200);
    }

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password, remember: true }),
    });
    if (!login.ok) fail(`Signing in to the demo failed (HTTP ${login.status})`);
    const pair = login.headers.getSetCookie()[0]?.split(';')[0] ?? fail('Signing in gave no cookie');
    const cut = pair.indexOf('=');
    const cookie = { name: pair.slice(0, cut), value: pair.slice(cut + 1) };
    const get = async (url: string): Promise<Json> => {
      const res = await fetch(`${base}${url}`, { headers: { cookie: pair } });
      if (!res.ok) fail(`GET ${url} failed (HTTP ${res.status})`);
      return (await res.json()) as Json;
    };

    const tasks = (await get('/api/v1/tasks?summary=1')).tasks as Json[];
    const diagrams = (await get('/api/v1/diagrams')).diagrams as Json[];
    const tree = await get('/api/v1/tree');
    const diagramId = (name: string): number => diagrams.find((d) => d.name === name)?.id ?? fail(`The demo has no diagram "${name}"`);
    const folderId = (name: string): number => tree.folders.find((f: Json) => f.name === name)?.id ?? fail(`The demo has no folder "${name}"`);
    const demo: Demo = {
      parentKey: [...tasks].sort((a, b) => b.subtasks.total - a.subtasks.total)[0].key,
      diagram: diagramId('Engine systems (nested)'),
      expanded: [`folder-${folderId('Design')}`, `folder-${folderId('Production')}`],
    };

    console.log(`Opening ${path.basename(browserPath)}…`);
    launcher = spawn(
      browserPath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--hide-scrollbars',
        '--mute-audio',
        '--force-color-profile=srgb',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    // With port 0 the browser picks a free port and writes it, and its address, to this file. The process
    // started may hand over to another one and end (Edge on Windows does): the file is what counts.
    const portFile = path.join(profile, 'DevToolsActivePort');
    const browserDeadline = Date.now() + 30_000;
    let endpoint = '';
    while (!endpoint) {
      if (launcher.exitCode) fail(`The browser stopped (exit code ${launcher.exitCode})`);
      const [devPort, devPath] = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n').map((s) => s.trim()) : [];
      if (devPort && devPath) endpoint = `ws://127.0.0.1:${devPort}${devPath}`;
      else if (Date.now() > browserDeadline) fail('The browser did not open its DevTools port');
      else await sleep(100);
    }

    devtools = await DevTools.connect(endpoint);
    const processes = (await devtools.send('SystemInfo.getProcessInfo').catch(() => ({}) as Json)).processInfo as Json[] | undefined;
    browserPid = processes?.find((p) => p.type === 'browser')?.id;
    // A dialog would stop the run: say what it was, then let the page go on (or be left).
    devtools.on('Page.javascriptDialogOpening', (params, session) => {
      console.warn(`  The page showed a ${params.type} dialog${params.message ? `: ${params.message}` : ''}`);
      void devtools?.send('Page.handleJavaScriptDialog', { accept: params.type === 'beforeunload' }, session).catch(() => {});
    });
    const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(devtools, sessionId as string);
    await tab.send('Page.enable');
    await tab.send('Network.enable');
    await tab.send('Network.setCookie', { name: cookie.name, value: cookie.value, url: base, httpOnly: true, sameSite: 'Lax' });
    await tab.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });

    fs.mkdirSync(outDir, { recursive: true });
    let total = 0;
    for (const shot of shots) {
      await tab.size(shot.width, shot.height, shot.mobile ?? false);
      await shot.take(tab, base, demo);
      await tab.settle();
      const file = path.join(outDir, `${shot.name}.png`);
      const bytes = await tab.capture(file);
      total += bytes;
      console.log(`  ${path.relative(ROOT, file)}  ${Math.round(bytes / 1024)} KB`);
    }
    console.log(`${shots.length} screenshot${shots.length === 1 ? '' : 's'}, ${Math.round(total / 1024)} KB in all.`);
  } finally {
    process.off('SIGINT', onInterrupt);
    await stop();
  }
}

main().catch((err: unknown) => {
  console.error(`screenshots: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
