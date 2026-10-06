/**
 * @file connector-hints.ts
 * @description 连线工具与端点拖拽共用的覆盖层提示：目标节点的吸附点、整节点高亮与吸附位置
 *
 * 设计考量 (Why):
 * 新建连线与拖动已有连线的端点是同一套吸附规则 (SkyNoteEngine.snapConnectorEndpoint)，
 * 提示也必须一致，用户才能预期松手后连到哪里。
 */

import {
  applyMatrix,
  resolveNodeOutline,
  type CanvasPluginContext,
  type CanvasPrimitive,
  type ConnectorEndpointSnap,
  type ComputedRoute
} from '@skynote/core';

/** 吸附点圆点的屏幕半径 */
const ANCHOR_RADIUS_PX = 4;
/** 吸附位置的屏幕半径 */
const SNAP_RADIUS_PX = 5;
/** 提示线宽 (屏幕像素) */
const HINT_STROKE_PX = 1.5;

/**
 * 节点的吸附提示：四个吸附点；浮动吸附时整节点描边高亮，固定吸附时标出吸附位置
 * @param snap 当前吸附结果 (为空时只显示吸附点)
 */
export function connectorTargetHints(
  ctx: CanvasPluginContext,
  nodeId: string,
  snap: ConnectorEndpointSnap | null
): CanvasPrimitive[] {
  const { theme, viewport } = ctx.session;
  const unit = 1 / viewport.zoom;
  const primitives: CanvasPrimitive[] = [];
  if (snap?.kind === 'node') {
    const node = ctx.entities.getNode(nodeId)!.entity;
    const m = ctx.entities.getWorldTransform(nodeId)!;
    primitives.push({
      kind: 'polygon',
      points: resolveNodeOutline(node, ctx.nodeTypes.get(node.nodeType)).flatMap((p) => {
        const w = applyMatrix(m, p.x, p.y);
        return [w.x, w.y];
      }),
      stroke: theme.selectionStroke,
      strokeWidth: HINT_STROKE_PX * 2 * unit,
      strokeJoin: 'round'
    });
  }
  for (const p of ctx.connectors.getConnectorAnchors(nodeId)) {
    primitives.push({
      kind: 'circle',
      cx: p.x,
      cy: p.y,
      r: ANCHOR_RADIUS_PX * unit,
      fill: theme.background,
      stroke: theme.selectionStroke,
      strokeWidth: HINT_STROKE_PX * unit
    });
  }
  if (snap && (snap.kind === 'anchor' || snap.kind === 'outline')) {
    primitives.push({
      kind: 'circle',
      cx: snap.point.x,
      cy: snap.point.y,
      r: SNAP_RADIUS_PX * unit,
      fill: theme.selectionStroke
    });
  }
  return primitives;
}

/** 连线路由的描边 (预览中的连线、选中或悬停高亮)：有路径指令时沿用，圆角与曲线和连线本身一致 */
export function routeOutline(ctx: CanvasPluginContext, route: ComputedRoute, widthPx: number): CanvasPrimitive {
  const paint = {
    stroke: ctx.session.theme.selectionStroke,
    strokeWidth: widthPx / ctx.session.viewport.zoom,
    strokeJoin: 'round',
    strokeCap: 'round'
  } as const;
  return route.pathData
    ? { kind: 'path', d: route.pathData, ...paint }
    : { kind: 'line', points: route.points.flatMap((p) => [p.x, p.y]), ...paint };
}
