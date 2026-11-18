import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import { Sheet } from '../components/Sheet';
import { cx } from '../util';

/**
 * Colours a folder can have in the Explorer: the Resurrect 32 palette by Kerrie Lake
 * (https://lospec.com/palette-list/resurrect-32), in its own order.
 */
export const FOLDER_COLORS = [
  '#ffffff', '#fb6b1d', '#e83b3b', '#831c5d', '#c32454', '#f04f78', '#f68181', '#fca790',
  '#e3c896', '#ab947a', '#966c6c', '#625565', '#3e3546', '#0b5e65', '#0b8a8f', '#1ebc73',
  '#91db69', '#fbff86', '#fbb954', '#cd683d', '#9e4539', '#7a3045', '#6b3e75', '#905ea9',
  '#a884f3', '#eaaded', '#8fd3ff', '#4d9be6', '#4d65b4', '#484a77', '#30e1b9', '#8ff8e2',
];
/** A folder with no colour of its own looks like this one (styles.css says the same). Picking it clears the colour. */
export const DEFAULT_FOLDER_COLOR = '#fbb954';
const COLUMNS = 8;

/** A folder icon in the folder's colour (no colour: the default one). */
export function FolderIcon({ color }: { color?: string | null }) {
  return (
    <svg className="folder-icon" viewBox="0 0 20 16" aria-hidden="true" style={color ? ({ '--folder': color } as CSSProperties) : undefined}>
      <path
        className="folder-back"
        d="M1.5 2.75C1.5 1.78 2.28 1 3.25 1h4.1c.46 0 .9.2 1.2.55L9.9 3h6.85c.97 0 1.75.78 1.75 1.75v8.5c0 .97-.78 1.75-1.75 1.75H3.25c-.97 0-1.75-.78-1.75-1.75Z"
      />
      <path
        className="folder-front"
        d="M1.5 6.25C1.5 5.56 2.06 5 2.75 5h14.5c.69 0 1.25.56 1.25 1.25v7c0 .97-.78 1.75-1.75 1.75H3.25c-.97 0-1.75-.78-1.75-1.75Z"
      />
    </svg>
  );
}

/**
 * Picks a colour for one folder or several. A click applies it; the arrow keys move between colours. The folder
 * at the top shows the colour under the pointer (or the keyboard focus) before it is picked, and otherwise the
 * colours the folders have now.
 */
export function FolderColorDialog({ folders, onClose, onPick }: {
  folders: Array<{ id: number; name: string; color: string | null }>;
  onClose: () => void;
  /** A colour, or null for the default look. */
  onPick: (color: string | null) => void;
}) {
  const colors = new Set(folders.map((f) => (f.color ?? DEFAULT_FOLDER_COLOR).toLowerCase()));
  /** The colour they all have, if they have one between them. */
  const current = colors.size === 1 ? [...colors][0] : null;
  const start = Math.max(0, FOLDER_COLORS.indexOf(current ?? ''));
  const [focus, setFocus] = useState(start);
  const [preview, setPreview] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const moveTo = (index: number) => {
    const i = Math.min(FOLDER_COLORS.length - 1, Math.max(0, index));
    setFocus(i);
    grid.current?.querySelectorAll<HTMLButtonElement>('.folder-swatch')[i]?.focus();
  };
  // Runs after the Sheet has focused itself (autoFocus would lose to it): start on the folders' colour.
  useEffect(() => {
    grid.current?.querySelectorAll<HTMLButtonElement>('.folder-swatch')[start]?.focus({ preventScroll: true });
    // Landing there isn't pointing at a colour: the preview keeps showing the colours the folders have now.
    setPreview(null);
    // Only when it opens; later colour changes keep the focus where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** The preview: the colour under the pointer or the keyboard, else what the folders have now (a few, if they differ). */
  const shown = preview ? [preview] : [...colors].slice(0, 4);
  const previewOn = (color: string) => ({ onPointerEnter: () => setPreview(color), onFocus: () => setPreview(color) });
  const previewOff = {
    onPointerLeave: () => setPreview(null),
    // Only when the focus leaves altogether, not when it moves from one colour to the next.
    onBlur: (e: FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setPreview(null);
    },
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS } as Record<string, number>)[e.key];
    if (step !== undefined) moveTo(focus + step);
    else if (e.key === 'Home') moveTo(0);
    else if (e.key === 'End') moveTo(FOLDER_COLORS.length - 1);
    else return;
    e.preventDefault();
  };
  const pick = (color: string | null) => onPick(color === DEFAULT_FOLDER_COLOR ? null : color);
  const what = folders.length === 1 ? folders[0].name : `${folders.length} folders`;

  return (
    <Sheet title={folders.length === 1 ? `Colour for “${what}”` : `Colour for ${what}`} onClose={onClose} variant="center">
      <div className="stack">
        <div className="folder-color-preview" aria-hidden="true">
          <span className="folder-color-icons">
            {shown.map((c) => (
              <FolderIcon key={c} color={c} />
            ))}
          </span>
          <span className="ellipsis">{what}</span>
        </div>
        <div ref={grid} className="folder-colors" role="group" aria-label="Colours" onKeyDown={onKeyDown} {...previewOff}>
          {FOLDER_COLORS.map((c, i) => {
            const name = c === DEFAULT_FOLDER_COLOR ? `${c} (default)` : c;
            return (
              <button
                key={c}
                type="button"
                className={cx('folder-swatch', c === current && 'on')}
                style={{ background: c }}
                tabIndex={i === focus ? 0 : -1}
                aria-pressed={c === current}
                aria-label={name}
                title={name}
                onPointerEnter={() => setPreview(c)}
                onFocus={() => {
                  setFocus(i);
                  setPreview(c);
                }}
                onClick={() => pick(c)}
              />
            );
          })}
        </div>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => pick(null)} disabled={current === DEFAULT_FOLDER_COLOR} {...previewOn(DEFAULT_FOLDER_COLOR)} {...previewOff}>
            <FolderIcon /> Default
          </button>
        </div>
      </div>
    </Sheet>
  );
}
