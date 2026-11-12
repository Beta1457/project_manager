import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../lib/errors.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * The coding-agent integration files, served so any computer on the network can install the skill without a
 * copy of this repo (see scripts/install-agent.mjs). Fixed allowlist: no path from the request is ever used
 * to build a file path. None of these files contain secrets, so they need no login.
 */
const FILES: Record<string, string> = {
  'install.mjs': 'scripts/install-agent.mjs',
  'SKILL.md': 'tools/agent/project-tracker/SKILL.md',
  'pm.mjs': 'tools/pm.mjs',
  'API.md': 'docs/API.md',
  'instructions.md': 'tools/agent/instructions.md',
};

/** A Host header that is just a host name or IP address and an optional port (nothing to inject). */
const PLAIN_HOST = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const URL_PLACEHOLDER = "'%%PM_SERVER_URL%%'";

export function registerIntegrationRoutes(app: FastifyInstance): void {
  app.get<{ Params: { file: string } }>('/integration/:file', async (req, reply) => {
    const name = req.params.file;
    const rel = Object.hasOwn(FILES, name) ? FILES[name] : undefined;
    if (!rel) throw notFound(`Integration file "${name}"`);
    let body: string | Buffer = await fs.readFile(path.join(repoRoot, rel));
    // The installer defaults to the address it was downloaded from, so nobody has to type it.
    const host = req.headers.host;
    if (name === 'install.mjs' && host && PLAIN_HOST.test(host)) {
      body = body.toString('utf8').replace(URL_PLACEHOLDER, () => JSON.stringify(`${req.protocol}://${host}`));
    }
    // Plain text, so a browser shows the file instead of running or rendering it; always re-fetched.
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .header('Content-Disposition', `inline; filename="${name}"`)
      .send(body);
  });
}
