/**
 * @file transform.ts
 * @description 变换控制柄：缩放 (8 个控制柄) 与旋转 (角外热区)，单选与多选
 *
 * 设计考量 (Why):
 * 1. 控制柄画在覆盖层 (ADR-110)，节点渲染不感知；选中框是矩形，单选时随节点旋转，多选时为轴对齐的整体外框。
 *    只画四角方块，四条边整条可拖但不画方块 (同 Figma、tldraw)，小节点上不会被方块遮住内容。
 * 2. 每一帧都从手势开始时的快照重新计算，不在上一帧结果上累加，拖得再久也没有累积误差；
 *    一次拖拽共用一个 groupId，折叠为一步撤销。
 * 3. 所有节点都可自由缩放 (ADR-121)：锁定比例的节点 (用户锁定或节点类型默认锁定) 拖边、拖角都按等比缩放，
 *    拖边时另一轴以中心为基准；节点类型只声明拖角是否缩放内容与缩放后写入的字段 (applyResize)，插件不写特例。
 * 4. 多选含锁定或旋转节点时整体等比：非等比缩放会把旋转的矩形拉成平行四边形，模型无法表达。
 * 5. 以高于选择与移动 (0) 的优先级接收指针并认领，按在控制柄上时不会同时触发框选或拖动节点。
 * 6. 缩放时被拖的边吸附到附近节点的边缘与中心线 (见 snapping.ts)：被拖的边总是跟着指针走 (按 Alt 时也一样)，
 *    因此修正指针位置即可，后续的等比与夹取照常计算。外框旋转时边不沿世界坐标轴，不吸附；按住 Ctrl / ⌘ 临时关闭。
 */

import { SNAP_THRESHOLD_PX, collectSnapTargets, drawSnapGuides, type SnapTargets } from './snapping';
import {
  GROUP_NODE_TYPE,
  applyMatrix,
  areStructuredValuesEqual,
  clonePlainData,
  computeFrameMatrix,
  computeNodeWorldBounds,
  computeWorldFrame,
  generateId,
  invertMatrix,
  multiplyMatrix,
  isDerivedConnectorId,
  unionBounds,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type DocumentChangeSet,
  type NodeEntity,
  type NodeTransform,
  type NodeScaleSnapshot,
  type NodeConnectorTransformSnapshot,
  type NodeResizePolicy,
  type LayoutDefinition,
  type CanvasOperationRecord,
  type Point,
  type PointerHooks,
  type RectBounds,
  type NodeResizeAxes,
  type ResizeHandle,
  type AngledCursor,
  type SessionChange,
  type SkyNotePlugin,
  type WorldFrame
} from '@skynote/core';
import { isInstalledLayoutMember } from '../layout/layout-membership';

export const TRANSFORM_PLUGIN_ID = '@skynote/plugins-basic/transform';
const HANDLES_SESSION = 'transform:handles';
/** 高于选择与移动 (0)，低于视口平移 (100) */
const TRANSFORM_PRIORITY = 50;
/** 控制柄的屏幕边长 */
const HANDLE_SIZE_PX = 8;
/** 只能调一轴时边中点条形控制柄的屏幕尺寸 (长边沿着所在的边) */
const BAR_LENGTH_PX = 16;
const BAR_THICKNESS_PX = 5;
/** 控制柄与边的屏幕拾取容差 */
const HANDLE_HIT_PX = 6;
/** 角外旋转热区的屏幕半径 */
const ROTATE_ZONE_PX = 20;
/** 缩放后的最小尺寸 (世界单位) */
const MIN_SIZE = 8;
/** Shift 旋转的吸附步长 (度) */
const ROTATE_SNAP = 15;

const ALL_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNERS: readonly ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];
/** 控制柄方位：x / y 为 -1 (左 / 上)、0 (中)、1 (右 / 下) */
const HANDLE_SIGNS: Record<ResizeHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 }
};

interface DefinitionDependencies {
  readonly nodeTypes: ReadonlySet<string>;
  readonly layouts: ReadonlyMap<string, LayoutDefinition | undefined>;
  readonly ancestors: ReadonlyMap<string, Readonly<Pick<NodeEntity, 'parentId' | 'layout' | 'layoutItem'>>>;
}

/** 当前选区的变换外框 */
interface SelectionFrame {
  readonly frame: WorldFrame;
  /** 拖角时等比缩放内容 (单选且节点类型声明时，或组合内含此类节点时) */
  readonly scaleContentOnCorners: boolean;
  readonly handlePolicies: ReadonlyMap<ResizeHandle, Pick<NodeResizePolicy, 'axes' | 'lockAspect'>>;
  readonly resizeDependencies: ReadonlySet<string>;
  readonly groupRoots: ReadonlySet<string>;
  readonly definitions: DefinitionDependencies;
  /** 可旋转：含布局成员时不可 (成员的朝向由布局决定) */
  readonly rotatable: boolean;
  /** 参与旋转的节点 (最顶层、未锁定)，及其开始时的快照与世界外框 */
  readonly targets: readonly { node: NodeEntity; frame: WorldFrame }[];
  /** 参与缩放的节点 (组合展开为其非组合后代)，及其开始时的快照与世界外框 */
  readonly resizeTargets: readonly { node: NodeEntity; frame: WorldFrame }[];
  readonly scaleSnapshots?: ReadonlyMap<string, NodeScaleSnapshot>;
  readonly connectorSnapshot?: NodeConnectorTransformSnapshot;
}

/** 手势只持有实际命中手柄的约束，显示缓存不以任何默认手柄代替其他手柄。 */
interface ResizeSelectionFrame extends SelectionFrame {
  readonly lockAspect: boolean;
  readonly resize: NodeResizeAxes;
  readonly resizePolicies: ReadonlyMap<string, NodeResizePolicy>;
}

