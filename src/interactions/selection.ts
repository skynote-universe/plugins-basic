/**
 * @file selection.ts
 * @description 选择与移动：点选、Shift 加选、框选、拖拽移动
 *
 * 设计考量 (Why):
 * 1. 一个手势状态机处理左键按下后的全部分支：按在节点上是「选中 → 超过阈值后拖拽」，按在空白处是「框选」。
 *    二者共享按下判定，拆成两个插件就要互相探测对方状态，违反插件零感知。
 * 2. 拖拽阈值按屏幕像素判断：单击时手的微小抖动不会产生移动事务，也不会污染撤销栈。
 * 3. 一次拖拽共用一个 groupId，逐帧提交合并为一步撤销；只移动未锁定的最顶层选中节点 (后代随容器移动，ADR-114)。
 * 4. 框选选中与选框相交的根层级节点 (命中容器内部的子节点时选中其所在的根层级容器)，结果可预期；
 *    进入容器内部选择留给双击进入等后续交互。
 * 5. 选区属于会话状态，其他插件 (选中框、快捷键) 只读取会话，不感知本插件。
 */

import {
  generateId,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type NodeEntity,
  type Point,
  type RectBounds,
  type SkyNotePlugin
} from '@skynote/core';

export const SELECTION_PLUGIN_ID = '@skynote/plugins-basic/selection';
const MARQUEE_SESSION = 'selection:marquee';
/** 超过该屏幕距离才视为拖拽 */
const DRAG_THRESHOLD_PX = 3;

type Gesture =
  | {
      kind: 'press';
      pointerId: number;
      startClient: Point;
      lastWorld: Point;
      /** 按下的节点；单击 (未拖拽) 抬起时用于收窄多选 */
      nodeId: string;
      /** 按下前该节点已被选中，且未按 Shift */
      wasSelected: boolean;
      dragging: boolean;
      groupId: string;
    }
  | {
      kind: 'marquee';
      pointerId: number;
      startWorld: Point;
      /** Shift 框选时保留原有选区 */
      baseSelection: ReadonlySet<string>;
    };

function normalizeRect(a: Point, b: Point): RectBounds {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export class SelectionPlugin implements SkyNotePlugin {
  readonly id = SELECTION_PLUGIN_ID;
  readonly name = '选择与移动';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private gesture: Gesture | null = null;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
  }

  unmount(): void {
    this.gesture = null;
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (e.isClaimed || e.button !== 0 || this.gesture) return;
    const node = e.target;
    if (node) {
      this.pressNode(node, e);
    } else {
      const { session } = this.ctx;
      const baseSelection = e.modifiers.shift ? new Set(session.selectedNodeIds) : new Set<string>();
      if (!e.modifiers.shift) session.setSelection({ nodeIds: [], connectorIds: [] });
      this.gesture = { kind: 'marquee', pointerId: e.pointerId, startWorld: e.point, baseSelection };
    }
    if (!this.gesture) return;
    e.claimPointer(SELECTION_PLUGIN_ID);
    this.ctx.host.capturePointer(e.pointerId);
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { gesture, ctx } = this;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    if (gesture.kind === 'marquee') {
      const rect = normalizeRect(gesture.startWorld, e.point);
      this.drawMarquee(rect);
      const hits = new Set(gesture.baseSelection);
      for (const id of ctx.spatial.search(rect)) hits.add(this.rootAncestorOf(id));
      ctx.session.setSelection({ nodeIds: hits, connectorIds: [] });
      return;
    }

    if (!gesture.dragging) {
      const dx = e.clientPoint.x - gesture.startClient.x;
      const dy = e.clientPoint.y - gesture.startClient.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      gesture.dragging = true;
      ctx.host.setCursor('move');
    }
    const movable = [...ctx.session.selectedNodeIds].filter((id) => !ctx.entities.getNode(id)?.entity.locked);
    ctx.document.moveNodes(
      movable,
      { x: e.point.x - gesture.lastWorld.x, y: e.point.y - gesture.lastWorld.y },
      { groupId: gesture.groupId, label: '移动节点' }
    );
    gesture.lastWorld = e.point;
  }

  onPointerUp(e: CanvasPointerEvent): void {
    const { gesture } = this;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    // 在多选中单击其中一个 (未拖拽)：收窄为只选它
    if (gesture.kind === 'press' && !gesture.dragging && gesture.wasSelected) {
      this.ctx.session.setSelection({ nodeIds: [gesture.nodeId], connectorIds: [] });
    }
    this.finish(e.pointerId);
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    // 被系统打断时保留已发生的移动 (与正常松手一致)，只清理手势与瞬态图元
    if (this.gesture && this.gesture.pointerId === e.pointerId) this.finish(e.pointerId);
  }

  private pressNode(node: Readonly<NodeEntity>, e: CanvasPointerEvent): void {
    const { session } = this.ctx;
    const selected = session.selectedNodeIds;
    const wasSelected = selected.has(node.id);
    if (e.modifiers.shift) {
      const next = new Set(selected);
      if (wasSelected) next.delete(node.id);
      else next.add(node.id);
      session.setSelection({ nodeIds: next, connectorIds: [] });
      // Shift 点掉一个节点后不再拖拽它
      if (wasSelected) return;
    } else if (!wasSelected) {
      session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    }
    this.gesture = {
      kind: 'press',
      pointerId: e.pointerId,
      startClient: e.clientPoint,
      lastWorld: e.point,
      nodeId: node.id,
      wasSelected: wasSelected && !e.modifiers.shift,
      dragging: false,
      groupId: generateId('drag')
    };
  }

  private rootAncestorOf(id: string): string {
    const { entities } = this.ctx;
    let node = entities.getNode(id)!.entity;
    while (node.parentId !== undefined) {
      const parent = entities.getNode(node.parentId);
      if (!parent) break;
      node = parent.entity;
    }
    return node.id;
  }

  private drawMarquee(rect: RectBounds): void {
    const { theme, viewport } = this.ctx.session;
    this.ctx.host.overlay.setPrimitives(
      MARQUEE_SESSION,
      [
        {
          kind: 'rect',
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          fill: theme.selectionStroke,
          fillOpacity: 0.08,
          stroke: theme.selectionStroke,
          // 世界坐标中的线宽随缩放换算，屏幕上恒为 1 像素
          strokeWidth: 1 / viewport.zoom
        }
      ],
      { transient: true }
    );
  }

  private finish(pointerId: number): void {
    const { host } = this.ctx;
    host.overlay.clear(MARQUEE_SESSION);
    host.releasePointer(pointerId);
    host.setCursor('default');
    this.gesture = null;
  }
}
