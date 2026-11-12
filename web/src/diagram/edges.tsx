import { memo } from 'react';
import { Position, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { cx } from '../util';
import { arrowWidth, midpoint, roundedPath, type Point } from './model';
import type { ArrowEdge } from './flow';

/** Which way an arrow is going as it enters a box by each side. */
const INTO: Record<Position, Point> = {
  [Position.Top]: { x: 0, y: 1 },
  [Position.Bottom]: { x: 0, y: -1 },
  [Position.Left]: { x: 1, y: 0 },
  [Position.Right]: { x: -1, y: 0 },
};

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The arrowhead, drawn as a triangle rather than an SVG marker: its size doesn't balloon on thick arrows,
 * and the line stops at its base (`base`), so a thick line never pokes out round the tip.
 */
function arrowHead(tip: Point, dir: Point, width: number) {
  const length = 8 + 1.6 * width;
  const half = 3.5 + 0.7 * width;
  const base = { x: tip.x - dir.x * length, y: tip.y - dir.y * length };
  const [nx, ny] = [-dir.y * half, dir.x * half];
  const d = `M${r1(tip.x)},${r1(tip.y)} L${r1(base.x + nx)},${r1(base.y + ny)} L${r1(base.x - nx)},${r1(base.y - ny)} Z`;
  return { d, base };
}

/**
 * An arrow: along ELK's route with rounded corners (automatic layout), or React Flow's right-angled path
 * between the two boxes' sides (manual layout). Thicker for arrows that stand for more connections.
 */
export const ArrowEdgeView = memo(function ArrowEdgeView(p: EdgeProps<ArrowEdge>) {
  const data = p.data;
  const width = arrowWidth(data?.count ?? 1);
  let shaft: string;
  let head: string;
  let labelAt: Point;
  const points = data?.points;
  if (points && points.length >= 2) {
    const tip = points[points.length - 1];
    const prev = points[points.length - 2];
    const len = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
    const h = arrowHead(tip, { x: (tip.x - prev.x) / len, y: (tip.y - prev.y) / len }, width);
    shaft = roundedPath([...points.slice(0, -1), h.base]);
    head = h.d;
    labelAt = data?.labelAt ?? midpoint(points);
  } else {
    const h = arrowHead({ x: p.targetX, y: p.targetY }, INTO[p.targetPosition], width);
    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX: p.sourceX,
      sourceY: p.sourceY,
      sourcePosition: p.sourcePosition,
      targetX: h.base.x,
      targetY: h.base.y,
      targetPosition: p.targetPosition,
      borderRadius: 8,
      offset: 16,
    });
    shaft = path;
    head = h.d;
    labelAt = { x: labelX, y: labelY };
  }
  const text = data?.text ?? '';
  return (
    <>
      <path d={shaft} className="dedge-path" style={{ strokeWidth: width }} />
      <path d={head} className="dedge-head" />
      {/* A wide invisible line over it, so the arrow is easy to click or tap. */}
      <path d={shaft} className="react-flow__edge-interaction" fill="none" strokeOpacity={0} strokeWidth={20} />
      {text && (
        <text x={r1(labelAt.x)} y={r1(labelAt.y)} className={cx('dedge-label', !data?.showLabel && 'hover-only')} textAnchor="middle" dominantBaseline="central">
          {text}
        </text>
      )}
    </>
  );
});

export const edgeTypes = { arrow: ArrowEdgeView };
