/**
 * @file connector-edit.ts
 * @description 连线的选中、悬停高亮与编辑：单独选中一条连线时出现手柄 (见 connector-handles)——
 *              拖端点按吸附规则改接，拖折线中间段平移，拖直线段中点加拐点，拖曲线中点改弯度，双击拐点删除，
 *              拖线上的文字沿线移动
 *
 * 设计考量 (Why):
 * 1. 选中效果画在覆盖层 (ADR-110)，连线渲染不感知选中；只有选区、缩放、主题或选中连线的路由变化时才重画。
 * 2. 只在按到选中连线的手柄时认领指针 (优先级高于选择)，其余按压照常交给选择插件。
 * 3. 拖动中逐帧写入文档并共用一个 groupId：连线的真实渲染即预览，松手后一步撤销。
 * 4. 端点不吸附到另一端所在的节点，原因同连线工具 (自连线在折线路由下没有合理形状)。
 */

import {
  generateId,
  displayedConnectorLabel,
  isDerivedConnectorId,
  isPointInBounds,
  pointAlongPolyline,
  projectOntoPolyline,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasCursor,
  type CanvasPrimitive,
  type ComputedRoute,
  type ConnectorEndpointSnap,
  type ConnectorEntity,
  type DocumentChangeSet,
  type Point,
  type PointerHooks,
  type SessionChange,
  type SkyNotePlugin
} from '@skynote/core';
import { connectorTargetHints, routeOutline } from './connector-hints';
import { connectorHandles, dragControlPoints, type ConnectorHandle } from './connector-handles';

export const CONNECTOR_EDIT_PLUGIN_ID = '@skynote/plugins-basic/connector-edit';
/**
 * 高于文字编辑 (60)：双击拐点删除而不是在线上加文字。手柄只在单独选中一条连线时出现，
 * 此时没有选中节点、也没有变换控制柄，不会与节点交互争抢
 */
const CONNECTOR_EDIT_PRIORITY = 70;
const SELECTED_SESSION = 'connector-edit:selected';
const HOVER_SESSION = 'connector-edit:hover';
const DRAG_SESSION = 'connector-edit:drag';
/** 端点手柄、拐点与段中点手柄的屏幕半径，以及命中半径 */
const HANDLE_RADIUS_PX = 5;
const BEND_RADIUS_PX = 4;
const MIDPOINT_RADIUS_PX = 3;
/** 折线段手柄 (胶囊) 沿线段方向的长度与厚度 */
const SEGMENT_HANDLE_LENGTH_PX = 14;
const SEGMENT_HANDLE_THICKNESS_PX = 5;
const HANDLE_HIT_PX = 8;
const OUTLINE_STROKE_PX = 1.5;
/** 拖动的文字离线不足该屏幕距离时贴回线上 */
const LABEL_SNAP_PX = 8;
/** 按下到抬起不足该屏幕距离视为单击手柄 */
const CLICK_TOLERANCE_PX = 3;

interface HandleDrag {
  pointerId: number;
  connectorId: string;
  handle: ConnectorHandle;
  /** 按下时的连线与路由：拐点按相对按下位置的位移计算，逐帧提交不累积误差 */
  connector: Readonly<ConnectorEntity>;
  route: ComputedRoute;
  startPoint: Point;
  startClient: Point;
  groupId: string;
  /** 超过单击容差后才开始改动：按下手柄时的轻微抖动不把浮动端变成固定端，也不凭空加拐点 */
  moved: boolean;
}

/** 手柄的悬停光标：拖段按移动方向，其余为十字 */
function handleCursor(handle: ConnectorHandle): CanvasCursor {
  if (handle.kind === 'label') return 'move';
  if (handle.kind !== 'segment') return 'crosshair';
  return { kind: 'resize', angle: handle.axis === 'x' ? 0 : 90 };
}

