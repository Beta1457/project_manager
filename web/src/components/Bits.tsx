import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Category } from '../types';
import { PRIORITY_COLORS, contrastText } from '../util';
import { useColors } from '../hooks';
import { useTaskParam } from '../taskParam';
import { useProject } from '../projectContext';

export function StatusPill({ status, label }: { status: string; label: string }) {
  const bg = useColors().status(status);
  return (
    <span className="pill" style={{ background: bg, color: contrastText(bg) }}>
      {label}
    </span>
  );
}

export function CategoryChip({ category }: { category: Category }) {
  return (
    <span className="chip" style={{ background: category.color + '22', color: category.color, border: `1px solid ${category.color}55` }}>
      {category.name}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span className="row nowrap" style={{ gap: 4 }} title={`Priority: ${priority}`}>
      <span className="dot" style={{ background: PRIORITY_COLORS[priority] ?? '#94a3b8' }} />
      <span style={{ textTransform: 'capitalize' }}>{priority}</span>
    </span>
  );
}

marked.setOptions({ gfm: true, breaks: true });

// Links in notes and descriptions open in a new tab, so tapping one never navigates away from the app.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // The only legitimate input in markdown is a GFM task-list box ("- [x] done"): force exactly that.
  if (node.tagName === 'INPUT') {
    for (const attr of [...node.attributes]) if (attr.name !== 'checked') node.removeAttribute(attr.name);
    node.setAttribute('type', 'checkbox');
    node.setAttribute('disabled', '');
  }
});

/**
 * Markdown can come from API tokens (e.g. Claude), so beyond DOMPurify's script-safe defaults we also
 * drop inline styles and form controls, which could otherwise overlay or imitate the app's own UI.
 */
const PURIFY = {
  FORBID_ATTR: ['style'],
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option'],
  ADD_ATTR: ['target'],
};

/** Matches keys of the given projects ("APP-12"). Keys are letters and digits only, so they need no escaping. */
function taskKeyPattern(projectKeys: string[]): RegExp | null {
  const keys = projectKeys.filter((k) => /^[A-Z][A-Z0-9]*$/.test(k));
  return keys.length ? new RegExp(`\\b(?:${keys.join('|')})-\\d{1,9}\\b`, 'g') : null;
}

/**
 * Turns task keys of your projects in plain text ("see APP-12") into links that open that task. Runs on the
 * already-sanitized HTML and only creates <a> elements whose target is a matched key, so it can't introduce
 * anything unsafe. Text inside existing links and code is left alone.
 */
function linkTaskKeys(html: string, pattern: RegExp | null): string {
  // Non-global copy for test(): test() on the /g regex would move its lastIndex.
  const has = pattern && new RegExp(pattern.source);
  if (!pattern || !has || !has.test(html)) return html;
  const root = document.createElement('template');
  root.innerHTML = html;
  const walker = document.createTreeWalker(root.content, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    const text = node.data;
    if (!has.test(text)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      frag.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = `?task=${m[0]}`;
      a.className = 'task-ref';
      a.dataset.task = m[0];
      a.textContent = m[0];
      frag.append(a);
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return root.innerHTML;
}

export function Markdown({ text }: { text: string }) {
  const [, openTask] = useTaskParam();
  const { projects } = useProject();
  const pattern = useMemo(() => taskKeyPattern(projects.map((p) => p.key)), [projects]);
  const html = useMemo(() => linkTaskKeys(DOMPurify.sanitize(marked.parse(text, { async: false }), PURIFY), pattern), [text, pattern]);
  return (
    <div
      className="markdown"
      onClick={(e) => {
        const el = e.target as HTMLElement;
        // "APP-12" mentions open that task in the app (Ctrl/Cmd-click still opens a new tab).
        const ref = el.closest<HTMLAnchorElement>('a.task-ref');
        if (ref?.dataset.task && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
          e.preventDefault();
          openTask(ref.dataset.task);
          return;
        }
        // Tapping an image (not inside a link) opens it full size — handy for screenshots on a phone.
        const img = el.closest('img');
        if (img && !img.closest('a')) window.open(img.src, '_blank', 'noopener');
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Colour picker that only saves once the user stops dragging (avoids one request per pixel). */
export function ColorInput({ value, onCommit, label }: { value: string; onCommit: (c: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = window.setTimeout(() => onCommit(draft), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  return <input type="color" value={draft} aria-label={label} onChange={(e) => setDraft(e.target.value)} />;
}

export function TypeBadge({ type }: { type: string }) {
  const color = useColors().type(type);
  return (
    <span className="chip" style={{ background: color, color: contrastText(color) }}>
      {type}
    </span>
  );
}

export function ProgressBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  const colors = useColors();
  if (!total) return <div className="progress" />;
  return (
    <div className="progress" title={Object.entries(counts).filter(([, n]) => n).map(([s, n]) => `${s}: ${n}`).join(', ')}>
      {Object.entries(counts).map(([s, n]) =>
        n ? <span key={s} style={{ width: `${(n / total) * 100}%`, background: colors.status(s) }} /> : null,
      )}
    </div>
  );
}

export function Spinner() {
  return <div className="empty">Loading…</div>;
}

/** Who made the app, shown at the bottom of the login and Settings pages. */
export function Credit() {
  return <p className="tiny muted credit">Project Manager · © 2026 Bettafish Games, LLC · MIT License</p>;
}
