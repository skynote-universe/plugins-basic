/**
 * @file connector-tool.ts
 * @description 画连线：连线工具 (按 X 或从工具栏进入)，以及选中单个节点时四边的「+」快速连接
 *
 * 设计考量 (Why):
 * 1. 只在工具激活或按到「+」时认领指针 (优先级高于选择与变换、低于空格平移)，选择插件看到指针已被认领自然让路，两者互不探测。
 * 2. 两端都按引擎统一的吸附规则 (吸附点 → 边框任一点 → 整节点浮动 → 自由端)，预览线与最终连线走同一个路由器，
 *    松手前看到的就是松手后的样子。
 * 3. 画完一条回到选择工具并选中新连线，可以立刻改样式；单击 (没有拖动) 不创建连线。
 * 4. 终点不吸附到起点所在的节点：自连线在折线路由下没有合理形状。
 * 5. 松手在空白处时留下自由端并通知界面 (onDropOnBlank)，由界面决定是否弹出图形选择；
 *    选中后经 connectNewNode 在该处新建节点并连上，内核不关心界面长什么样。
 * 6. 快速连接点：平时只是四边的小圆点，不抢画面；悬停时放大成「+」并用虚线预览将要新建的节点与连线
 *    (与单击结果完全一致，含被占位时的错开)。单击在该方向新建同类节点 (同尺寸、样式与数据，不带文字) 并连线，
 *    拖动等于从这条边画线；容器 (画框) 与删空即消失的节点 (自由文本) 不显示。
 */

import {
  SELECT_TOOL,
  applyMatrix,
  applyMatrixToVector,
  clonePlainData,
  computeNodeLocalMatrix,
  facingAnchor,
  multiplyMatrix,
  resolveNodeAnchors,
  resolveNodeOutline,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type ConnectorEndpointSnap,
  type ConnectorStyle,
  type CreateNodeRequest,
  type DocumentChangeSet,
  type NodeEntity,
  type Point,
  type PointerHooks,
  type SessionChange,
  type SkyNotePlugin
} from '@skynote/core';
import { isInInstalledLayout } from '../layout/layout-membership';
import { connectorTargetHints, routeOutline } from './connector-hints';

export const CONNECTOR_TOOL_PLUGIN_ID = '@skynote/plugins-basic/connector-tool';
/** 会话中的工具名 */
export const CONNECTOR_TOOL = 'connector';
/** 高于选择 (0)、变换 (50) 与文字编辑 (60)，低于空格平移 (100) */
const CONNECTOR_TOOL_PRIORITY = 80;
const HINT_SESSION = 'connector-tool:hint';
const PLUS_SESSION = 'connector-tool:plus';
/** 拖动不足该屏幕距离视为单击 */
const DRAG_THRESHOLD_PX = 4;
/** 预览线的屏幕线宽 */
const PREVIEW_STROKE_PX = 2;
/** 快速连接点离外框边的屏幕距离、平时与悬停时的半径、命中半径 */
const PLUS_OFFSET_PX = 22;
const PLUS_DOT_RADIUS_PX = 4;
const PLUS_HOVER_RADIUS_PX = 10;
const PLUS_HIT_PX = 12;
/** 悬停预览 (将要新建的节点与连线) 的虚线 */
const PREVIEW_DASH_PX = [5, 4];
/** 快速连接新建的节点与原节点之间的间距 (世界坐标) */
const QUICK_GAP = 100;
/** 「+」的四个方向 (节点局部坐标)：上、右、下、左；连线从最朝向该方向的吸附点出发 */
const SIDES: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
];

interface Draft {
  pointerId: number;
  start: ConnectorEndpointSnap;
  startClient: Point;
  end: ConnectorEndpointSnap;
  dragged: boolean;
  /** 从「+」开始：单击即快速新建，不经连线工具 */
  plus: PlusHandle | null;
}

/** 选中节点某一边的「+」 */
interface PlusHandle {
  nodeId: string;
  side: number;
  /** 「+」的世界坐标 */
  point: Point;
  /** 这一边的吸附点 */
  anchor: ConnectorEndpointSnap;
}

/** 连线松手在空白处 (留下自由端) */
export interface ConnectorDropEvent {
  connectorId: string;
  /** 自由端的世界坐标 */
  point: Point;
}

/** 在连线自由端新建节点的请求：位置由自由端决定 */
export type ConnectNodeRequest = Omit<CreateNodeRequest, 'x' | 'y' | 'origin' | 'parentId'>;

