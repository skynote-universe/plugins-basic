/**
 * @file selection.ts
 * @description 选择与移动：点选、Shift 加选、框选、拖拽移动
 *
 * 设计考量 (Why):
 * 1. 一个手势状态机处理左键按下后的全部分支：按在节点上是「选中 → 超过阈值后拖拽」，按在空白处是「框选」。
 *    二者共享按下判定，拆成两个插件就要互相探测对方状态，违反插件零感知。
 * 2. 拖拽阈值按屏幕像素判断：单击时手的微小抖动不会产生移动事务，也不会污染撤销栈。
 * 3. 一次拖拽共用一个 groupId，逐帧提交合并为一步撤销；只移动未锁定的最顶层选中节点 (后代随容器移动，ADR-114)。
 * 4. 拖入拖出容器 (ADR-123)：拖动中高亮指针所在的最上层可接收子节点的容器 (acceptsChildren，排除被拖节点及其后代)，
 *    松手时改挂到该容器，落在空白处移出到根层级；改挂与移动同组提交，一步撤销。只改挂原本位于根层级或可接收容器中的节点，
 *    组合等不接收拖入的父节点中的子节点不会被拖出。
 * 5. 框选选中与选框相交的根层级节点 (命中容器内部的子节点时选中其所在的根层级容器)，结果可预期；
 *    进入容器内部选择留给双击进入等后续交互。连线须整条落在选框内才选中 (与 FigJam 一致)，
 *    否则框选几个节点时会顺带选中穿过选框的长连线。
 * 6. 节点与连线都点中时按画面层叠取最上层 (与渲染同一规则)：穿过画框的连线画在画框之上，点线即选线；
 *    盖住连线的无关节点优先。
 *    拖动时选中连线的自由端与手动拐点随之平移，连在节点上的一端跟随节点。
 * 7. 拖动节点时吸附对齐 (边缘、中心线与等间距，见 snapping.ts)：每帧由「指针相对按下点的位移 + 吸附修正」
 *    算出总位移，再减去已移动的部分提交，吸附不会在逐帧增量里累积漂移；按住 Ctrl / ⌘ 临时关闭。
 * 8. 拖到布局树 (如思维导图) 的节点上即加入该树 (ADR-130)：改挂并补上成员标记 layoutItem，位置交给布局排定；
 *    只在对应布局已安装时生效 (未安装时不排版，加入也没有意义)。
 */

import {
  applyMatrix,
  boundsFromPoints,
  generateId,
  generateNKeysBetween,
  invertMatrix,
  sortSiblingsByLayer,
  unionBounds,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type Point,
  type PointerHooks,
  type RectBounds,
  type SkyNotePlugin
} from '@skynote/core';
import { SNAP_THRESHOLD_PX, collectSnapTargets, drawSnapGuides, type SnapTargets } from './snapping';
import { resolveGroupTarget } from './group-selection';
import { canAcceptLayoutChildren, isInstalledLayoutMember, isStackLayoutMember } from '../layout/layout-membership';
import { STACK_LAYOUT_ID, computeStackInsertIndex } from '../layout/stack-layout';

export const SELECTION_PLUGIN_ID = '@skynote/plugins-basic/selection';
const MARQUEE_SESSION = 'selection:marquee';
const DROP_TARGET_SESSION = 'selection:drop-target';
/** 拖放目标高亮的屏幕线宽 */
const DROP_TARGET_STROKE_PX = 2;
/** 超过该屏幕距离才视为拖拽 */
const DRAG_THRESHOLD_PX = 3;

/** 按下的实体：节点或连线 */
interface PressTarget {
  kind: 'node' | 'connector';
  id: string;
}

type Gesture =
  | {
      kind: 'press';
      pointerId: number;
      startClient: Point;
      startWorld: Point;
      /** 已提交的总位移 */
      moved: Point;
      /** 开始拖动时被拖节点的世界外框与吸附候选；只拖连线时为 null */
      snap: { bounds: RectBounds; targets: SnapTargets } | null;
      /** 按下的实体；单击 (未拖拽) 抬起时用于收窄多选 */
      target: PressTarget;
      /** 按下前该节点已被选中，且未按 Shift */
      wasSelected: boolean;
      dragging: boolean;
      groupId: string;
      /** 拖动中指针所在的可接收容器；undefined 为画布根层级 */
      dropTarget: string | undefined;
    }
  | {
      kind: 'marquee';
      pointerId: number;
      startWorld: Point;
      /** Shift 框选时保留原有选区 */
      baseNodes: ReadonlySet<string>;
      baseConnectors: ReadonlySet<string>;
    };

