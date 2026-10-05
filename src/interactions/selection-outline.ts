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
  replaceText,
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
    if (this.pointerPressed) return;
    const node = this.ctx.hitTestNode(e.point);
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
    const local = nodeTypes.get(node.nodeType)?.outline?.(node as NodeEntity) ?? [
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
    const zoomChanged = change.viewportChanged && this.ctx.session.viewport.zoom !== this.drawnZoom;
    if (this.hoveredId && (change.viewportChanged || this.ctx.session.selectedNodeIds.has(this.hoveredId))) {
      this.setHover(null);
    }
    if (change.toggledNodeIds.size > 0 || zoomChanged || change.themeChanged || change.textEditingChanged) {
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
    const fonts = this.ctx.document.fonts;
    this.drawnZoom = session.viewport.zoom;
    const primitives: CanvasPrimitive[] = [];
    for (const id of session.selectedNodeIds) {
      const runtimeNode = entities.getNode(id);
      if (!runtimeNode) continue;
      const { entity } = runtimeNode;
      let { width, height } = entity;

      // 若节点正在进行画布内文本编辑，且处于输入法组合输入等未提交状态，按包含组合文字的排版尺寸动态绘制外框
      const editing = session.textEditing?.nodeId === id ? session.textEditing : null;
      if (editing?.composition && fonts) {
        const previewNode = this.nodeWithComposition(entity, editing);
        const layoutSize = computeTextLayout(previewNode, nodeTypes.get(entity.nodeType), fonts);
        if (layoutSize) {
          width = layoutSize.width;
          height = layoutSize.height;
        }
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

  /** 将未落盘的输入法组合文字临时注入节点模型，供排版引擎预览外框尺寸 */
  private nodeWithComposition(node: Readonly<NodeEntity>, editing: TextEditingTarget): NodeEntity {
    const { composition } = editing;
    if (!composition || !node.textBlocks) return node as NodeEntity;
    const textBlocks = node.textBlocks.map((block) => {
      if (block.id !== editing.blockId) return block;
      const runs = replaceText(block.runs, composition.offset, composition.offset, composition.text, composition.style);
      return { ...block, runs };
    });
    return { ...node, textBlocks };
  }
}
