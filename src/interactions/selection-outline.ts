/**
 * @file selection-outline.ts
 * @description 选中框与悬停高亮：选中节点沿外框 (含自身与祖先旋转) 描边，悬停节点沿真实轮廓描边，都画在覆盖层 (ADR-110)
 *
 * 设计考量 (Why):
 * 1. 节点渲染不感知选中 (ADR-110)：选中效果全部画在覆盖层，选中与取消选中不触碰任何节点内容。
 * 2. 只在必要时重画：选区变化、缩放变化 (线宽需按缩放换算)、选中节点的世界几何变化或被删除；
 *    平移视口与未选中节点的改动都不重画。
 * 3. 悬停高亮跟随节点类型声明的轮廓 (椭圆、菱形不画成矩形)；按下指针期间 (拖动、框选) 与已选中的节点不显示。
 */

import {
  applyMatrix,
  computeTextLayout,
  resolveTextBlockStyle,
  unionBounds,
  withComposition,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type DocumentChangeSet,
  type NodeEntity,
  type Point,
  type PointerHooks,
  type RectBounds,
  type SessionChange,
  type SkyNotePlugin,
  type TextEditingTarget
} from '@skynote/core';

import { resolveGroupTarget, hitGroupBounds } from './group-selection';

export const SELECTION_OUTLINE_PLUGIN_ID = '@skynote/plugins-basic/selection-outline';
const OUTLINE_SESSION = 'selection:outline';
const HOVER_SESSION = 'selection:hover';
const SUBTREE_HOVER_SESSION = 'selection:subtree-hover';
const HOVER_ROOT_CACHE_LIMIT = 128;
/** 选中框的屏幕线宽 (像素) */
const OUTLINE_WIDTH_PX = 1.5;

