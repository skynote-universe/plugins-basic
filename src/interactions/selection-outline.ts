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
  withComposition,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type DocumentChangeSet,
  type NodeEntity,
  type PointerHooks,
  type SessionChange,
  type SkyNotePlugin,
  type TextEditingTarget
} from '@skynote/core';

import { resolveGroupTarget } from './group-selection';

export const SELECTION_OUTLINE_PLUGIN_ID = '@skynote/plugins-basic/selection-outline';
const OUTLINE_SESSION = 'selection:outline';
const HOVER_SESSION = 'selection:hover';
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
  private pointerPressed = false;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerPointerHooks(this);
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  onPointerDown(): void {
    this.pointerPressed = true;
    this.setHover(null);
  }

  onPointerMove(e: CanvasPointerEvent): void {
    if (this.pointerPressed || this.ctx.session.isReadOnly) {
      this.setHover(null);
      return;
    }
    const raw = this.ctx.hitTestNode(e.point);
    const targetId = raw ? resolveGroupTarget(this.ctx, raw.id, { deep: e.modifiers.ctrl || e.modifiers.meta }) : null;
    const node = targetId ? (this.ctx.entities.getNode(targetId)?.entity ?? null) : null;
    this.setHover(node && !this.ctx.session.selectedNodeIds.has(node.id) ? node : null);
  }

  onPointerUp(): void {
    this.pointerPressed = false;
  }

  onPointerCancel(): void {
    this.pointerPressed = false;
  }

  /** 沿节点轮廓 (缺省为外框矩形) 画悬停高亮；同一节点不重复绘制 */
  private setHover(node: Readonly<NodeEntity> | null): void {
    if ((node?.id ?? null) === this.hoveredId) return;
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
      this.setHover(null);
      this.redraw();
      return;
    }
    const zoomChanged = change.viewportChanged && this.ctx.session.viewport.zoom !== this.drawnZoom;
    if (this.hoveredId && (change.viewportChanged || this.ctx.session.selectedNodeIds.has(this.hoveredId))) {
      this.setHover(null);
    }
    if (
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
    const { hoveredId } = this;
    if (hoveredId && (changes.nodes.worldGeometry.has(hoveredId) || changes.nodes.removed.has(hoveredId))) {
      this.setHover(null);
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
    for (const id of session.selectedNodeIds) {
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
      primitives.push({
        kind: 'polygon',
        points: corners.flatMap((p) => [p.x, p.y]),
        stroke: session.theme.selectionStroke,
        strokeWidth: OUTLINE_WIDTH_PX / this.drawnZoom,
        strokeJoin: 'miter'
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
