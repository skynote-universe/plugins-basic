/**
 * @file snapping.ts
 * @description 拖动与缩放时的吸附对齐：边缘与中心线对齐、等间距分布，以及参考线图元
 *
 * 设计考量 (Why):
 * 1. 候选只取视口内与被拖节点同一容器的兄弟节点，外加该容器本身 (只参与对齐)：看不见的节点吸附过去会让人困惑，
 *    同层对齐也最符合直觉。候选在手势开始时收集一次 (拖动中其他节点不动)，逐帧对齐只在排序数组上二分查找。
 * 2. 每轴独立取修正量最小的一种吸附 (对齐或等间距)；吸附后再按最终位置找出所有重合的线与相等的间距画参考线，
 *    同时对齐多个节点时都能看到。
 * 3. 阈值按屏幕像素换算为世界距离，任何缩放下手感一致；参考线线宽同样换算，屏幕上恒为 1 像素。
 */

import {
  computeViewportWorldBounds,
  isNodeHiddenByOpacity,
  type CanvasPluginContext,
  type CanvasPrimitive,
  type Point,
  type RectBounds
} from '@skynote/core';

/** 吸附阈值 (屏幕像素) */
export const SNAP_THRESHOLD_PX = 6;
const SNAP_SESSION = 'snap:guides';
/** 判定线重合、间距相等的容差 (世界坐标)：吸附后数值本就相等，只需吸收浮点误差 */
const EPSILON = 0.01;
/** 间距标注两端短线的屏幕长度 */
const GAP_TICK_PX = 6;

type Axis = 'x' | 'y';

/** 矩形在某轴上的投影 (lo / hi) 与另一轴上的范围 (crossLo / crossHi) */
interface Span {
  readonly lo: number;
  readonly hi: number;
  readonly crossLo: number;
  readonly crossHi: number;
}

/** 对齐参考线：axis 为 x 时是 x = at 的竖线，从 from 画到 to (y) */
export interface AlignGuide {
  readonly axis: Axis;
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** 间距标注：axis 为 x 时是 y = cross 处从 from 到 to 的横线 */
export interface GapGuide {
  readonly axis: Axis;
  readonly from: number;
  readonly to: number;
  readonly cross: number;
}

export interface SnapGuides {
  readonly aligns: readonly AlignGuide[];
  readonly gaps: readonly GapGuide[];
}

interface Gap {
  readonly before: Span;
  readonly after: Span;
  readonly size: number;
}

function span(b: RectBounds, axis: Axis): Span {
  return axis === 'x'
    ? { lo: b.left, hi: b.right, crossLo: b.top, crossHi: b.bottom }
    : { lo: b.top, hi: b.bottom, crossLo: b.left, crossHi: b.right };
}

const linesOf = (s: Span): number[] => [s.lo, (s.lo + s.hi) / 2, s.hi];

/** 升序数组中离 value 最近的值；空数组为 NaN (任何比较都不成立，即不吸附) */
function nearest(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  const after = sorted[lo];
  const before = sorted[lo - 1];
  if (before === undefined) return after ?? NaN;
  return value - before <= after - value ? before : after;
}

/** 两个矩形之间的间距标注：画在两者在另一轴上重叠范围的中间 */
function gapGuide(axis: Axis, a: Span, b: Span): GapGuide {
  return {
    axis,
    from: a.hi,
    to: b.lo,
    cross: (Math.max(a.crossLo, b.crossLo) + Math.min(a.crossHi, b.crossHi)) / 2
  };
}

/** 吸附候选：手势开始时收集，拖动中不变 */
export class SnapTargets {
  /** 参与对齐的矩形 (兄弟节点与容器) */
  private readonly alignSpans: Record<Axis, readonly Span[]>;
  /** 参与等间距的矩形 (只有兄弟节点) */
  private readonly siblingSpans: Record<Axis, readonly Span[]>;
  /** 对齐候选线 (升序) */
  private readonly lines: Record<Axis, readonly number[]>;