export class SelectionOutlinePlugin implements SkyNotePlugin, PointerHooks {
  readonly id = SELECTION_OUTLINE_PLUGIN_ID;
  readonly name = '选中框';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  /** 上次绘制时的缩放：只有缩放变化才需要按新缩放换算线宽 */
  private drawnZoom = 0;
  /** 当前悬停高亮的节点 */
  private hoveredId: string | null = null;
  private hoveredSubtreeId: string | null = null;
  private hoverPoint: Point | null = null;
  private deepHover = false;
  private readonly hoverRoots = new Map<string, string | null>();
  /** 同一脑图有主题选中时，范围提示让位于明确的主题选中框。 */
  private readonly selectedTopicRoots = new Set<string>();
  private pointerPressed = false;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerPointerHooks(this);
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
    ctx.layouts.onChange(() => {
      this.hoverRoots.clear();
      this.refreshSelectedTopicRoots();
      this.refreshHover(true);
    });
    this.refreshSelectedTopicRoots();
  }

  onPointerDown(e?: CanvasPointerEvent): void {
    this.pointerPressed = true;
    this.hoverPoint = e?.point ?? null;
    this.clearHover();
  }

  onPointerMove(e: CanvasPointerEvent): void {
    this.hoverPoint = e.point;
    this.deepHover = e.modifiers.ctrl || e.modifiers.meta;
    this.refreshHover();
  }

  onPointerUp(e?: CanvasPointerEvent): void {
    this.pointerPressed = false;
    if (e) this.hoverPoint = e.point;
    this.refreshHover();
  }

  onPointerCancel(): void {
    this.pointerPressed = false;
    this.hoverPoint = null;
    this.clearHover();
  }

  onPointerLeave(): void {
    this.hoverPoint = null;
    this.clearHover();
  }

  private clearHover(): void {
    this.setHover(null);
    this.setSubtreeHover(null);
  }

  /** 只查询真实命中对象所属的整体，重叠的外部节点不会继承脑图范围提示。 */
  private subtreeRootOf(nodeId: string): string | null {
    const cached = this.hoverRoots.get(nodeId);
    if (cached !== undefined) return cached;
    let root: string | null = null;
    for (
      let node = this.ctx.entities.getNode(nodeId)?.entity;
      node;
      node = node.parentId === undefined ? undefined : this.ctx.entities.getNode(node.parentId)?.entity
    ) {
      if (this.ctx.document.selectionGeometry.canSelectSubtree(node.id)) {
        root = node.id;
        break;
      }
    }
    if (this.hoverRoots.size >= HOVER_ROOT_CACHE_LIMIT) this.hoverRoots.clear();
    this.hoverRoots.set(nodeId, root);
    return root;
  }

  private refreshSelectedTopicRoots(): void {
    this.selectedTopicRoots.clear();
    const visited = new Set<string>();
    for (const id of this.ctx.session.selectedNodeIds) {
      if (this.ctx.session.selectedSubtreeNodeIds.has(id)) continue;
      for (
        let node = this.ctx.entities.getNode(id)?.entity;
        node && !visited.has(node.id);
        node = node.parentId === undefined ? undefined : this.ctx.entities.getNode(node.parentId)?.entity
      ) {
        visited.add(node.id);
        if (this.ctx.document.selectionGeometry.canSelectSubtree(node.id)) this.selectedTopicRoots.add(node.id);
      }
    }
  }

  private refreshHover(force = false): void {
    const { ctx, hoverPoint } = this;
    if (!hoverPoint || this.pointerPressed || ctx.session.isReadOnly) {
      this.clearHover();
      return;
    }
    const hit = ctx.hitTest(hoverPoint);
    const raw = hit?.kind === 'node' ? hit.node : undefined;
    let rootId: string | null = null;
    if (raw) rootId = this.subtreeRootOf(raw.id);
    else if (hit?.kind === 'connector') {
      const { from, to } = hit.connector;
      const fromRoot = from.nodeId === undefined ? null : this.subtreeRootOf(from.nodeId);
      const toRoot = to.nodeId === undefined ? null : this.subtreeRootOf(to.nodeId);
      if (fromRoot === toRoot) rootId = fromRoot;
    } else rootId = ctx.document.selectionGeometry.hitTestSubtree(hoverPoint, 4 / ctx.session.viewport.zoom) ?? null;
    const targetId = raw
      ? resolveGroupTarget(ctx, raw.id, { deep: this.deepHover })
      : !hit && !this.deepHover
        ? hitGroupBounds(ctx, hoverPoint)
        : null;
    const node = targetId ? ctx.entities.getNode(targetId)?.entity : undefined;
    const memberSelected =
      node && [...ctx.session.selectedNodeIds].some((id) => ctx.entities.getAncestorIds(id).includes(node.id));
    this.setHover(node && !memberSelected && !ctx.session.selectedNodeIds.has(node.id) ? node : null, force);
    this.setSubtreeHover(
      rootId && !this.selectedTopicRoots.has(rootId) && !ctx.session.selectedSubtreeNodeIds.has(rootId) ? rootId : null,
      force
    );
  }

  private setSubtreeHover(rootId: string | null, force = false): void {
    if (rootId === this.hoveredSubtreeId && !force) return;
    this.hoveredSubtreeId = rootId;
    const { session, host, document } = this.ctx;
    const b = rootId ? document.selectionGeometry.getSubtreeBounds(rootId) : undefined;
    if (!b) {
      host.overlay.clear(SUBTREE_HOVER_SESSION);
      return;
    }
    const zoom = session.viewport.zoom;
    host.overlay.setPrimitives(SUBTREE_HOVER_SESSION, [
      {
        kind: 'rect',
        x: b.left,
        y: b.top,
        width: b.right - b.left,
        height: b.bottom - b.top,
        stroke: session.theme.selectionStroke,
        strokeOpacity: 0.45,
        strokeWidth: 1 / zoom,
        strokeDashArray: [4 / zoom, 3 / zoom]
      }
    ]);
  }

  /** 沿节点轮廓 (缺省为外框矩形) 画悬停高亮；同一节点不重复绘制 */
  private setHover(node: Readonly<NodeEntity> | null, force = false): void {
    if ((node?.id ?? null) === this.hoveredId && !force) return;
    this.hoveredId = node?.id ?? null;
    const { host, entities, nodeTypes, session } = this.ctx;
    if (!node) {
      host.overlay.clear(HOVER_SESSION);
      return;
    }
    const m = entities.getWorldTransform(node.id)!;
    const local = nodeTypes.getValid(node)?.outline?.(node as NodeEntity) ?? [
      { x: 0, y: 0 },
      { x: node.width, y: 0 },
      { x: node.width, y: node.height },
      { x: 0, y: node.height }
    ];
    host.overlay.setPrimitives(HOVER_SESSION, [
      {
        kind: 'polygon',
        points: local.flatMap((p) => {
          const w = applyMatrix(m, p.x, p.y);
          return [w.x, w.y];
        }),
        stroke: session.theme.selectionStroke,
        strokeWidth: OUTLINE_WIDTH_PX / session.viewport.zoom,
        strokeJoin: 'round'
      }
    ]);
  }

  private onSessionChange(change: SessionChange): void {
    if (change.readOnlyChanged && this.ctx.session.isReadOnly) {
      this.hoverPoint = null;
      this.clearHover();
      this.redraw();
      return;
    }
    const zoomChanged = change.viewportChanged && this.ctx.session.viewport.zoom !== this.drawnZoom;
    const selectionChanged = change.selectionScopeChanged || change.toggledNodeIds.size > 0;
    if (selectionChanged) this.refreshSelectedTopicRoots();
    if (change.viewportChanged) {
      this.hoverPoint = null;
      this.clearHover();
    } else if (selectionChanged || change.themeChanged || change.textEditingChanged || change.readOnlyChanged)
      this.refreshHover(true);
    if (
      change.selectionScopeChanged ||
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
    const { nodes, connectors } = changes;
    const geometryChanged = nodes.worldGeometry.size || nodes.removed.size || nodes.reparented.size;
    if (changes.contentReplaced || nodes.data.size || nodes.added.size || nodes.removed.size || nodes.reparented.size) {
      this.hoverRoots.clear();
      this.refreshSelectedTopicRoots();
    }
    if (geometryChanged || nodes.data.size || connectors.geometry.size || connectors.removed.size)
      this.refreshHover(true);
    if (this.ctx.session.selectedSubtreeNodeIds.size && geometryChanged) {
      this.redraw();
      return;
    }
    for (const id of this.ctx.session.selectedNodeIds) {
      if (changes.nodes.worldGeometry.has(id) || changes.nodes.removed.has(id)) {
        this.redraw();
        return;
      }
    }
  }

  private redraw(): void {
    const { session, entities, host, nodeTypes } = this.ctx;
    if (session.isReadOnly) {
      host.overlay.clear(OUTLINE_SESSION);
      return;
    }
    const fonts = this.ctx.document.fonts;
    this.drawnZoom = session.viewport.zoom;
    const primitives: CanvasPrimitive[] = [];
    let selectionBounds: RectBounds | undefined;
    let count = 0;
    const include = (bounds: RectBounds): void => {
      selectionBounds = selectionBounds ? unionBounds(selectionBounds, bounds) : bounds;
      count++;
    };
    for (const id of session.selectedNodeIds) {
      // 块级选区（如表格单元格）自行展示范围，整节点外框让位于内部选区。
      if (
        session.selectedNodeIds.size === 1 &&
        session.selectedConnectorIds.size === 0 &&
        session.selectedTextBlocks?.nodeId === id &&
        session.selectedTextBlocks.blockIds.size > 0
      )
        continue;
      if (session.selectedSubtreeNodeIds.has(id)) {
        const b = this.ctx.document.selectionGeometry.getSubtreeBounds(id);
        if (b) {
          include(b);
          primitives.push({
            kind: 'rect',
            x: b.left,
            y: b.top,
            width: b.right - b.left,
            height: b.bottom - b.top,
            stroke: session.theme.selectionStroke,
            strokeWidth: OUTLINE_WIDTH_PX / this.drawnZoom
          });
        }
        continue;
      }
      const runtimeNode = entities.getNode(id);
      if (!runtimeNode) continue;
      const { entity } = runtimeNode;
      let { width, height } = entity;

      // 输入法组合文字只在本地显示、尚未写入文档：自适应节点的外框按含组合文字的排版伸缩，不被文字撑出
      const target = session.textEditing;
      const editing = target?.kind === 'node' && target.id === id ? target : null;
      if (editing?.composition && fonts) {
        const size = computeTextLayout(
          this.withComposition(entity, editing),
          nodeTypes.getValid(entity, runtimeNode.runtime.dataVersion),
          fonts
        );
        if (size) ({ width, height } = size);
      }

      const m = entities.getWorldTransform(id)!;
      const corners = [
        applyMatrix(m, 0, 0),
        applyMatrix(m, width, 0),
        applyMatrix(m, width, height),
        applyMatrix(m, 0, height)
      ];
      const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (const p of corners) {
        bounds.left = Math.min(bounds.left, p.x);
        bounds.top = Math.min(bounds.top, p.y);
        bounds.right = Math.max(bounds.right, p.x);
        bounds.bottom = Math.max(bounds.bottom, p.y);
      }
      include(bounds);
      primitives.push({
        kind: 'polygon',
        points: corners.flatMap((p) => [p.x, p.y]),
        stroke: session.theme.selectionStroke,
        strokeWidth: OUTLINE_WIDTH_PX / this.drawnZoom,
        strokeJoin: 'miter'
      });
    }
    // 总外框不依赖变换能力；锁定节点、整图范围和不可缩放节点仍参与多选范围。
    if (count > 1 && selectionBounds) {
      const b = selectionBounds;
      primitives.push({
        kind: 'rect',
        x: b.left,
        y: b.top,
        width: b.right - b.left,
        height: b.bottom - b.top,
        stroke: session.theme.selectionStroke,
        strokeWidth: 1 / this.drawnZoom
      });
    }
    host.overlay.setPrimitives(OUTLINE_SESSION, primitives);
  }

  /** 编辑块插入组合文字后的节点 (只用于测量) */
  private withComposition(node: Readonly<NodeEntity>, editing: TextEditingTarget): NodeEntity {
    const definition = this.ctx.nodeTypes.getValid(node);
    const textBlocks = node.textBlocks!.map((block) =>
      block.id === editing.blockId
        ? {
            ...block,
            runs: [...withComposition(block.runs, editing.composition, resolveTextBlockStyle(node, block, definition))]
          }
        : block
    );
    return { ...node, textBlocks } as NodeEntity;
  }
}