export class ConnectorEditPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = CONNECTOR_EDIT_PLUGIN_ID;
  readonly name = '连线编辑';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private drag: HandleDrag | null = null;
  private hoveredId: string | null = null;
  private pointerPressed = false;
  private handleCursorSet = false;
  private drawnZoom = 0;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerPointerHooks(this, CONNECTOR_EDIT_PRIORITY);
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  unmount(): void {
    this.drag = null;
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (this.ctx.session.isReadOnly) {
      this.setHover(null);
      return;
    }
    this.pointerPressed = true;
    this.setHover(null);
    // Shift 点击用于增减选区 (含点在文字或手柄上)，交给选择插件
    if (e.isClaimed || e.button !== 0 || this.drag || e.modifiers.shift) return;
    const hit = this.hitHandle(e.point);
    // 双击只在拐点上表示删除拐点，其余位置 (包括文字上) 交给文字编辑
    if (!hit || (e.clickCount === 2 && hit.handle.kind !== 'bend')) return;
    e.claimPointer(CONNECTOR_EDIT_PLUGIN_ID);
    const { connector, route, handle } = hit;
    // 双击拐点删除 (曲线删除后恢复自动弯度)
    if (handle.kind === 'bend' && e.clickCount === 2) {
      const rest = connector.controlPoints!.filter((_, i) => i !== handle.index);
      this.ctx.document.updateConnector(
        connector.id,
        { controlPoints: rest.length > 0 ? rest : undefined },
        { label: '删除拐点' }
      );
      return;
    }
    this.drag = {
      pointerId: e.pointerId,
      connectorId: connector.id,
      handle,
      connector: { ...connector, controlPoints: connector.controlPoints?.map((p) => ({ ...p })) },
      route,
      startPoint: e.point,
      startClient: e.clientPoint,
      groupId: generateId('connector-edit'),
      moved: false
    };
    this.ctx.host.capturePointer(e.pointerId);
    this.ctx.host.setCursor(handleCursor(handle));
  }

  onPointerMove(e: CanvasPointerEvent): void {
    if (!this.drag && e.isClaimed) {
      this.setHover(null);
      this.handleCursorSet = false;
      return;
    }
    if (this.ctx.session.isReadOnly) {
      this.setHover(null);
      if (this.handleCursorSet) this.ctx.host.setCursor('default');
      this.handleCursorSet = false;
      return;
    }
    const { drag, ctx } = this;
    if (!drag) {
      if (this.pointerPressed) return;
      // 被上层节点盖住的连线不高亮 (点下去选中的是节点)
      const top = ctx.hitTest(e.point);
      const connector = top?.kind === 'connector' ? top.connector : null;
      this.setHover(connector && !ctx.session.selectedConnectorIds.has(connector.id) ? connector.id : null);
      // 只复位自己设过的光标，不覆盖其他插件 (如变换控制柄) 的悬停光标
      const hit = this.hitHandle(e.point);
      if (hit) ctx.host.setCursor(handleCursor(hit.handle));
      else if (this.handleCursorSet) ctx.host.setCursor('default');
      this.handleCursorSet = hit !== null;
      return;
    }
    if (drag.pointerId !== e.pointerId || !this.pastTolerance(drag, e)) return;
    this.apply(drag, e.point);
  }

  onPointerUp(e: CanvasPointerEvent): void {
    this.pointerPressed = false;
    const { drag } = this;
    if (drag?.pointerId !== e.pointerId) return;
    // 以抬起位置为准 (松手前的最后一次移动可能与抬起不在同一点)；单击手柄不改动连线
    if (this.pastTolerance(drag, e)) this.apply(drag, e.point);
    this.finishDrag();
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    this.pointerPressed = false;
    if (this.drag?.pointerId === e.pointerId) this.finishDrag();
  }

  onPointerLeave(): void {
    this.setHover(null);
  }

  private pastTolerance(drag: HandleDrag, e: CanvasPointerEvent): boolean {
    drag.moved ||=
      Math.hypot(e.clientPoint.x - drag.startClient.x, e.clientPoint.y - drag.startClient.y) >= CLICK_TOLERANCE_PX;
    return drag.moved;
  }

  /** 按手柄写入拖动结果，与本次拖动同组撤销：端点按吸附规则改接，其余改写手动拐点 */
  private apply(drag: HandleDrag, point: Point): void {
    const { ctx } = this;
    const { handle, connector } = drag;
    if (handle.kind === 'end') {
      const otherNodeId = connector[handle.end === 'from' ? 'to' : 'from'].nodeId;
      const snap = ctx.connectors.snapConnectorEndpoint(point, (node) => node.id !== otherNodeId);
      ctx.document.updateConnector(
        drag.connectorId,
        { [handle.end]: snap.endpoint },
        { groupId: drag.groupId, label: '重新连接' }
      );
      this.drawDragHints(snap);
      return;
    }
    if (handle.kind === 'label') {
      // 文字中心跟着指针走：位置取线上最近处 (沿线长度的比例)，离线的距离存为偏移；
      // 离线不足吸附距离时贴回线上。投影到按下时的路由 (拖动文字不改变路由)
      const center = {
        x: handle.point.x + point.x - drag.startPoint.x,
        y: handle.point.y + point.y - drag.startPoint.y
      };
      const position = projectOntoPolyline(drag.route.points, center);
      const onLine = pointAlongPolyline(drag.route.points, position);
      const offsetX = center.x - onLine.x;
      const offsetY = center.y - onLine.y;
      const snapped = Math.hypot(offsetX, offsetY) * ctx.session.viewport.zoom < LABEL_SNAP_PX;
      ctx.document.updateConnector(
        drag.connectorId,
        {
          textBlocks: connector.textBlocks!.map((block, i) => {
            if (i !== handle.index) return block;
            const { offsetX: _x, offsetY: _y, ...rest } = block;
            return snapped ? { ...rest, position } : { ...rest, position, offsetX, offsetY };
          })
        },
        { groupId: drag.groupId, label: '移动连线文字' }
      );
      this.drawLabelGuide(onLine, snapped ? null : center);
      return;
    }
    const delta = { x: point.x - drag.startPoint.x, y: point.y - drag.startPoint.y };
    ctx.document.updateConnector(
      drag.connectorId,
      { controlPoints: dragControlPoints(connector, drag.route, handle, delta) },
      { groupId: drag.groupId, label: '调整拐点' }
    );
  }

  /** 单独选中一条未锁定的连线时，指针下的手柄 */
  private hitHandle(
    point: Point
  ): { connector: Readonly<ConnectorEntity>; route: ComputedRoute; handle: ConnectorHandle } | null {
    const connectorId = this.editableConnector();
    if (!connectorId) return null;
    const route = this.ctx.connectors.getConnectorRoute(connectorId);
    if (!route) return null;
    const connector = this.ctx.document.getConnector(connectorId)!;
    const tolerance = HANDLE_HIT_PX / this.ctx.session.viewport.zoom;
    // 端点最优先；文字其次 (文字默认在线的正中，会盖住段中点手柄，拖文字比拖段更常用)；最后是拐点与段中点
    const near = this.geometryHandles(connector, route).filter(
      ({ point: p }) => Math.hypot(p.x - point.x, p.y - point.y) <= tolerance
    );
    const handle = near.find((h) => h.kind === 'end') ?? this.hitLabel(route, point) ?? near[0];
    return handle ? { connector, route, handle } : null;
  }

  private hitLabel(route: ComputedRoute, point: Point): ConnectorHandle | undefined {
    const index = route.labels.findIndex(({ bounds }) => isPointInBounds(point, bounds));
    if (index < 0) return undefined;
    const { bounds } = route.labels[index];
    return {
      kind: 'label',
      index,
      point: { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 }
    };
  }

  /** 单独选中、未锁定且没有在编辑线上文字的连线 (编辑文字时点击用于定位光标) */
  private editableConnector(): string | null {
    const { session, entities } = this.ctx;
    if (session.selectedConnectorIds.size !== 1 || session.selectedNodeIds.size > 0 || session.textEditing) return null;
    const [id] = session.selectedConnectorIds;
    return entities.getConnector(id)?.entity.locked ? null : id;
  }

  private setHover(id: string | null): void {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    const route = id && this.ctx.connectors.getConnectorRoute(id);
    if (route) this.ctx.host.overlay.setPrimitives(HOVER_SESSION, [routeOutline(this.ctx, route, OUTLINE_STROKE_PX)]);
    else this.ctx.host.overlay.clear(HOVER_SESSION);
  }

  private onSessionChange(change: SessionChange): void {
    if (change.readOnlyChanged && this.ctx.session.isReadOnly) {
      if (this.drag) this.finishDrag();
      this.setHover(null);
      this.redraw();
      return;
    }
    const zoomChanged = change.viewportChanged && this.ctx.session.viewport.zoom !== this.drawnZoom;
    if (this.hoveredId && (change.viewportChanged || this.ctx.session.selectedConnectorIds.has(this.hoveredId))) {
      this.setHover(null);
    }
    if (
      change.toggledConnectorIds.size > 0 ||
      change.toggledNodeIds.size > 0 ||
      zoomChanged ||
      change.themeChanged ||
      change.textEditingChanged ||
      change.readOnlyChanged
    ) {
      this.redraw();
    }
  }

  private onDocumentChange(changes: DocumentChangeSet): void {
    if (
      this.hoveredId &&
      (changes.connectors.geometry.has(this.hoveredId) || changes.connectors.removed.has(this.hoveredId))
    ) {
      this.setHover(null);
    }
    for (const id of this.ctx.session.selectedConnectorIds) {
      if (changes.connectors.geometry.has(id) || changes.connectors.data.has(id)) {
        this.redraw();
        return;
      }
    }
  }

  /** 选中连线沿路由描边；单独选中一条时画出编辑手柄 (段中点在下，拐点与端点在上) */
  private redraw(): void {
    const { ctx } = this;
    if (ctx.session.isReadOnly) {
      ctx.host.overlay.clear(SELECTED_SESSION);
      return;
    }
    const { theme, viewport, selectedConnectorIds } = ctx.session;
    this.drawnZoom = viewport.zoom;
    const unit = 1 / viewport.zoom;
    const primitives: CanvasPrimitive[] = [];
    for (const id of selectedConnectorIds) {
      const route = ctx.connectors.getConnectorRoute(id);
      if (!route) continue;
      primitives.push(routeOutline(ctx, route, OUTLINE_STROKE_PX));
      // 文字占据的范围：选中与编辑时都显示，拖动文字、点进去编辑都有明确的目标；
      // 编辑中按编辑视图排版，输入法拼音输入时范围框与底色同步伸展
      const target = ctx.session.textEditing;
      const editing = target?.kind === 'connector' && target.id === id ? target : null;
      for (const label of route.labels) {
        const { bounds } = displayedConnectorLabel(label, editing, ctx.document.fonts);
        primitives.push({
          kind: 'rect',
          x: bounds.left,
          y: bounds.top,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top,
          stroke: theme.selectionStroke,
          strokeWidth: OUTLINE_STROKE_PX * unit,
          radius: 2 * unit
        });
      }
    }
    const editable = this.editableConnector();
    const route = editable && ctx.connectors.getConnectorRoute(editable);
    if (route) {
      const handles = this.geometryHandles(ctx.document.getConnector(editable)!, route).reverse();
      for (const handle of handles) primitives.push(this.handlePrimitive(handle, unit));
    }
    ctx.host.overlay.setPrimitives(SELECTED_SESSION, primitives);
  }

  /**
   * 端点、拐点与线段手柄；派生连线 (如导图分支线) 的几何由来源决定，不提供这些手柄，只保留线上文字的拖动
   */
  private geometryHandles(connector: Readonly<ConnectorEntity>, route: ComputedRoute): ConnectorHandle[] {
    return isDerivedConnectorId(connector.id) ? [] : connectorHandles(connector, route, this.ctx.session.viewport.zoom);
  }

  /**
   * 手柄按用途区分形状：端点为白底圆；已有拐点为实心菱形；折线段为沿线段方向的胶囊 (拖动方向与之垂直)；
   * 可拖出新拐点的段中点为小号空心圆
   */
  private handlePrimitive(handle: ConnectorHandle, unit: number): CanvasPrimitive {
    const { theme } = this.ctx.session;
    const { x, y } = handle.point;
    const outline = { stroke: theme.selectionStroke, strokeWidth: OUTLINE_STROKE_PX * unit };
    switch (handle.kind) {
      case 'bend': {
        const r = BEND_RADIUS_PX * unit * 1.25;
        return { kind: 'polygon', points: [x, y - r, x + r, y, x, y + r, x - r, y], fill: theme.selectionStroke };
      }
      case 'segment': {
        // axis 是移动方向：竖着拖的是水平段，胶囊沿水平方向
        const along = SEGMENT_HANDLE_LENGTH_PX * unit;
        const across = SEGMENT_HANDLE_THICKNESS_PX * unit;
        const [width, height] = handle.axis === 'y' ? [along, across] : [across, along];
        return {
          kind: 'rect',
          x: x - width / 2,
          y: y - height / 2,
          width,
          height,
          radius: across / 2,
          fill: theme.background,
          ...outline
        };
      }
      case 'insert':
        return { kind: 'circle', cx: x, cy: y, r: MIDPOINT_RADIUS_PX * unit, fill: theme.background, ...outline };
      default:
        return { kind: 'circle', cx: x, cy: y, r: HANDLE_RADIUS_PX * unit, fill: theme.background, ...outline };
    }
  }

  /** 拖动文字的示意：线上的锚点，离线时再加一条从锚点指向文字中心的虚线 */
  private drawLabelGuide(anchor: Point, center: Point | null): void {
    const { theme, viewport } = this.ctx.session;
    const unit = 1 / viewport.zoom;
    const primitives: CanvasPrimitive[] = [
      { kind: 'circle', cx: anchor.x, cy: anchor.y, r: BEND_RADIUS_PX * unit, fill: theme.selectionStroke }
    ];
    if (center) {
      primitives.unshift({
        kind: 'line',
        points: [anchor.x, anchor.y, center.x, center.y],
        stroke: theme.selectionStroke,
        strokeWidth: OUTLINE_STROKE_PX * unit,
        strokeDashArray: [4 * unit, 3 * unit]
      });
    }
    this.ctx.host.overlay.setPrimitives(DRAG_SESSION, primitives, { transient: true });
  }

  private drawDragHints(snap: ConnectorEndpointSnap): void {
    const nodeId = snap.endpoint.nodeId;
    this.ctx.host.overlay.setPrimitives(DRAG_SESSION, nodeId ? connectorTargetHints(this.ctx, nodeId, snap) : [], {
      transient: true
    });
  }

  private finishDrag(): void {
    const { host } = this.ctx;
    host.releasePointer(this.drag!.pointerId);
    host.overlay.clear(DRAG_SESSION);
    host.setCursor('default');
    this.drag = null;
  }
}