  constructor(siblings: readonly RectBounds[], container?: RectBounds) {
    const all = container ? [...siblings, container] : siblings;
    const spans = (boxes: readonly RectBounds[], axis: Axis) => boxes.map((b) => span(b, axis));
    this.alignSpans = { x: spans(all, 'x'), y: spans(all, 'y') };
    this.siblingSpans = { x: spans(siblings, 'x'), y: spans(siblings, 'y') };
    const sortedLines = (axis: Axis) => this.alignSpans[axis].flatMap(linesOf).sort((a, b) => a - b);
    this.lines = { x: sortedLines('x'), y: sortedLines('y') };
  }

  /** 移动：每轴取修正量最小的对齐或等间距吸附，返回应追加的位移 */
  snapMove(rect: RectBounds, threshold: number): Point {
    return { x: this.snapMoveAxis(rect, 'x', threshold), y: this.snapMoveAxis(rect, 'y', threshold) };
  }

  /** 缩放：被拖动的边对齐到最近的候选线，返回该边应追加的位移 */
  snapEdge(axis: Axis, value: number, threshold: number): number {
    const correction = nearest(this.lines[axis], value) - value;
    return Math.abs(correction) <= threshold ? correction : 0;
  }

  /**
   * 最终位置上的参考线：与候选重合的边缘与中心线；withGaps 时还有与已有间距相等的间距
   * (缩放时改变的是尺寸而不是位置，等间距无从谈起，只画对齐线)
   */
  guides(rect: RectBounds, withGaps: boolean): SnapGuides {
    const aligns: AlignGuide[] = [];
    const gaps: GapGuide[] = [];
    for (const axis of ['x', 'y'] as const) {
      const s = span(rect, axis);
      for (const at of new Set(linesOf(s))) {
        const matched = this.alignSpans[axis].filter((c) => linesOf(c).some((v) => Math.abs(v - at) < EPSILON));
        if (matched.length === 0) continue;
        aligns.push({
          axis,
          at,
          from: Math.min(s.crossLo, ...matched.map((c) => c.crossLo)),
          to: Math.max(s.crossHi, ...matched.map((c) => c.crossHi))
        });
      }
      if (withGaps) gaps.push(...this.equalGaps(s, axis));
    }
    return { aligns, gaps };
  }

  private snapMoveAxis(rect: RectBounds, axis: Axis, threshold: number): number {
    const s = span(rect, axis);
    let best = Infinity;
    const consider = (correction: number) => {
      if (Math.abs(correction) <= threshold && Math.abs(correction) < Math.abs(best)) best = correction;
    };
    for (const v of linesOf(s)) consider(nearest(this.lines[axis], v) - v);
    const size = s.hi - s.lo;
    const { prev, next, gaps } = this.layout(s, axis, threshold);
    // 夹在两个节点中间：两侧间距相等
    if (prev && next && next.lo - prev.hi >= size) consider((prev.hi + next.lo - size) / 2 - s.lo);
    // 与同一行已有的间距相等
    for (const gap of gaps) {
      if (prev) consider(prev.hi + gap.size - s.lo);
      if (next) consider(next.lo - gap.size - size - s.lo);
    }
    return best === Infinity ? 0 : best;
  }

  /** 最终位置上相等的间距：两侧相等，或与同一行已有的某段间距相等 */
  private equalGaps(s: Span, axis: Axis): GapGuide[] {
    const { prev, next, gaps } = this.layout(s, axis, EPSILON);
    const before = prev ? s.lo - prev.hi : NaN;
    const after = next ? next.lo - s.hi : NaN;
    const result = new Map<string, GapGuide>();
    const add = (a: Span, b: Span) => {
      const guide = gapGuide(axis, a, b);
      result.set(`${guide.from}:${guide.to}:${guide.cross}`, guide);
    };
    if (prev && next && before > EPSILON && Math.abs(before - after) < EPSILON) {
      add(prev, s);
      add(s, next);
    }
    for (const gap of gaps) {
      if (prev && before > EPSILON && Math.abs(gap.size - before) < EPSILON) {
        add(prev, s);
        add(gap.before, gap.after);
      }
      if (next && after > EPSILON && Math.abs(gap.size - after) < EPSILON) {
        add(s, next);
        add(gap.before, gap.after);
      }
    }
    return [...result.values()];
  }

