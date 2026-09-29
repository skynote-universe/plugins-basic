/**
 * @file selection-outline.ts
 * @description 选中框：沿每个选中节点的真实外框 (含自身与祖先旋转) 绘制描边，画在覆盖层 (ADR-110)
 *
 * 设计考量 (Why):
 * 1. 节点渲染不感知选中 (ADR-110)：选中效果全部画在覆盖层，选中与取消选中不触碰任何节点内容。
 * 2. 只在必要时重画：选区变化、缩放变化 (线宽需按缩放换算)、选中节点的世界几何变化或被删除；
 *    平移视口与未选中节点的改动都不重画。
 */

import {
  applyMatrix,
  type CanvasPluginContext,
  type CanvasPrimitive,
  type DocumentChangeSet,
  type SessionChange,
  type SkyNotePlugin
} from '@skynote/core';

export const SELECTION_OUTLINE_PLUGIN_ID = '@skynote/plugins-basic/selection-outline';
const OUTLINE_SESSION = 'selection:outline';
/** 选中框的屏幕线宽 (像素) */
const OUTLINE_WIDTH_PX = 1.5;

export class SelectionOutlinePlugin implements SkyNotePlugin {
  readonly id = SELECTION_OUTLINE_PLUGIN_ID;
  readonly name = '选中框';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  /** 上次绘制时的缩放：只有缩放变化才需要按新缩放换算线宽 */
  private drawnZoom = 0;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  private onSessionChange(change: SessionChange): void {
    const zoomChanged = change.viewportChanged && this.ctx.session.viewport.zoom !== this.drawnZoom;
    if (change.toggledNodeIds.size > 0 || zoomChanged || change.themeChanged) this.redraw();
  }

  private onDocumentChange(changes: DocumentChangeSet): void {
    for (const id of this.ctx.session.selectedNodeIds) {
      if (changes.nodes.worldGeometry.has(id) || changes.nodes.removed.has(id)) {
        this.redraw();
        return;
      }
    }
  }

  private redraw(): void {
    const { session, entities, host } = this.ctx;
    this.drawnZoom = session.viewport.zoom;
    const primitives: CanvasPrimitive[] = [];
    for (const id of session.selectedNodeIds) {
      const runtimeNode = entities.getNode(id);
      if (!runtimeNode) continue;
      const { width, height } = runtimeNode.entity;
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
}