const selectionKey = (kind: PressTarget['kind']) => (kind === 'node' ? 'nodeIds' : 'connectorIds');

export class SelectionPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = SELECTION_PLUGIN_ID;
  readonly name = '选择与移动';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private gesture: Gesture | null = null;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerPointerHooks(this);
    ctx.onSessionChange((change) => {
      if (change.readOnlyChanged && ctx.session.isReadOnly && this.gesture) {
        this.finish(this.gesture.pointerId);
      }
    });
  }

  unmount(): void {
    if (this.gesture) this.finish(this.gesture.pointerId);
    else this.releaseHeldMembers();
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (this.ctx.session.isReadOnly || e.isClaimed || e.button !== 0 || this.gesture) return;
    const hit = this.ctx.hitTest(e.point);
    const deep = e.modifiers.ctrl || e.modifiers.meta;
    const drillDown = e.clickCount === 2 && !e.modifiers.shift && !deep;
    const target: PressTarget | null =
      hit?.kind === 'connector'
        ? { kind: 'connector', id: hit.connector.id }
        : e.target
          ? { kind: 'node', id: resolveGroupTarget(this.ctx, e.target.id, { deep, drillDown }) }
          : null;
    if (target) {
      this.press(target, e);
    } else {
      const { session } = this.ctx;
      const shift = e.modifiers.shift;
      if (!shift) session.setSelection({ nodeIds: [], connectorIds: [] });
      this.gesture = {
        kind: 'marquee',
        pointerId: e.pointerId,
        startWorld: e.point,
        baseNodes: shift ? new Set(session.selectedNodeIds) : new Set(),
        baseConnectors: shift ? new Set(session.selectedConnectorIds) : new Set()
      };
    }
    if (!this.gesture) return;
    e.claimPointer(SELECTION_PLUGIN_ID);
    this.ctx.host.capturePointer(e.pointerId);
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { gesture, ctx } = this;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    if (gesture.kind === 'marquee') {
      const rect = boundsFromPoints(gesture.startWorld, e.point);
      this.drawMarquee(rect);
      const nodeHits = new Set(gesture.baseNodes);
      for (const id of ctx.spatial.search(rect)) {
        if (!ctx.intersectsNodeBounds(id, rect)) continue;
        nodeHits.add(ctx.entities.getAncestorIds(id).at(-1) ?? id);
      }
      const connectorHits = new Set(gesture.baseConnectors);
      for (const id of ctx.connectors.connectorSpatialIndex.search(rect)) {
        const b = ctx.connectors.getConnectorRoute(id)!.bounds;
        if (b.left >= rect.left && b.right <= rect.right && b.top >= rect.top && b.bottom <= rect.bottom) {
          connectorHits.add(id);
        }
      }
      ctx.session.setSelection({ nodeIds: nodeHits, connectorIds: connectorHits });
      return;
    }

    if (!gesture.dragging) {
      const dx = e.clientPoint.x - gesture.startClient.x;
      const dy = e.clientPoint.y - gesture.startClient.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      gesture.dragging = true;
      ctx.host.setCursor('move');
      gesture.snap = this.prepareSnap();
    }
    const movable = [...ctx.session.selectedNodeIds].filter((id) => !ctx.entities.getNode(id)?.entity.locked);
    // 被拖的堆叠成员跟随指针：托管后仍占据槽位参与排版，但布局派生不把它们排回原位
    ctx.document.holdLayoutMembers(movable.filter((id) => isStackLayoutMember(ctx, id)));
    const total = { x: e.point.x - gesture.startWorld.x, y: e.point.y - gesture.startWorld.y };
    const { snap } = gesture;
    if (snap && !e.modifiers.ctrl && !e.modifiers.meta) {
      const shift = (b: RectBounds, d: Point): RectBounds => ({
        left: b.left + d.x,
        top: b.top + d.y,
        right: b.right + d.x,
        bottom: b.bottom + d.y
      });
      const correction = snap.targets.snapMove(
        shift(snap.bounds, total),
        SNAP_THRESHOLD_PX / ctx.session.viewport.zoom
      );
      total.x += correction.x;
      total.y += correction.y;
      drawSnapGuides(ctx, snap.targets.guides(shift(snap.bounds, total), true));
    } else {
      drawSnapGuides(ctx, null);
    }
    const delta = { x: total.x - gesture.moved.x, y: total.y - gesture.moved.y };
    if (delta.x !== 0 || delta.y !== 0) {
      const freeMovable = movable.filter((id) => !isInstalledLayoutMember(ctx, id) || isStackLayoutMember(ctx, id));
      const connectorIds = [...ctx.session.selectedConnectorIds].filter(
        (id) => !ctx.entities.getConnector(id)?.entity.locked
      );
      if (freeMovable.length > 0 || connectorIds.length > 0) {
        ctx.document.moveEntities({ nodeIds: freeMovable, connectorIds }, delta, {
          groupId: gesture.groupId,
          label: '移动'
        });
      }
      gesture.moved = total;
    }
    if (movable.length > 0) {
      gesture.dropTarget = this.updateDropTarget(movable, e.point);
      this.reorderStackDuringDrag(gesture.dropTarget, e.point, gesture.groupId);
    }
  }

  onPointerUp(e: CanvasPointerEvent): void {
    const { gesture } = this;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    // 在多选中单击其中一个 (未拖拽)：收窄为只选它
    if (gesture.kind === 'press' && !gesture.dragging && gesture.wasSelected) {
      this.ctx.session.setSelection({
        nodeIds: [],
        connectorIds: [],
        [selectionKey(gesture.target.kind)]: [gesture.target.id]
      });
    }
    // 先在托管状态下完成改挂 / 换序 (拖出画框的成员保持松手处的世界位置)，再由 finish 释放并归位
    if (gesture.kind === 'press' && gesture.dragging) {
      this.drop(gesture.dropTarget, e.point, gesture.moved, gesture.groupId);
    }
    this.finish(e.pointerId);
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    // 被系统打断时保留已发生的移动 (与正常松手一致)，清理手势与瞬态图元；finish 会把堆叠成员归位
    if (this.gesture?.pointerId !== e.pointerId) return;
    this.finish(e.pointerId);
  }

  /** 在自动堆叠画框内部拖拽已属于该画框的子成员时，跨过中线实时交换兄弟槽位顺序 */
  private reorderStackDuringDrag(targetId: string | undefined, pointerWorld: Point, groupId: string): void {
    if (targetId === undefined) return;
    const { ctx } = this;
    const targetNode = ctx.document.getNode(targetId);
    if (targetNode?.layout?.type !== STACK_LAYOUT_ID || ctx.layouts.get(STACK_LAYOUT_ID) === undefined) return;

    const memberIds = [...ctx.session.selectedNodeIds].filter((id) => {
      const node = ctx.document.getNode(id);
      return node !== undefined && !node.locked && node.parentId === targetId && node.layoutItem !== undefined;
    });
    if (memberIds.length === 0) return;

    const orderedNodes = sortSiblingsByLayer(memberIds.map((id) => ctx.document.getNode(id)!));
    const orderedIds = orderedNodes.map((n) => n.id);
    const draggedSet = new Set(orderedIds);
    const allCurrentMembers = sortSiblingsByLayer(
      [...ctx.entities.getChildIds(targetId)]
        .map((id) => ctx.document.getNode(id)!)
        .filter((n) => n.layoutItem !== undefined)
    );
    const remainingMembers = allCurrentMembers.filter((n) => !draggedSet.has(n.id));
    if (remainingMembers.length === 0) return;

    const toLocal = invertMatrix(ctx.entities.getWorldTransform(targetId)!);
    const localPoint = applyMatrix(toLocal, pointerWorld.x, pointerWorld.y);
    const insertIndex = computeStackInsertIndex(targetNode, remainingMembers, localPoint);
    const nextMemberIds = [
      ...remainingMembers.slice(0, insertIndex).map((m) => m.id),
      ...orderedIds,
      ...remainingMembers.slice(insertIndex).map((m) => m.id)
    ];
    if (
      allCurrentMembers.length === nextMemberIds.length &&
      allCurrentMembers.every((m, i) => m.id === nextMemberIds[i])
    ) {
      return;
    }

    const prevKey = insertIndex > 0 ? remainingMembers[insertIndex - 1].zIndex : null;
    const nextKey = insertIndex < remainingMembers.length ? remainingMembers[insertIndex].zIndex : null;
    const keys = generateNKeysBetween(prevKey, nextKey, orderedIds.length);
    const keyOf = new Map(orderedIds.map((id, i) => [id, keys[i]]));
    ctx.document.updateNodes(orderedIds, (node) => ({ zIndex: keyOf.get(node.id)! }), {
      groupId,
      label: '调整布局顺序'
    });
  }

  private press(target: PressTarget, e: CanvasPointerEvent): void {
    const { session } = this.ctx;
    const key = selectionKey(target.kind);
    const selected = target.kind === 'node' ? session.selectedNodeIds : session.selectedConnectorIds;
    const wasSelected = selected.has(target.id);
    if (e.modifiers.shift) {
      const next = new Set(selected);
      if (wasSelected) next.delete(target.id);
      else next.add(target.id);
      session.setSelection({ [key]: next });
      // Shift 点掉一个后不再拖拽它
      if (wasSelected) return;
    } else if (!wasSelected) {
      session.setSelection({ nodeIds: [], connectorIds: [], [key]: [target.id] });
    }
    this.gesture = {
      kind: 'press',
      pointerId: e.pointerId,
      startClient: e.clientPoint,
      startWorld: e.point,
      moved: { x: 0, y: 0 },
      snap: null,
      target,
      wasSelected: wasSelected && !e.modifiers.shift,
      dragging: false,
      groupId: generateId('drag'),
      dropTarget: undefined
    };
  }

  /** 被拖的最顶层未锁定节点的整体外框与吸附候选 */
  private prepareSnap(): { bounds: RectBounds; targets: SnapTargets } | null {
    const { ctx } = this;
    const selected = ctx.session.selectedNodeIds;
    const ids = [...selected].filter(
      (id) => !ctx.entities.getNode(id)?.entity.locked && !ctx.entities.getAncestorIds(id).some((a) => selected.has(a))
    );
    if (ids.length === 0) return null;
    const bounds = ids.map((id) => ctx.spatial.getBounds(id)!).reduce(unionBounds);
    return { bounds, targets: collectSnapTargets(ctx, ids) };
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
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
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

  /** 指针所在的最上层可接收容器 (不含被拖节点及其后代)，并高亮其外框 */
  private updateDropTarget(draggedIds: readonly string[], point: Point): string | undefined {
    const { ctx } = this;
    const dragged = new Set(draggedIds);
    const target = ctx.hitTestNode(
      point,
      (node) =>
        (!!ctx.nodeTypes.get(node.nodeType)?.acceptsChildren || canAcceptLayoutChildren(ctx, node.id)) &&
        !dragged.has(node.id) &&
        !ctx.entities.getAncestorIds(node.id).some((id) => dragged.has(id))
    );
    if (!target) {
      ctx.host.overlay.clear(DROP_TARGET_SESSION);
      return undefined;
    }
    const toWorld = ctx.entities.getWorldTransform(target.id)!;
    const { theme, viewport } = ctx.session;
    const corners = [
      applyMatrix(toWorld, 0, 0),
      applyMatrix(toWorld, target.width, 0),
      applyMatrix(toWorld, target.width, target.height),
      applyMatrix(toWorld, 0, target.height)
    ];
    ctx.host.overlay.setPrimitives(
      DROP_TARGET_SESSION,
      [
        {
          kind: 'polygon',
          points: corners.flatMap((p) => [p.x, p.y]),
          stroke: theme.accent,
          strokeWidth: DROP_TARGET_STROKE_PX / viewport.zoom
        }
      ],
      { transient: true }
    );
    return target.id;
  }

  /** 松手：把被拖的节点改挂到拖放目标 (保持在世界中的位置不变) 或在自动堆叠画框内按落点换序并归位，与本次移动同组撤销 */
  private drop(targetId: string | undefined, dropPoint: Point, moved: Point, groupId: string): void {
    const { ctx } = this;
    const targetNode = targetId === undefined ? undefined : ctx.document.getNode(targetId);
    const isStackTarget =
      targetNode?.layout?.type === STACK_LAYOUT_ID && ctx.layouts.get(STACK_LAYOUT_ID) !== undefined;

    if (isStackTarget && targetId !== undefined) {
      const stackIds = [...ctx.session.selectedNodeIds].filter((id) => {
        const node = ctx.entities.getNode(id)?.entity;
        if (!node || node.locked || id === targetId) return false;
        if (node.parentId === targetId) return true;
        const parent = node.parentId === undefined ? undefined : ctx.entities.getNode(node.parentId)?.entity;
        return !parent || !!ctx.nodeTypes.get(parent.nodeType)?.acceptsChildren;
      });
      if (stackIds.length === 0) return;

      const orderedNodes = sortSiblingsByLayer(stackIds.map((id) => ctx.document.getNode(id)!));
      const orderedIds = orderedNodes.map((n) => n.id);
      const stackIdSet = new Set(orderedIds);
      const allCurrentMembers = sortSiblingsByLayer(
        [...ctx.entities.getChildIds(targetId)]
          .map((id) => ctx.document.getNode(id)!)
          .filter((n) => n.layoutItem !== undefined)
      );
      const remainingMembers = allCurrentMembers.filter((n) => !stackIdSet.has(n.id));
      const toLocal = invertMatrix(ctx.entities.getWorldTransform(targetId)!);
      const localPoint = applyMatrix(toLocal, dropPoint.x, dropPoint.y);
      const insertIndex = computeStackInsertIndex(targetNode, remainingMembers, localPoint);
      const enteringIds = orderedIds.filter((id) => ctx.document.getNode(id)?.parentId !== targetId);
      const nextMemberIds = [
        ...remainingMembers.slice(0, insertIndex).map((m) => m.id),
        ...orderedIds,
        ...remainingMembers.slice(insertIndex).map((m) => m.id)
      ];
      if (
        enteringIds.length === 0 &&
        orderedNodes.every((n) => n.layoutItem !== undefined) &&
        allCurrentMembers.length === nextMemberIds.length &&
        allCurrentMembers.every((m, i) => m.id === nextMemberIds[i])
      ) {
        // 顺序未变 (或已在拖拽中实时换序)：无需改写，finish 释放托管成员时会把它们吸附回槽位
        return;
      }

      const prevKey = insertIndex > 0 ? remainingMembers[insertIndex - 1].zIndex : null;
      const nextKey = insertIndex < remainingMembers.length ? remainingMembers[insertIndex].zIndex : null;
      const keys = generateNKeysBetween(prevKey, nextKey, orderedIds.length);
      const keyOf = new Map(orderedIds.map((id, i) => [id, keys[i]]));
      const label = enteringIds.length > 0 ? '加入布局' : '调整布局顺序';

      if (enteringIds.length > 0) {
        ctx.document.reparentNodes(enteringIds, targetId, { groupId, label });
      }
      ctx.document.updateNodes(
        orderedIds,
        (node) => ({
          zIndex: keyOf.get(node.id)!,
          ...(node.layoutItem ? {} : { layoutItem: {} })
        }),
        { groupId, label }
      );
      return;
    }

    const ids = [...ctx.session.selectedNodeIds].filter((id) => {
      const node = ctx.entities.getNode(id)?.entity;
      if (!node || node.locked || node.parentId === targetId) return false;
      // 原父节点不接收拖入 (如组合) 时不把子节点拖出
      const parent = node.parentId === undefined ? undefined : ctx.entities.getNode(node.parentId)?.entity;
      return !parent || !!ctx.nodeTypes.get(parent.nodeType)?.acceptsChildren;
    });
    if (ids.length === 0) return;
    if (targetId === undefined || !canAcceptLayoutChildren(ctx, targetId)) {
      const label = targetId ? '移入容器' : '移出容器';
      const leavingLayoutIds = ids.filter((id) => isInstalledLayoutMember(ctx, id));
      const unmovedLayoutIds = leavingLayoutIds.filter((id) => !isStackLayoutMember(ctx, id));
      ctx.document.reparentNodes(ids, targetId, { groupId, label });
      if (leavingLayoutIds.length > 0) {
        ctx.document.updateNodes(leavingLayoutIds, (node) => (node.layout ? {} : { layoutItem: undefined }), {
          groupId,
          label
        });
        if (unmovedLayoutIds.length > 0 && (moved.x !== 0 || moved.y !== 0)) {
          ctx.document.moveEntities({ nodeIds: unmovedLayoutIds }, moved, { groupId, label });
        }
      }
      return;
    }
    // 加入布局树：改挂并补上成员标记，与本次移动同组撤销
    ctx.document.reparentNodes(ids, targetId, { groupId, label: '加入布局' });
    const joining = ids.filter((id) => !ctx.document.getNode(id)?.layoutItem);
    ctx.document.updateNodes(joining, { layoutItem: {} }, { groupId, label: '加入布局' });
  }

  private finish(pointerId: number): void {
    this.releaseHeldMembers();
    const { host } = this.ctx;
    host.overlay.clear(MARQUEE_SESSION);
    host.overlay.clear(DROP_TARGET_SESSION);
    drawSnapGuides(this.ctx, null);
    host.releasePointer(pointerId);
    host.setCursor('default');
    this.gesture = null;
  }

  /** 释放拖拽中托管的堆叠成员并归位到槽位：与本次拖拽同组撤销；松手、取消、只读切换与卸载都经此收尾 */
  private releaseHeldMembers(): void {
    const groupId = this.gesture?.kind === 'press' ? this.gesture.groupId : undefined;
    this.ctx.document.releaseLayoutMembers({ groupId, label: '移动' });
  }
}
