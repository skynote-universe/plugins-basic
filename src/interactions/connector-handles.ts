/**
 * @file connector-handles.ts
 * @description 选中连线的编辑手柄 (纯函数)：两端改接、折线拖段平移、直线与曲线加拐点并拖动拐点、拖动文字
 *
 * 设计考量 (Why):
 * 1. 手柄由线型与当前路由推出，不持久化；拖动结果只落到连线的 controlPoints (世界坐标)，
 *    路由器据此求解 (折线保持拖过的段、两头对齐出线方向；直线依次经过拐点；曲线平滑地依次经过手动点)。
 * 2. 折线拖段时把当前路由的拐点整体固化为手动拐点：用户看到的形状就是开始编辑的形状，不会跳变。
 * 3. 折线首尾两段连着节点也能拖：在节点边上留一小段沿出线方向的短线再拐过去，线仍垂直离开边框。
 *    只剩这段短线那么长的首尾段不再提供手柄，否则反复拖动会一层层叠出小台阶。
 * 4. 太短的段 (屏幕上放不下手柄) 与离端点太近的位置不放拐点类手柄：不和端点手柄挤在一起，也不会误拖。
 */

import { CURVE_SEGMENT_SAMPLES, type ComputedRoute, type ConnectorEntity, type Point } from '@skynote/core';

export type ConnectorHandle =
  /** 端点：拖动按吸附规则改接 */
  | { readonly kind: 'end'; readonly point: Point; readonly end: 'from' | 'to' }
  /** 折线第 index 段的中点：沿垂直于该段的方向平移整段 (axis 为移动方向) */
  | { readonly kind: 'segment'; readonly point: Point; readonly index: number; readonly axis: 'x' | 'y' }
  /** 直线段或曲线段的中点：拖出一个新拐点，插在第 index 个手动拐点之前 */
  | { readonly kind: 'insert'; readonly point: Point; readonly index: number }
  /** 已有的手动拐点 (直线的拐点、曲线经过的点)：拖动移动，双击删除 */
  | { readonly kind: 'bend'; readonly point: Point; readonly index: number }
  /** 线上的第 index 段文字 (按文字范围命中)：拖动，可离开线条 */
  | { readonly kind: 'label'; readonly point: Point; readonly index: number };

/** 拖动折线首尾段时，节点边上保留的出线短线长度上限 (世界坐标) */
const STUB_LENGTH = 20;
/** 段的屏幕长度不足该值时不放拖段 / 加点手柄 */
const MIN_SEGMENT_PX = 32;
/** 拐点类手柄与端点的最小屏幕距离 */
const END_CLEARANCE_PX = 16;

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * 连线当前可用的手柄；手柄重叠时排在前面的优先命中 (端点 > 拐点 > 段中点)
 * @param zoom 视口缩放：手柄间距按屏幕像素判断
 */
