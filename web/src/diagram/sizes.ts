import type { CSSProperties } from 'react';
import { BOX, type Measure, type TextStyle } from './model';

/** The fonts the diagram's CSS uses for each kind of text; measuring with the same ones keeps boxes the right size. */
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FONTS: Record<TextStyle, { font: string; letterSpacing: number }> = {
  caption: { font: `700 10.5px ${SANS}`, letterSpacing: 0.42 },
  label: { font: `700 13px ${SANS}`, letterSpacing: 0 },
  path: { font: '11px ui-monospace, Consolas, monospace', letterSpacing: 0 },
  role: { font: `12px ${SANS}`, letterSpacing: 0 },
  header: { font: `700 13px ${SANS}`, letterSpacing: 0 },
  edge: { font: `11px ${SANS}`, letterSpacing: 0 },
};

let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

/** Text width in px, measured once with a canvas and remembered. */
export const measureText: Measure = (text, style) => {
  const key = `${style}\u0000${text}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
  const { font, letterSpacing } = FONTS[style];
  let width = text.length * 7;
  if (ctx) {
    ctx.font = font;
    width = ctx.measureText(text).width + text.length * letterSpacing;
  }
  if (cache.size > 20_000) cache.clear();
  cache.set(key, width);
  return width;
};

/** BOX as CSS variables, set on the diagram so the boxes drawn match the sizes the layout used. */
export const boxCssVars = {
  '--box-pad-x': `${BOX.padX}px`,
  '--box-pad-y': `${BOX.padY}px`,
  '--box-border': `${BOX.border}px`,
  '--box-caption': `${BOX.caption}px`,
  '--box-label-line': `${BOX.labelLine}px`,
  '--box-path-line': `${BOX.pathLine}px`,
  '--box-role-line': `${BOX.roleLine}px`,
  '--group-header': `${BOX.groupHeader}px`,
} as CSSProperties;