export interface ConnectorToolOptions {
  /** 新连线的线型 (路由器 id)，缺省为折线 */
  connectorType?: string;
  /** 新连线的样式，缺省为终点箭头 */
  style?: ConnectorStyle;
}

export class ConnectorToolPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = CONNECTOR_TOOL_PLUGIN_ID;
  readonly name = '连线工具';
  readonly version = '0.1.0';
  /** 下一条连线的线型：界面在进入工具前设置 (如工具栏选择直线 / 折线 / 曲线) */
  connectorType: string;
  /** 下一条连线的样式：界面在用户改过连线样式后更新 (沿用上次的颜色、粗细、箭头等)，整体替换而不就地修改 */
  style: ConnectorStyle;
  private ctx!: CanvasPluginContext;
  private draft: Draft | null = null;
  private readonly dropListeners = new Set<(e: ConnectorDropEvent) => void>();
  /** 当前显示的「+」 */
  private plusHandles: PlusHandle[] = [];
  private pointerPressed = false;
  private plusCursorSet = false;
  /** 悬停中的快速连接点 (边的序号) */
  private hoveredSide: number | null = null;

  constructor(options: ConnectorToolOptions = {}) {
    this.connectorType = options.connectorType ?? 'orthogonal';
    this.style = options.style ?? { endArrow: true };
  }

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerPointerHooks(this, CONNECTOR_TOOL_PRIORITY);
    ctx.registerInputScope({ id: 'canvas:connector-tool', priority: 10, onKeyDown: (e) => this.onKeyDown(e) });
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  unmount(): void {
    this.draft = null;
    this.dropListeners.clear();
  }

  /** 订阅「连线松手在空白处」：界面据此弹出图形选择，返回注销函数 */
  onDropOnBlank(listener: (e: ConnectorDropEvent) => void): () => void {
    this.dropListeners.add(listener);
    return () => {
      this.dropListeners.delete(listener);
    };
  }

  /**
   * 在连线的自由端新建节点并连上：节点朝向另一端的那条边落在自由端位置，一步撤销，并选中新节点
   * @returns 新节点 id；连线不存在或没有自由端时返回 null
   */
  connectNewNode(connectorId: string, request: ConnectNodeRequest): string | null {
    const { document, connectors, session } = this.ctx;
    const connector = document.getConnector(connectorId);
    const route = connectors.getConnectorRoute(connectorId);
    const end = connector?.to.position ? 'to' : connector?.from.position ? 'from' : null;
    if (!connector || !route || !end) return null;
    const point = connector[end].position!;
    const other = end === 'to' ? route.points[0] : route.points[route.points.length - 1];
    const dx = point.x - other.x;
    const dy = point.y - other.y;
    const dir = Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
    const id = document.batch(() => {
      const nodeId = document.createNode({ ...request, x: point.x, y: point.y, origin: 'center' });
      if (!nodeId) return null;
      const node = document.getNode(nodeId)!;
      document.moveEntities({ nodeIds: [nodeId] }, { x: (dir.x * node.width) / 2, y: (dir.y * node.height) / 2 });
      document.updateConnector(connectorId, { [end]: { nodeId } });
      return nodeId;
    }, request.label ?? '新建并连接');
    if (id) session.setSelection({ nodeIds: [id], connectorIds: [] });
    return id;
  }

  private get active(): boolean {
    return this.ctx.session.tool === CONNECTOR_TOOL;
  }

  onPointerDown(e: CanvasPointerEvent): void {
    this.pointerPressed = true;
    if (e.isClaimed || this.draft || e.button !== 0) {
      this.clearPlus();
      return;
    }
    const plus = this.active ? null : this.hitPlus(e.point);
    this.clearPlus();
    if (!this.active && !plus) return;
    e.claimPointer(CONNECTOR_TOOL_PLUGIN_ID);
    e.stopPropagation();
    const start = plus ? plus.anchor : this.ctx.connectors.snapConnectorEndpoint(e.point);
    this.draft = { pointerId: e.pointerId, start, startClient: e.clientPoint, end: start, dragged: false, plus };
    this.ctx.host.capturePointer(e.pointerId);
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { draft } = this;
    if (draft) {
      if (draft.pointerId !== e.pointerId) return;
      e.stopPropagation();
      this.track(draft, e);
      this.drawDraft(draft);
      return;
    }
    if (!this.active) {
      if (!this.pointerPressed && !e.isClaimed) this.updatePlusCursor(e.point);
      return;
    }
    // 工具激活期间独占悬停：不出现选择工具的悬停高亮与缩放光标
    e.stopPropagation();
    this.ctx.host.setCursor('crosshair');
    const hover = this.ctx.connectors.snapConnectorEndpoint(e.point);
    this.ctx.host.overlay.setPrimitives(
      HINT_SESSION,
      hover.endpoint.nodeId ? connectorTargetHints(this.ctx, hover.endpoint.nodeId, hover) : []
    );
  }

  onPointerUp(e: CanvasPointerEvent): void {
    this.pointerPressed = false;
    const { draft, ctx } = this;
    if (!draft || draft.pointerId !== e.pointerId) {
      this.drawPlus();
      return;
    }
    e.stopPropagation();
    // 以抬起位置为准：松手前的最后一次移动可能与抬起不在同一点
    this.track(draft, e);
    this.finishDraft();
    if (!draft.dragged) {
      if (draft.plus) this.quickConnect(draft.plus);
      this.drawPlus();
      return;
    }
    const id = ctx.document.createConnector({
      connectorType: this.connectorType,
      from: draft.start.endpoint,
      to: draft.end.endpoint,
      style: this.style
    });
    if (!id) return;
    ctx.session.setTool(SELECT_TOOL);
    ctx.session.setSelection({ nodeIds: [], connectorIds: [id] });
    if (draft.end.kind === 'free') {
      for (const listener of this.dropListeners) listener({ connectorId: id, point: draft.end.point });
    }
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    this.pointerPressed = false;
    if (this.draft?.pointerId === e.pointerId) this.finishDraft();
    this.drawPlus();
  }

  onPointerLeave(): void {
    if (this.active && !this.draft) this.ctx.host.overlay.clear(HINT_SESSION);
  }

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (!mod && !e.shiftKey && e.code === 'KeyX' && !this.active) {
      this.ctx.session.setTool(CONNECTOR_TOOL);
      return true;
    }
    if (e.key === 'Escape' && (this.active || this.draft)) {
      // 先取消正在画的连线，再按一次退出工具
      if (this.draft) this.finishDraft();
      else this.ctx.session.setTool(SELECT_TOOL);
      this.drawPlus();
      return true;
    }
    return false;
  }

  private onSessionChange(change: SessionChange): void {
    if (change.toolChanged) {
      if (this.active) {
        this.ctx.host.setCursor('crosshair');
      } else {
        if (this.draft) this.finishDraft();
        this.ctx.host.overlay.clear(HINT_SESSION);
        this.ctx.host.setCursor('default');
      }
    }
    if (
      change.toolChanged ||
      change.toggledNodeIds.size > 0 ||
      change.toggledConnectorIds.size > 0 ||
      change.viewportChanged ||
      change.themeChanged ||
      change.textEditingChanged
    ) {
      this.drawPlus();
    }
  }

  private onDocumentChange(changes: DocumentChangeSet): void {
    const [plus] = this.plusHandles;
    const nodeId =
      plus?.nodeId ?? (this.ctx.session.selectedNodeIds.size === 1 ? [...this.ctx.session.selectedNodeIds][0] : null);
    if (!nodeId) return;
    const { nodes } = changes;
    if (nodes.worldGeometry.has(nodeId) || nodes.data.has(nodeId) || nodes.removed.has(nodeId)) this.drawPlus();
  }

  /** 按指针位置更新终点吸附与是否已拖动 */
  private track(draft: Draft, e: CanvasPointerEvent): void {
    const dx = e.clientPoint.x - draft.startClient.x;
    const dy = e.clientPoint.y - draft.startClient.y;
    draft.dragged ||= Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
    const startNodeId = draft.start.endpoint.nodeId;
    draft.end = this.ctx.connectors.snapConnectorEndpoint(e.point, (node) => node.id !== startNodeId);
  }

  private drawDraft(draft: Draft): void {
    const { ctx } = this;
    const primitives: CanvasPrimitive[] = [];
    if (draft.dragged) {
      const route = ctx.connectors.previewConnectorRoute({
        connectorType: this.connectorType,
        from: draft.start.endpoint,
        to: draft.end.endpoint,
        style: this.style
      });
      if (route) primitives.push(routeOutline(ctx, route, PREVIEW_STROKE_PX));
      const endNodeId = draft.end.endpoint.nodeId;
      if (endNodeId) primitives.push(...connectorTargetHints(ctx, endNodeId, draft.end));
    }
    const startNodeId = draft.start.endpoint.nodeId;
    if (startNodeId) primitives.push(...connectorTargetHints(ctx, startNodeId, draft.start));
    ctx.host.overlay.setPrimitives(HINT_SESSION, primitives, { transient: true });
  }

  private finishDraft(): void {
    if (!this.draft) return;
    this.ctx.host.releasePointer(this.draft.pointerId);
    this.ctx.host.overlay.clear(HINT_SESSION);
    this.draft = null;
  }

  // ==================== 「+」快速连接 ====================

  /**
   * 选择工具下单独选中一个可连接的节点、没有在编辑文字与拖动时，节点四边显示「+」
   * 布局树 (如思维导图) 中的节点不显示：它们的位置与连线由布局决定，新增分支用布局自己的方式 (如 Tab)
   */
  private drawPlus(): void {
    const { ctx } = this;
    const { session } = ctx;
    const previous = this.plusHandles;
    this.plusHandles = [];
    const nodeId = session.selectedNodeIds.size === 1 ? [...session.selectedNodeIds][0] : null;
    const node = nodeId ? ctx.document.getNode(nodeId) : undefined;
    const definition = node && ctx.nodeTypes.get(node.nodeType);
    if (
      !node ||
      node.locked ||
      this.active ||
      this.draft ||
      this.pointerPressed ||
      session.selectedConnectorIds.size > 0 ||
      session.textEditing ||
      definition?.acceptsChildren ||
      definition?.removeWhenEmpty ||
      isInInstalledLayout(ctx, node.id)
    ) {
      this.clearPlus();
      return;
    }
    // 换了节点 (如单击「+」后选中新建的节点)：上一个节点的悬停不延续，鼠标并不在新节点的连接点上
    if (previous[0]?.nodeId !== node.id) this.hoveredSide = null;
    const zoom = session.viewport.zoom;
    const m = ctx.entities.getWorldTransform(node.id)!;
    const anchors = resolveNodeAnchors(node, definition, resolveNodeOutline(node, definition));
    const primitives: CanvasPrimitive[] = [];
    SIDES.forEach((dir, side) => {
      const local = facingAnchor(anchors, dir).point;
      const anchor = applyMatrix(m, local.x, local.y);
      // 「+」放在外框该边中点外侧：星形、三角形的吸附点不在边中点上，「+」仍然排得整齐
      const edge = applyMatrix(m, (node.width / 2) * (1 + dir.x), (node.height / 2) * (1 + dir.y));
      const out = applyMatrixToVector(m, dir.x, dir.y);
      const length = Math.hypot(out.x, out.y) || 1;
      const point = {
        x: edge.x + (out.x / length) * (PLUS_OFFSET_PX / zoom),
        y: edge.y + (out.y / length) * (PLUS_OFFSET_PX / zoom)
      };
      const snap = ctx.connectors.snapConnectorEndpoint(anchor, (n) => n.id === node.id);
      this.plusHandles.push({ nodeId: node.id, side, point, anchor: snap });
      if (side === this.hoveredSide) {
        primitives.unshift(...this.quickPreview(node, side, anchor));
        primitives.push(...plusPrimitives(point, zoom, session.theme.selectionStroke, session.theme.background));
      } else {
        const r = PLUS_DOT_RADIUS_PX / zoom;
        primitives.push({ kind: 'circle', cx: point.x, cy: point.y, r, fill: session.theme.selectionStroke });
      }
    });
    ctx.host.overlay.setPrimitives(PLUS_SESSION, primitives);
  }

  /** 悬停预览：将要新建的节点轮廓与从这条边连过去的线 (虚线) */
  private quickPreview(source: Readonly<NodeEntity>, side: number, anchor: Point): CanvasPrimitive[] {
    const { ctx } = this;
    const { x, y } = this.quickPlacement(source, side);
    const local = computeNodeLocalMatrix({ ...source, x, y });
    const parent = source.parentId === undefined ? undefined : ctx.entities.getWorldTransform(source.parentId);
    const m = parent ? multiplyMatrix(parent, local) : local;
    const definition = ctx.nodeTypes.get(source.nodeType);
    const outline = resolveNodeOutline(source, definition);
    const target = facingAnchor(resolveNodeAnchors(source, definition, outline), SIDES[(side + 2) % 4]).point;
    const end = applyMatrix(m, target.x, target.y);
    const unit = 1 / ctx.session.viewport.zoom;
    const paint = {
      stroke: ctx.session.theme.selectionStroke,
      strokeWidth: 1.5 * unit,
      strokeDashArray: PREVIEW_DASH_PX.map((v) => v * unit)
    };
    return [
      {
        kind: 'polygon',
        points: outline.flatMap((p) => {
          const w = applyMatrix(m, p.x, p.y);
          return [w.x, w.y];
        }),
        ...paint
      },
      { kind: 'line', points: [anchor.x, anchor.y, end.x, end.y], ...paint }
    ];
  }

  /** 不按 plusHandles 判断是否已清除：drawPlus 会先清空列表再决定不显示，此时覆盖层上仍有上一次的图元 */
  private clearPlus(): void {
    this.hoveredSide = null;
    this.plusHandles = [];
    this.ctx.host.overlay.clear(PLUS_SESSION);
  }

  private hitPlus(point: Point): PlusHandle | null {
    const tolerance = PLUS_HIT_PX / this.ctx.session.viewport.zoom;
    return this.plusHandles.find((h) => Math.hypot(h.point.x - point.x, h.point.y - point.y) <= tolerance) ?? null;
  }

  /** 悬停变化时重画 (放大与预览)；只复位自己设过的光标，不覆盖其他插件的悬停光标 */
  private updatePlusCursor(point: Point): void {
    const hit = this.hitPlus(point);
    const side = hit?.side ?? null;
    if (side !== this.hoveredSide) {
      this.hoveredSide = side;
      this.drawPlus();
    }
    if (hit) this.ctx.host.setCursor('crosshair');
    else if (this.plusCursorSet) this.ctx.host.setCursor('default');
    this.plusCursorSet = hit !== null;
  }

  /** 快速新建节点的位置 (父容器局部坐标)：该方向隔开 QUICK_GAP，已被占时继续往外错开 */
  private quickPlacement(source: Readonly<NodeEntity>, side: number): Point {
    const { spatial, entities } = this.ctx;
    const dir = SIDES[side];
    let x = source.x + dir.x * (source.width + QUICK_GAP);
    let y = source.y + dir.y * (source.height + QUICK_GAP);
    // 只在根层级检查占位：容器内的局部坐标与空间索引的世界坐标不同
    for (let i = 0; i < 5 && source.parentId === undefined; i++) {
      const occupied = spatial
        .search({ left: x, top: y, right: x + source.width, bottom: y + source.height })
        .some((id) => entities.getNode(id)?.entity.parentId === undefined);
      if (!occupied) break;
      x += dir.y === 0 ? 0 : source.width + QUICK_GAP / 2;
      y += dir.x === 0 ? 0 : source.height + QUICK_GAP / 2;
    }
    return { x, y };
  }

  /**
   * 单击「+」：在该方向新建同类节点 (同父容器、尺寸、样式与数据，不带文字) 并连线，一步撤销；
   * 该处已有节点时继续往外错开
   */
  private quickConnect(plus: PlusHandle): void {
    const { document, session } = this.ctx;
    const source = document.getNode(plus.nodeId);
    if (!source) return;
    const { x, y } = this.quickPlacement(source, plus.side);
    const id = document.batch(() => {
      const nodeId = document.createNode({
        nodeType: source.nodeType,
        x,
        y,
        width: source.width,
        height: source.height,
        ...(source.parentId !== undefined && { parentId: source.parentId })
      });
      if (!nodeId) return null;
      const copied: Partial<NodeEntity> = {
        ...(source.style && { style: clonePlainData(source.style) as NodeEntity['style'] }),
        ...(source.data && { data: clonePlainData(source.data) as NodeEntity['data'] })
      };
      if (Object.keys(copied).length > 0) document.updateNode(nodeId, copied, { merge: false });
      document.createConnector({
        connectorType: this.connectorType,
        from: { nodeId: source.id },
        to: { nodeId },
        style: this.style
      });
      return nodeId;
    }, '快速连接');
    if (id) session.setSelection({ nodeIds: [id], connectorIds: [] });
  }
}

/** 悬停中的快速连接点：实心圆加反色十字 */
function plusPrimitives(point: Point, zoom: number, fill: string, cross: string): CanvasPrimitive[] {
  const unit = 1 / zoom;
  const arm = 4 * unit;
  const paint = { stroke: cross, strokeWidth: 1.5 * unit, strokeCap: 'round' } as const;
  return [
    { kind: 'circle', cx: point.x, cy: point.y, r: PLUS_HOVER_RADIUS_PX * unit, fill },
    { kind: 'line', points: [point.x - arm, point.y, point.x + arm, point.y], ...paint },
    { kind: 'line', points: [point.x, point.y - arm, point.x, point.y + arm], ...paint }
  ];
}