  /**
   * 与 s 处在同一行 (另一轴上有重叠) 的兄弟节点：s 前后最近的一个，以及它们彼此之间的间距
   * @param tolerance 与 s 略有重叠 (不超过该距离) 的也算作前后邻居
   */
  private layout(s: Span, axis: Axis, tolerance: number): { prev?: Span; next?: Span; gaps: Gap[] } {
    const row = this.siblingSpans[axis]
      .filter((c) => c.crossLo < s.crossHi && s.crossLo < c.crossHi)
      .sort((a, b) => a.lo - b.lo);
    let prev: Span | undefined;
    let next: Span | undefined;
    for (const c of row) {
      if (c.hi <= s.lo + tolerance && (!prev || c.hi > prev.hi)) prev = c;
      if (c.lo >= s.hi - tolerance && (!next || c.lo < next.lo)) next = c;
    }
    const gaps: Gap[] = [];
    for (let i = 0; i + 1 < row.length; i++) {
      const [before, after] = [row[i], row[i + 1]];
      // s 正夹在其中的那段间距不算 (s 移走后它才存在)
      if (after.lo < before.hi || (before === prev && after === next)) continue;
      gaps.push({ before, after, size: after.lo - before.hi });
    }
    return { prev, next, gaps };
  }
}

/**
 * 收集被拖节点的吸附候选：视口内与它们同一容器的兄弟节点，外加该容器；
 * 被拖节点分属不同容器时只与根层级对齐
 */
export function collectSnapTargets(ctx: CanvasPluginContext, movingIds: readonly string[]): SnapTargets {
  const { entities, spatial, session } = ctx;
  const parents = new Set(movingIds.map((id) => entities.getNode(id)?.entity.parentId));
  const parentId = parents.size === 1 ? [...parents][0] : undefined;
  const moving = new Set(movingIds);
  const siblings: RectBounds[] = [];
  for (const id of spatial.search(computeViewportWorldBounds(session.viewport, session.viewportSize))) {
    const node = entities.getNode(id)?.entity;
    // 整节点透明时不作为对齐目标；局部透明语义由节点类型定义保留
    if (
      moving.has(id) ||
      !node ||
      node.parentId !== parentId ||
      isNodeHiddenByOpacity(node, ctx.nodeTypes.get(node.nodeType))
    )
      continue;
    siblings.push(spatial.getBounds(id)!);
  }
  const parentNode = parentId === undefined ? undefined : entities.getNode(parentId)?.entity;
  const containerBounds =
    parentNode && ctx.nodeTypes.get(parentNode.nodeType)?.acceptsChildren ? spatial.getBounds(parentId!) : undefined;
  return new SnapTargets(siblings, containerBounds);
}

/** 画出参考线；guides 为 null 或没有任何参考线时清除 */
export function drawSnapGuides(ctx: CanvasPluginContext, guides: SnapGuides | null): void {
  if (!guides || guides.aligns.length + guides.gaps.length === 0) {
    ctx.host.overlay.clear(SNAP_SESSION);
    return;
  }
  const { theme, viewport } = ctx.session;
  const stroke = theme.snapGuide;
  const strokeWidth = 1 / viewport.zoom;
  const tick = GAP_TICK_PX / 2 / viewport.zoom;
  // axis 为 x 时 along 是 x、across 是 y
  const line = (axis: Axis, coords: readonly [number, number][]): CanvasPrimitive => ({
    kind: 'line',
    points: coords.flatMap(([along, across]) => (axis === 'x' ? [along, across] : [across, along])),
    stroke,
    strokeWidth
  });
  const primitives: CanvasPrimitive[] = [];
  for (const { axis, at, from, to } of guides.aligns) {
    // 对齐线沿另一轴延伸
    primitives.push(
      line(axis, [
        [at, from],
        [at, to]
      ])
    );
  }
  for (const { axis, from, to, cross } of guides.gaps) {
    primitives.push(
      line(axis, [
        [from, cross],
        [to, cross]
      ]),
      line(axis, [
        [from, cross - tick],
        [from, cross + tick]
      ]),
      line(axis, [
        [to, cross - tick],
        [to, cross + tick]
      ])
    );
  }
  ctx.host.overlay.setPrimitives(SNAP_SESSION, primitives, { transient: true });
}