export function connectorHandles(
  connector: Readonly<ConnectorEntity>,
  route: ComputedRoute,
  zoom: number
): ConnectorHandle[] {
  const { points } = route;
  const last = points.length - 1;
  const ends: ConnectorHandle[] = [
    { kind: 'end', point: points[0], end: 'from' },
    { kind: 'end', point: points[last], end: 'to' }
  ];
  const handles: ConnectorHandle[] = [];
  const length = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const longEnough = (a: Point, b: Point) => length(a, b) * zoom >= MIN_SEGMENT_PX;
  const controlPoints = connector.controlPoints ?? [];
  switch (connector.connectorType) {
    case 'orthogonal':
      for (let i = 0; i < last; i++) {
        const a = points[i];
        const b = points[i + 1];
        // 首尾段至少要比出线短线长出一截才能拖 (拖动时会留下这段短线)
        const touchesEnd = i === 0 || i === last - 1;
        if (!longEnough(a, b) || (touchesEnd && length(a, b) <= STUB_LENGTH * 2)) continue;
        handles.push({ kind: 'segment', point: midpoint(a, b), index: i, axis: a.y === b.y ? 'y' : 'x' });
      }
      break;
    case 'straight':
      controlPoints.forEach((point, index) => handles.push({ kind: 'bend', point, index }));
      for (let i = 0; i < last; i++) {
        if (longEnough(points[i], points[i + 1])) {
          handles.push({ kind: 'insert', point: midpoint(points[i], points[i + 1]), index: i });
        }
      }
      break;
    case 'curved':
      controlPoints.forEach((point, index) => handles.push({ kind: 'bend', point, index }));
      // 曲线按经过的点分段，每段采样数固定：第 i 段的中点即该段中间的采样点
      for (let i = 0; i <= controlPoints.length; i++) {
        const from = points[i * CURVE_SEGMENT_SAMPLES];
        const to = points[(i + 1) * CURVE_SEGMENT_SAMPLES];
        const sample = points[i * CURVE_SEGMENT_SAMPLES + CURVE_SEGMENT_SAMPLES / 2];
        if (sample && to && longEnough(from, to)) handles.push({ kind: 'insert', point: sample, index: i });
      }
      break;
  }
  const clearance = END_CLEARANCE_PX / zoom;
  const clear = (h: ConnectorHandle) =>
    length(h.point, points[0]) >= clearance && length(h.point, points[last]) >= clearance;
  // 已有拐点即使靠近端点也保留 (否则拖不回来)，只隐藏会凭空生成拐点的手柄
  return [...ends, ...handles.filter((h) => h.kind === 'bend' || clear(h))];
}

/**
 * 平移折线的第 index 段：整段沿 axis 移动 delta；首尾段在节点边上留一小段原方向的短线再拐过去
 * @returns 新的手动拐点 (不含两端)
 */
function moveSegment(points: readonly Point[], index: number, axis: 'x' | 'y', delta: number): Point[] {
  const path = points.map((p) => ({ x: p.x, y: p.y }));
  path[index][axis] += delta;
  path[index + 1][axis] += delta;
  const last = points.length - 1;
  // 首尾端点固定在节点上：被移走的端点换成「短线末端」的平移版，并补回短线
  const stub = (end: Point, toward: Point): [Point, Point] => {
    const length = Math.hypot(toward.x - end.x, toward.y - end.y) || 1;
    const along = Math.min(STUB_LENGTH, length / 2) / length;
    const fixed = { x: end.x + (toward.x - end.x) * along, y: end.y + (toward.y - end.y) * along };
    const shifted = { ...fixed, [axis]: fixed[axis] + delta };
    return [fixed, shifted];
  };
  if (index === last - 1) {
    const [fixed, shifted] = stub(points[last], points[last - 1]);
    path.splice(last, 1, shifted, fixed, { ...points[last] });
  }
  if (index === 0) {
    const [fixed, shifted] = stub(points[0], points[1]);
    path.splice(0, 1, { ...points[0] }, fixed, shifted);
  }
  return path.slice(1, -1);
}

/**
 * 拖动拐点类手柄后的 controlPoints
 * @param route 按下时的路由 (折线拖段以它为基准固化拐点)
 * @param delta 指针相对按下时的世界位移
 */
export function dragControlPoints(
  connector: Readonly<ConnectorEntity>,
  route: ComputedRoute,
  handle: Exclude<ConnectorHandle, { kind: 'end' | 'label' }>,
  delta: Point
): Point[] {
  const moved = { x: handle.point.x + delta.x, y: handle.point.y + delta.y };
  const base = (connector.controlPoints ?? []).map((p) => ({ x: p.x, y: p.y }));
  switch (handle.kind) {
    case 'segment':
      return moveSegment(route.points, handle.index, handle.axis, delta[handle.axis]);
    case 'insert':
      base.splice(handle.index, 0, moved);
      return base;
    case 'bend':
      base[handle.index] = moved;
      return base;
  }
}