type Gesture = (
  | {
      kind: 'resize';
      pointerId: number;
      handle: ResizeHandle;
      start: Point;
      selection: ResizeSelectionFrame;
      groupId: string;
      /** 吸附候选；外框旋转时为 null */
      snap: SnapTargets | null;
    }
  | { kind: 'rotate'; pointerId: number; start: Point; selection: SelectionFrame; groupId: string }
) & {
  readonly trackedNodes: ReadonlySet<string>;
  readonly roots: ReadonlySet<string>;
  readonly trackedConnectors: ReadonlySet<string>;
  readonly definitions: DefinitionDependencies;
  hasMoved?: boolean;
  lastInput?: { x: number; y: number; modifiers: number };
};

type HandleHit = { kind: 'resize'; handle: ResizeHandle } | { kind: 'rotate' };

/** 旋转光标朝向指针相对旋转中心的方位，弧线背向中心 (光标图形 0° 时弧线在左，对应指针在中心左方) */
function rotateCursor(center: Point, point: Point): AngledCursor {
  return { kind: 'rotate', angle: (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI - 180 };
}

function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** 边只能调整其法线方向，角需要两个轴都可调。 */
function canResizeHandle(axes: NodeResizeAxes, handle: ResizeHandle): boolean {
  const sign = HANDLE_SIGNS[handle];
  return axes === 'both' || (axes === 'width' && sign.y === 0) || (axes === 'height' && sign.x === 0);
}

export class TransformPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = TRANSFORM_PLUGIN_ID;
  readonly name = '变换控制柄';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private gesture: Gesture | null = null;
  /** 选区外框缓存：悬停时每次指针移动都要拾取控制柄，只在选区或选中节点变化时重算 */
  private selectionCache: SelectionFrame | null | undefined = undefined;
  /** 悬停在控制柄上时设置过光标，离开时需要复位 */
  private hoverCursorSet = false;
  /** 上次绘制时的缩放：控制柄屏幕尺寸固定，只有缩放变化才需要重画 */
  private drawnZoom = 0;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerPointerHooks(this, TRANSFORM_PRIORITY);
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes, record) => this.onDocumentChange(changes, record));
    ctx.nodeTypes.onChange((type) => this.onNodeTypeChange(type));
    ctx.layouts.onChange(() => this.onLayoutsChange());
    this.redraw();
  }

  unmount(): void {
    if (this.gesture) this.finish(this.gesture.pointerId);
    else if (this.hoverCursorSet) this.ctx.host.setCursor('default');
    this.hoverCursorSet = false;
    this.selectionCache = undefined;
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (this.ctx.session.isReadOnly || e.isClaimed || e.button !== 0 || this.gesture) return;
    const selection = this.selection;
    const hit = selection && this.hitHandle(selection, e.point);
    if (!selection || !hit) return;
    // 实体会被字段级补丁就地修改，快照必须深拷贝，否则每帧都在上一帧的结果上叠加 (如字号越拖越大)
    const resizing = hit.kind === 'resize';
    const policy = resizing
      ? this.resolveSelectionResizePolicy(
          selection.targets,
          selection.frame.rotation,
          hit.handle,
          selection.targets.length === 1
        )
      : undefined;
    // 显示缓存不承担授权；捕获指针前再次校验当前手柄，失效策略不能进入手势快照。
    if (hit.kind === 'resize' && policy && !canResizeHandle(policy.axes, hit.handle)) {
      this.selectionCache = undefined;
      this.redraw();
      return;
    }
    e.claimPointer(TRANSFORM_PLUGIN_ID);
    this.ctx.host.capturePointer(e.pointerId);
    let snapshot: SelectionFrame = {
      ...selection,
      targets: selection.targets.map(({ node, frame }) => ({ node: resizing ? clonePlainData(node) : node, frame })),
      scaleSnapshots: new Map(
        selection.targets
          .filter(
            ({ node }) =>
              resizing &&
              (node.nodeType === GROUP_NODE_TYPE || this.ctx.nodeTypes.get(node.nodeType)?.supportsContentScale)
          )
          .map(({ node }) => {
            const boundsOnly =
              policy?.nodes.get(node.id)?.behavior === 'resize-bounds' && node.nodeType !== GROUP_NODE_TYPE;
            const ids = [
              node.id,
              ...(boundsOnly ? this.ctx.entities.getChildIds(node.id) : this.ctx.entities.collectDescendantIds(node.id))
            ];
            const inside = new Set(ids);
            const connectorIds = new Set(
              boundsOnly ? [] : ids.flatMap((id) => [...this.ctx.entities.getConnectorIdsOfNode(id)])
            );
            return [
              node.id,
              {
                nodes: new Map(
                  ids.map((id) => {
                    const entity = this.ctx.entities.getNode(id)!.entity;
                    return [
                      id,
                      {
                        node: boundsOnly ? { ...entity } : clonePlainData(entity),
                        frame: computeWorldFrame(entity, this.ctx.entities.getWorldTransform(id)!)
                      }
                    ];
                  })
                ),
                connectors: new Map(
                  (boundsOnly ? [] : [...connectorIds])
                    .filter((id) => !isDerivedConnectorId(id))
                    .map((id) => this.ctx.document.getConnector(id))
                    .filter(
                      (connector) =>
                        connector !== undefined &&
                        inside.has(connector.from.nodeId!) &&
                        inside.has(connector.to.nodeId!)
                    )
                    .map((connector) => [connector!.id, clonePlainData(connector!)])
                )
              }
            ];
          })
      )
    };
    const roots = new Set(selection.targets.map(({ node }) => node.id));
    if (!resizing) {
      snapshot = {
        ...snapshot,
        connectorSnapshot: this.ctx.document.captureConnectorTransformSnapshot(roots, selection.frame)
      };
    }
    const trackedNodes = new Set(roots);
    const trackedConnectors = new Set<string>();
    for (const scope of snapshot.scaleSnapshots!.values()) {
      for (const id of scope.nodes.keys()) trackedNodes.add(id);
      for (const id of scope.connectors.keys()) trackedConnectors.add(id);
    }
    if (snapshot.connectorSnapshot) {
      for (const id of snapshot.connectorSnapshot.nodeIds) trackedNodes.add(id);
      for (const id of snapshot.connectorSnapshot.controlPoints.keys()) trackedConnectors.add(id);
    }
    const definitionNodes = new Set(selection.resizeDependencies);
    for (const id of trackedNodes) definitionNodes.add(id);
    const base = {
      pointerId: e.pointerId,
      start: e.point,
      selection: snapshot,
      groupId: generateId('transform'),
      roots,
      trackedNodes,
      trackedConnectors,
      definitions: this.resolveDefinitionDependencies(definitionNodes, roots)
    };
    this.gesture =
      hit.kind === 'resize'
        ? {
            ...base,
            ...hit,
            selection: {
              ...snapshot,
              lockAspect: policy!.lockAspect,
              resize: policy!.axes,
              resizePolicies: policy!.nodes
            },
            snap:
              selection.frame.rotation % 360 === 0
                ? collectSnapTargets(
                    this.ctx,
                    selection.targets.map(({ node }) => node.id)
                  )
                : null
          }
        : { ...base, ...hit };
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { gesture } = this;
    if (!gesture) {
      this.updateHoverCursor(e);
      return;
    }
    if (gesture.pointerId !== e.pointerId) return;
    // 首次同点输入不调用缩放 hook；与可因视口变化失效的重复输入缓存独立。
    if (!gesture.hasMoved) {
      if (e.point.x === gesture.start.x && e.point.y === gesture.start.y) return;
      gesture.hasMoved = true;
    }
    const modifiers =
      Number(e.modifiers.shift) |
      (Number(e.modifiers.alt) << 1) |
      (Number(e.modifiers.ctrl) << 2) |
      (Number(e.modifiers.meta) << 3);
    if (
      gesture.lastInput?.x === e.point.x &&
      gesture.lastInput.y === e.point.y &&
      gesture.lastInput.modifiers === modifiers
    )
      return;
    let transforms: NodeTransform[];
    if (gesture.kind === 'resize') {
      const snap = e.modifiers.ctrl || e.modifiers.meta ? null : gesture.snap;
      const resized = this.computeResize(gesture.selection, gesture.handle, gesture.start, e, snap);
      transforms = resized.transforms;
      drawSnapGuides(this.ctx, snap && snap.guides(resized.bounds, false));
    } else {
      transforms = this.computeRotate(gesture.selection, gesture.start, e);
    }
    this.ctx.document.transformNodes(transforms, {
      groupId: gesture.groupId,
      label: gesture.kind === 'resize' ? '缩放节点' : '旋转节点'
    });
    if (this.gesture !== gesture) return;
    gesture.lastInput = { x: e.point.x, y: e.point.y, modifiers };
    // 旋转中光标跟随指针转动 (旋转中心即手势开始时的外框中心)
    if (gesture.kind === 'rotate') {
      const { cx, cy } = gesture.selection.frame;
      this.ctx.host.setCursor(rotateCursor({ x: cx, y: cy }, e.point));
    }
  }

  onPointerUp(e: CanvasPointerEvent): void {
    if (this.gesture?.pointerId === e.pointerId) this.finish(e.pointerId);
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    if (this.gesture?.pointerId === e.pointerId) this.finish(e.pointerId);
  }

  private finish(pointerId: number): void {
    drawSnapGuides(this.ctx, null);
    this.ctx.host.releasePointer(pointerId);
    this.ctx.host.setCursor('default');
    this.hoverCursorSet = false;
    this.gesture = null;
  }

  // ================= 选区外框 =================

  /** 当前选区的变换外框 (缓存)；选区为空或全部锁定时为 null */
  private get selection(): SelectionFrame | null {
    if (this.selectionCache === undefined) this.selectionCache = this.resolveSelection();
    return this.selectionCache;
  }

  private resolveSelection(): SelectionFrame | null {
    const { session, entities, nodeTypes } = this.ctx;
    // 整体选区移动/排列不等于修改根主题的尺寸，首版不提供根节点控制柄。
    if (session.selectedSubtreeNodeIds.size > 0) return null;
    // 画布内编辑文字时不显示控制柄：按在文字上是定位光标而不是缩放
    if (session.textEditing) return null;
    const selected = session.selectedNodeIds;
    const targets: { node: NodeEntity; frame: WorldFrame }[] = [];
    const resizeTargets: { node: NodeEntity; frame: WorldFrame }[] = [];
    const resizeDependencies = new Set<string>();
    const groupRoots = new Set<string>();
    const coveredAncestors = new Map<string, boolean>();
    for (const id of selected) {
      const runtime = entities.getNode(id);
      if (!runtime) continue;
      // 锁定目标不能从多选中剔除后单独变换其余节点，否则控制柄与总外框不再代表同一选区。
      if (runtime.entity.locked) return null;
      // 只取最顶层目标；共享父链缓存“自身或祖先已选中”，避免逐目标构造完整祖先数组。
      const path: string[] = [];
      let parentId = runtime.entity.parentId;
      let covered = false;
      while (parentId !== undefined) {
        const cached = coveredAncestors.get(parentId);
        if (cached !== undefined) {
          covered = cached;
          break;
        }
        const parent = entities.getNode(parentId);
        if (!parent) break;
        path.push(parentId);
        if (selected.has(parentId)) {
          covered = true;
          break;
        }
        parentId = parent.entity.parentId;
      }
      for (const ancestorId of path) coveredAncestors.set(ancestorId, covered);
      if (covered) continue;
      const item = { node: runtime.entity, frame: computeWorldFrame(runtime.entity, entities.getWorldTransform(id)!) };
      targets.push(item);
      resizeDependencies.add(id);
      if (runtime.entity.nodeType === GROUP_NODE_TYPE) {
        groupRoots.add(id);
        this.collectGroupResizeTargets(id, resizeTargets, resizeDependencies);
      } else {
        resizeTargets.push(item);
      }
    }
    if (targets.length === 0) return null;
    const definitions = this.resolveDefinitionDependencies(
      resizeDependencies,
      targets.map(({ node }) => node.id)
    );

    if (targets.length === 1) {
      const [{ node, frame }] = targets;
      const definition = nodeTypes.get(node.nodeType);
      const isGroup = node.nodeType === GROUP_NODE_TYPE;
      const handlePolicies = this.resolveHandlePolicies(targets, frame.rotation);
      const scaleContentOnCorners =
        (definition?.scaleContentOnCorners ?? false) ||
        (isGroup && resizeTargets.some(({ node: child }) => nodeTypes.get(child.nodeType)?.scaleContentOnCorners));
      return {
        frame,
        scaleContentOnCorners,
        handlePolicies,
        resizeDependencies,
        groupRoots,
        definitions,
        rotatable: !isInstalledLayoutMember(this.ctx, node.id),
        targets,
        resizeTargets: resizeTargets.length > 0 ? resizeTargets : targets
      };
    }

    let bounds = computeNodeWorldBounds(targets[0].node, entities.getWorldTransform(targets[0].node.id)!);
    for (let i = 1; i < targets.length; i++) {
      bounds = unionBounds(
        bounds,
        computeNodeWorldBounds(targets[i].node, entities.getWorldTransform(targets[i].node.id)!)
      );
    }
    const effectiveResizeTargets = resizeTargets.length > 0 ? resizeTargets : targets;
    const handlePolicies = this.resolveHandlePolicies(targets, 0);
    return {
      frame: {
        cx: (bounds.left + bounds.right) / 2,
        cy: (bounds.top + bounds.bottom) / 2,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
        rotation: 0
      },
      scaleContentOnCorners: false,
      handlePolicies,
      resizeDependencies,
      groupRoots,
      definitions,
      rotatable: !targets.some(({ node }) => isInstalledLayoutMember(this.ctx, node.id)),
      targets,
      resizeTargets: effectiveResizeTargets
    };
  }

  private resolveDefinitionDependencies(nodeIds: Iterable<string>, roots: Iterable<string>): DefinitionDependencies {
    const nodeTypes = new Set<string>();
    const layouts = new Map<string, LayoutDefinition | undefined>();
    for (const id of nodeIds) {
      const node = this.ctx.document.getNode(id);
      if (!node) continue;
      nodeTypes.add(node.nodeType);
      if (node.layout) layouts.set(node.layout.type, this.ctx.layouts.get(node.layout.type));
    }
    // 共享祖先只访问一次；布局晚注册或卸载可能改变成员旋转约束，却没有任何文档补丁。
    const ancestors = new Map<string, Readonly<Pick<NodeEntity, 'parentId' | 'layout' | 'layoutItem'>>>();
    for (const id of roots) {
      let parentId = this.ctx.document.getNode(id)?.parentId;
      while (parentId !== undefined && !ancestors.has(parentId)) {
        const parent = this.ctx.document.getNode(parentId);
        if (!parent) break;
        // 字段级补丁可就地修改嵌套配置，只保留布局语义的独立快照，不复制祖先文本或其他内容。
        ancestors.set(
          parentId,
          clonePlainData({ parentId: parent.parentId, layout: parent.layout, layoutItem: parent.layoutItem })
        );
        if (parent.layout) layouts.set(parent.layout.type, this.ctx.layouts.get(parent.layout.type));
        parentId = parent.parentId;
      }
    }
    return { nodeTypes, layouts, ancestors };
  }

  private ancestorLayoutChanged(dependencies: DefinitionDependencies, changes: DocumentChangeSet): boolean {
    if (dependencies.ancestors.size === 0) return false;
    for (const ids of [changes.nodes.data, changes.nodes.reparented, changes.nodes.removed]) {
      for (const id of ids) {
        const previous = dependencies.ancestors.get(id);
        if (!previous) continue;
        const node = this.ctx.document.getNode(id);
        if (
          !node ||
          previous.parentId !== node.parentId ||
          !areStructuredValuesEqual(previous.layout, node.layout) ||
          !areStructuredValuesEqual(previous.layoutItem, node.layoutItem)
        )
          return true;
      }
    }
    return false;
  }

  private onNodeTypeChange(type: string): void {
    const gestureAffected = this.gesture?.definitions.nodeTypes.has(type);
    const selectionAffected = this.selectionCache?.definitions.nodeTypes.has(type);
    if (gestureAffected && this.gesture) this.finish(this.gesture.pointerId);
    if (gestureAffected || selectionAffected) {
      this.selectionCache = undefined;
      this.redraw();
    }
  }

  private onLayoutsChange(): void {
    const changed = (dependencies: DefinitionDependencies | undefined): boolean => {
      if (dependencies)
        for (const [type, definition] of dependencies.layouts) {
          if (this.ctx.layouts.get(type) !== definition) return true;
        }
      return false;
    };
    const gestureAffected = changed(this.gesture?.definitions);
    const selectionAffected = changed(this.selectionCache?.definitions);
    if (gestureAffected && this.gesture) this.finish(this.gesture.pointerId);
    if (gestureAffected || selectionAffected) {
      this.selectionCache = undefined;
      this.redraw();
    }
  }

  private resolveHandlePolicies(
    targets: readonly { node: NodeEntity; frame: WorldFrame }[],
    rotation: number
  ): ReadonlyMap<ResizeHandle, Pick<NodeResizePolicy, 'axes' | 'lockAspect'>> {
    if (targets.length === 1) {
      const [{ node }] = targets;
      const varying = node.nodeType !== GROUP_NODE_TYPE && this.ctx.nodeTypes.get(node.nodeType)?.getResizeBehavior;
      const common = varying ? undefined : this.ctx.document.getNodeResizePolicy(node.id);
      return new Map(
        ALL_HANDLES.map((handle) => {
          const policy = common ?? this.ctx.document.getNodeResizePolicy(node.id, 'pointer', handle);
          return [handle, { axes: policy.axes, lockAspect: policy.lockAspect }];
        })
      );
    }
    const common: (typeof targets)[number][] = [];
    const varying: (typeof targets)[number][] = [];
    for (const target of targets) {
      // Group 的行为固定；其成员约束只查询一次，不能因八个手柄重复展开后代。
      const perHandle =
        target.node.nodeType !== GROUP_NODE_TYPE && this.ctx.nodeTypes.get(target.node.nodeType)?.getResizeBehavior;
      (perHandle ? varying : common).push(target);
    }
    const base = this.resolveSelectionResizePolicy(common, rotation, 'se');
    const commonPolicy = { axes: base.axes, lockAspect: base.lockAspect };
    const policies = new Map<ResizeHandle, Pick<NodeResizePolicy, 'axes' | 'lockAspect'>>();
    for (const handle of ALL_HANDLES) {
      if (varying.length === 0) {
        policies.set(handle, commonPolicy);
        continue;
      }
      const next = this.resolveSelectionResizePolicy(varying, rotation, handle);
      const width = (base.axes === 'both' || base.axes === 'width') && (next.axes === 'both' || next.axes === 'width');
      const height =
        (base.axes === 'both' || base.axes === 'height') && (next.axes === 'both' || next.axes === 'height');
      const lockAspect = base.lockAspect || next.lockAspect;
      const axes =
        lockAspect && (!width || !height) ? 'none' : width ? (height ? 'both' : 'width') : height ? 'height' : 'none';
      policies.set(handle, { axes, lockAspect });
    }
    return policies;
  }

  /** 多选和组合取成员可调轴的交集；旋转或等比约束无法保持受限轴时不提供整体缩放。 */
  private resolveSelectionResizePolicy(
    targets: readonly { node: NodeEntity; frame: WorldFrame }[],
    rotation: number,
    handle: ResizeHandle,
    singleSelection = false
  ): { nodes: ReadonlyMap<string, NodeResizePolicy>; axes: NodeResizeAxes; lockAspect: boolean } {
    const nodes = new Map<string, NodeResizePolicy>();
    // 单选直接遵守节点策略；可调单轴优先于比例锁定，多选才需要合并集合约束。
    if (singleSelection) {
      const id = targets[0].node.id;
      const policy = this.ctx.document.getNodeResizePolicy(id, 'pointer', handle);
      nodes.set(id, policy);
      return { nodes, axes: policy.axes, lockAspect: policy.lockAspect };
    }
    let lockAspect = false;
    let width = true;
    let height = true;
    for (const { node, frame } of targets) {
      const policy = this.ctx.document.getNodeResizePolicy(node.id, 'pointer', handle);
      nodes.set(node.id, policy);
      const axes = policy.axes;
      lockAspect ||= policy.lockAspect || Math.abs((frame.rotation - rotation) % 360) > 1e-4;
      if (axes !== 'both' && Math.abs((frame.rotation - rotation) % 180) > 1e-4) {
        width = false;
        height = false;
      }
      width &&= axes === 'both' || axes === 'width';
      height &&= axes === 'both' || axes === 'height';
    }
    const axes =
      lockAspect && (!width || !height) ? 'none' : width ? (height ? 'both' : 'width') : height ? 'height' : 'none';
    return { nodes, axes, lockAspect };
  }

  /** 非组合容器作为整体缩放叶子；迭代收集依赖，避免组合深度占用调用栈。 */
  private collectGroupResizeTargets(
    groupId: string,
    out: { node: NodeEntity; frame: WorldFrame }[],
    dependencies: Set<string>
  ): void {
    const { entities } = this.ctx;
    const groups = [groupId];
    for (let i = 0; i < groups.length; i++) {
      for (const childId of entities.getChildIds(groups[i])) {
        dependencies.add(childId);
        const childRuntime = entities.getNode(childId);
        if (!childRuntime || childRuntime.entity.locked) continue;
        const child = childRuntime.entity;
        if (child.nodeType === GROUP_NODE_TYPE) {
          groups.push(child.id);
        } else {
          out.push({ node: child, frame: computeWorldFrame(child, entities.getWorldTransform(child.id)!) });
        }
      }
    }
  }

  /** 控制柄在外框局部坐标中的位置 */
  private handlePosition(frame: WorldFrame, handle: ResizeHandle): Point {
    const sign = HANDLE_SIGNS[handle];
    return { x: ((sign.x + 1) / 2) * frame.width, y: ((sign.y + 1) / 2) * frame.height };
  }

  /**
   * 只能调一轴时只有该轴的两条边 (没有角，角会暗示宽高都能调)；
   * 否则屏幕上过窄的外框只保留角控制柄，避免边控制柄与角重叠而无法拖动
   */
  private visibleHandles(selection: SelectionFrame): readonly ResizeHandle[] {
    const zoom = this.ctx.session.viewport.zoom;
    const narrow = selection.frame.width * zoom < HANDLE_SIZE_PX * 3;
    const short = selection.frame.height * zoom < HANDLE_SIZE_PX * 3;
    const handles = ALL_HANDLES.filter((handle) => canResizeHandle(selection.handlePolicies.get(handle)!.axes, handle));
    const hasCorners = handles.some((handle) => CORNERS.includes(handle));
    return handles.filter((handle) => {
      if (!hasCorners || selection.handlePolicies.get(handle)!.axes !== 'both') return true;
      const sign = HANDLE_SIGNS[handle];
      return !((sign.x === 0 && narrow) || (sign.y === 0 && short));
    });
  }

  /** 拾取控制柄：先角后边 (边控制柄沿整条边都可拖)，都未命中时检查角外旋转热区 */
  private hitHandle(selection: SelectionFrame, point: Point): HandleHit | null {
    const zoom = this.ctx.session.viewport.zoom;
    const { frame } = selection;
    const local = applyMatrix(invertMatrix(computeFrameMatrix(frame)), point.x, point.y);
    const tolerance = HANDLE_HIT_PX / zoom;
    const handles = this.visibleHandles(selection);

    for (const handle of handles) {
      if (!CORNERS.includes(handle)) continue;
      const p = this.handlePosition(frame, handle);
      if (Math.abs(local.x - p.x) <= tolerance && Math.abs(local.y - p.y) <= tolerance)
        return { kind: 'resize', handle };
    }
    for (const handle of handles) {
      const sign = HANDLE_SIGNS[handle];
      if (sign.x !== 0 && sign.y !== 0) continue;
      const onVertical =
        sign.x !== 0 &&
        Math.abs(local.x - this.handlePosition(frame, handle).x) <= tolerance &&
        local.y >= 0 &&
        local.y <= frame.height;
      const onHorizontal =
        sign.y !== 0 &&
        Math.abs(local.y - this.handlePosition(frame, handle).y) <= tolerance &&
        local.x >= 0 &&
        local.x <= frame.width;
      if (onVertical || onHorizontal) return { kind: 'resize', handle };
    }

    const outside = local.x < 0 || local.x > frame.width || local.y < 0 || local.y > frame.height;
    if (!outside || !selection.rotatable) return null;
    const rotateZone = ROTATE_ZONE_PX / zoom;
    for (const corner of CORNERS) {
      const p = this.handlePosition(frame, corner);
      if (Math.hypot(local.x - p.x, local.y - p.y) <= rotateZone) return { kind: 'rotate' };
    }
    return null;
  }

  // ================= 缩放 =================

  /**
   * 在外框自身坐标轴中计算新外框：对侧 (或按 Alt 时的中心) 固定，拖动侧跟随指针
   * 再把每个节点从旧外框映射到新外框
   * @param snap 吸附候选 (只在外框未旋转时提供，此时局部坐标轴与世界坐标轴同向)
   * @returns 各节点的变换与新外框的世界范围 (外框旋转时该范围无意义，只在吸附时使用)
   */
  private computeResize(
    selection: ResizeSelectionFrame,
    handle: ResizeHandle,
    start: Point,
    e: CanvasPointerEvent,
    snap: SnapTargets | null
  ): { transforms: NodeTransform[]; bounds: RectBounds } {
    const { frame } = selection;

    // 1. [局部坐标投影] 将指针位移转换至外框局部坐标系；被拖的边吸附时修正指针位置
    const toLocal = invertMatrix(computeFrameMatrix(frame));
    const p0 = applyMatrix(toLocal, start.x, start.y);
    const p = applyMatrix(toLocal, e.point.x, e.point.y);
    const sign = HANDLE_SIGNS[handle];
    if (snap) {
      const threshold = SNAP_THRESHOLD_PX / this.ctx.session.viewport.zoom;
      if (sign.x !== 0) p.x += snap.snapEdge('x', frame.cx + (sign.x * frame.width) / 2 + p.x - p0.x, threshold);
      if (sign.y !== 0) p.y += snap.snapEdge('y', frame.cy + (sign.y * frame.height) / 2 + p.y - p0.y, threshold);
    }
    const fromCenter = e.modifiers.alt;
    const factor = fromCenter ? 2 : 1;

    // 2. [缩放比例与尺寸夹取] 依据等比锁定与 Shift 修饰键换算目标宽高与缩放倍数
    // 只能调一轴的节点 (另一轴由内容决定)：拖角与等比修饰键都只改可调的一轴
    const { resize } = selection;
    let width = sign.x === 0 || resize === 'height' ? frame.width : frame.width + sign.x * (p.x - p0.x) * factor;
    let height = sign.y === 0 || resize === 'width' ? frame.height : frame.height + sign.y * (p.y - p0.y) * factor;
    const isCorner = sign.x !== 0 && sign.y !== 0;
    const uniform =
      resize === 'both' && (selection.lockAspect || e.modifiers.shift || (isCorner && selection.scaleContentOnCorners));
    const hasW = frame.width > 0;
    const hasH = frame.height > 0;
    let scale = 1;
    if (uniform) {
      if (hasW && hasH) {
        // 取变化更大的一轴决定整体倍数；边控制柄只看被拖动的那一轴
        scale =
          sign.x === 0
            ? height / frame.height
            : sign.y === 0
              ? width / frame.width
              : Math.max(width / frame.width, height / frame.height);
        scale = Math.max(scale, MIN_SIZE / Math.min(frame.width, frame.height));
      } else if (hasW) {
        scale = Math.max(width / frame.width, MIN_SIZE / frame.width);
      } else if (hasH) {
        scale = Math.max(height / frame.height, MIN_SIZE / frame.height);
      } else {
        const delta = Math.hypot(p.x - p0.x, p.y - p0.y) * factor;
        scale = Math.max(0.1, (MIN_SIZE + delta) / MIN_SIZE);
      }
      width = frame.width * scale;
      height = frame.height * scale;
    } else {
      width = Math.max(MIN_SIZE, width);
      height = Math.max(MIN_SIZE, height);
    }

    // 3. [外框锚定与节点映射] 计算新外框基准点，并将各选中节点相对映射到新外框中
    const left = fromCenter || sign.x === 0 ? (frame.width - width) / 2 : sign.x > 0 ? 0 : frame.width - width;
    const top = fromCenter || sign.y === 0 ? (frame.height - height) / 2 : sign.y > 0 ? 0 : frame.height - height;
    const fromOld = computeFrameMatrix(frame);
    const kx = hasW ? width / frame.width : scale;
    const ky = hasH ? height / frame.height : scale;
    const { nodeTypes } = this.ctx;
    const origin = applyMatrix(fromOld, left, top);

    const single = selection.targets.length === 1;
    const transforms = selection.targets.map(({ node, frame: nodeFrame }) => {
      // 节点中心在旧外框局部坐标中的位置，按两轴比例映射到新外框
      const c = applyMatrix(toLocal, nodeFrame.cx, nodeFrame.cy);
      const center = applyMatrix(fromOld, left + c.x * kx, top + c.y * ky);
      const nextFrame: WorldFrame = {
        cx: center.x,
        cy: center.y,
        width: single ? width : nodeFrame.width * kx,
        height: single ? height : nodeFrame.height * ky,
        rotation: nodeFrame.rotation
      };
      const definition = nodeTypes.get(node.nodeType);
      const scaleContents =
        !!definition?.supportsContentScale && selection.resizePolicies.get(node.id)?.behavior === 'scale-contents';
      // 整体缩放的字段由内核统一生成（包括回退 hook），交互层不提前重复计算。
      const fields = !scaleContents
        ? definition?.applyResize?.(node, {
            // 多选或组合整体等比缩放时，对每个节点而言等同于拖角
            handle: single || !uniform ? handle : 'se',
            width: nextFrame.width,
            height: nextFrame.height,
            scale: uniform ? scale : 1
          })
        : undefined;
      return {
        id: node.id,
        frame: nextFrame,
        fields,
        scaleContents,
        preserveContents:
          !!nodeTypes.get(node.nodeType)?.supportsContentScale &&
          selection.resizePolicies.get(node.id)?.behavior === 'resize-bounds',
        scaleSnapshot: selection.scaleSnapshots?.get(node.id)
      };
    });
    return {
      transforms,
      bounds: { left: origin.x, top: origin.y, right: origin.x + width, bottom: origin.y + height }
    };
  }

  // ================= 旋转 =================

  /** 绕外框中心旋转：Shift 按 15° 吸附外框的最终角度 */
  private computeRotate(selection: SelectionFrame, start: Point, e: CanvasPointerEvent): NodeTransform[] {
    const { frame } = selection;
    const center = { x: frame.cx, y: frame.cy };

    // 1. [角度差计算] 计算当前指针与起始点的极角差，处理 Shift 步进吸附
    let delta =
      ((Math.atan2(e.point.y - center.y, e.point.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x)) *
        180) /
      Math.PI;
    if (e.modifiers.shift) delta = Math.round((frame.rotation + delta) / ROTATE_SNAP) * ROTATE_SNAP - frame.rotation;
    delta = Math.round(frame.rotation + delta) - frame.rotation;
    const connectorTransform = selection.connectorSnapshot && {
      snapshot: selection.connectorSnapshot,
      matrix: multiplyMatrix(
        computeFrameMatrix({ ...frame, rotation: frame.rotation + delta }),
        invertMatrix(computeFrameMatrix(frame))
      )
    };

    // 2. [节点外框重定位] 围绕整体外框中心公转并自转每个选中的目标节点
    return selection.targets.map(({ node, frame: nodeFrame }) => {
      const c = rotatePoint({ x: nodeFrame.cx, y: nodeFrame.cy }, center, delta);
      return {
        id: node.id,
        frame: { ...nodeFrame, cx: c.x, cy: c.y, rotation: nodeFrame.rotation + delta },
        connectorTransform
      };
    });
  }

  // ================= 光标与绘制 =================

  /** 悬停在控制柄上时显示对应光标 (缩放光标精确对准控制柄方向，随外框旋转)，离开时复位 */
  private updateHoverCursor(e: CanvasPointerEvent): void {
    if (this.ctx.session.isReadOnly) {
      if (this.hoverCursorSet) this.ctx.host.setCursor('default');
      this.hoverCursorSet = false;
      return;
    }
    const selection = this.selection;
    const hit = selection && !e.isClaimed ? this.hitHandle(selection, e.point) : null;
    if (!selection || !hit) {
      if (this.hoverCursorSet) this.ctx.host.setCursor('default');
      this.hoverCursorSet = false;
      return;
    }
    this.hoverCursorSet = true;
    if (hit.kind === 'rotate') {
      this.ctx.host.setCursor(rotateCursor({ x: selection.frame.cx, y: selection.frame.cy }, e.point));
      return;
    }
    const sign = HANDLE_SIGNS[hit.handle];
    const angle = (Math.atan2(sign.y, sign.x) * 180) / Math.PI + selection.frame.rotation;
    this.ctx.host.setCursor({ kind: 'resize', angle });
  }

  private onSessionChange(change: SessionChange): void {
    if (change.readOnlyChanged && this.ctx.session.isReadOnly) {
      if (this.gesture) this.finish(this.gesture.pointerId);
      this.selectionCache = undefined;
      this.redraw();
      return;
    }
    const selectionChanged =
      change.selectionScopeChanged ||
      change.toggledNodeIds.size > 0 ||
      change.textEditingChanged ||
      change.readOnlyChanged;
    if (selectionChanged && this.gesture) this.finish(this.gesture.pointerId);
    if (change.viewportChanged && this.gesture) this.gesture.lastInput = undefined;
    if (selectionChanged) this.selectionCache = undefined;
    // 平移不改变世界坐标中的控制柄，只有缩放 (控制柄屏幕尺寸固定) 需要重画
    const zoomChanged = change.viewportChanged && this.ctx.session.viewport.zoom !== this.drawnZoom;
    if (selectionChanged || zoomChanged || change.themeChanged) this.redraw();
  }

  private onDocumentChange(changes: DocumentChangeSet, record: CanvasOperationRecord): void {
    const gesture = this.gesture;
    if (gesture && !(record.origin === 'local' && record.groupId === gesture.groupId)) {
      // 外部事务改变手势作用域时保留已提交结果并结束手势，不用旧快照覆盖远端结构或内容。
      const related = (id: string): boolean =>
        gesture.trackedNodes.has(id) ||
        this.ctx.entities.getAncestorIds(id).some((parent) => gesture.roots.has(parent));
      const affectsNodes = (ids: ReadonlySet<string>): boolean => {
        for (const id of ids) if (related(id)) return true;
        return false;
      };
      const affectsConnectors = (ids: ReadonlySet<string>): boolean => {
        for (const id of ids) {
          if (gesture.trackedConnectors.has(id)) return true;
          if (isDerivedConnectorId(id)) continue;
          const connector = this.ctx.document.getConnector(id);
          if (
            connector?.from.nodeId &&
            connector.to.nodeId &&
            gesture.trackedNodes.has(connector.from.nodeId) &&
            gesture.trackedNodes.has(connector.to.nodeId)
          )
            return true;
        }
        return false;
      };
      const interrupted =
        changes.contentReplaced ||
        this.ancestorLayoutChanged(gesture.definitions, changes) ||
        gesture.selection.targets.some(({ node }) => changes.nodes.worldGeometry.has(node.id)) ||
        affectsNodes(changes.nodes.geometry) ||
        affectsNodes(changes.nodes.data) ||
        affectsNodes(changes.nodes.removed) ||
        affectsConnectors(changes.connectors.geometry) ||
        affectsConnectors(changes.connectors.data) ||
        affectsConnectors(changes.connectors.removed);
      if (interrupted) this.finish(gesture.pointerId);
    }
    // 成员几何或结构变化也可能只改变策略；保留旧依赖集合才能识别已删除和移出的成员。
    const selected = this.ctx.session.selectedNodeIds;
    const cached = this.selectionCache;
    if (cached) {
      if (this.ancestorLayoutChanged(cached.definitions, changes)) {
        this.selectionCache = undefined;
        this.redraw();
        return;
      }
      for (const ids of [changes.nodes.geometry, changes.nodes.data, changes.nodes.removed, changes.nodes.reparented]) {
        for (const id of ids) {
          if (
            cached.resizeDependencies.has(id) ||
            (cached.groupRoots.size > 0 &&
              this.ctx.entities.getAncestorIds(id).some((parent) => cached.groupRoots.has(parent)))
          ) {
            this.selectionCache = undefined;
            this.redraw();
            return;
          }
        }
      }
    }
    for (const id of selected) {
      if (changes.nodes.worldGeometry.has(id) || changes.nodes.removed.has(id) || changes.nodes.data.has(id)) {
        this.selectionCache = undefined;
        this.redraw();
        return;
      }
    }
  }

  /**
   * 角控制柄为随外框旋转的小方块 (屏幕尺寸固定)；选区外框由选区描边插件独立绘制。
   * 只能调一轴时改为在该轴两条边的中点画条形控制柄，一眼看出只能沿这一轴拉伸
   */
  private redraw(): void {
    const { session, host } = this.ctx;
    const { selection } = this;
    if (!selection || session.isReadOnly) {
      host.overlay.clear(HANDLES_SESSION);
      return;
    }
    const { theme, viewport } = session;
    this.drawnZoom = viewport.zoom;
    const toWorld = computeFrameMatrix(selection.frame);
    const strokeWidth = 1 / viewport.zoom;
    const half = HANDLE_SIZE_PX / 2 / viewport.zoom;
    const primitives: CanvasPrimitive[] = [];
    const { frame } = selection;
    // 条形控制柄不超过所在边长度的一半 (缩小视图时外框很矮也不会溢出)
    const along = (side: number) => Math.min(BAR_LENGTH_PX / 2 / viewport.zoom, side / 4);
    const across = BAR_THICKNESS_PX / 2 / viewport.zoom;
    const available = this.visibleHandles(selection);
    const hasCorners = available.some((handle) => CORNERS.includes(handle));
    const handles = available
      .filter((handle) => CORNERS.includes(handle) || !hasCorners)
      .map((handle) =>
        CORNERS.includes(handle)
          ? { handle, hx: half, hy: half }
          : HANDLE_SIGNS[handle].x === 0
            ? { handle, hx: along(frame.width), hy: across }
            : { handle, hx: across, hy: along(frame.height) }
      );
    for (const { handle, hx, hy } of handles) {
      const p = this.handlePosition(frame, handle);
      const square = [
        applyMatrix(toWorld, p.x - hx, p.y - hy),
        applyMatrix(toWorld, p.x + hx, p.y - hy),
        applyMatrix(toWorld, p.x + hx, p.y + hy),
        applyMatrix(toWorld, p.x - hx, p.y + hy)
      ];
      primitives.push({
        kind: 'polygon',
        points: square.flatMap((q) => [q.x, q.y]),
        fill: theme.background,
        stroke: theme.selectionStroke,
        strokeWidth,
        strokeJoin: 'miter'
      });
    }
    host.overlay.setPrimitives(HANDLES_SESSION, primitives);
  }
}
