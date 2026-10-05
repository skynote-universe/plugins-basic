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
 */

import {
  applyMatrix,
  clonePlainData,
  computeFrameMatrix,
  computeNodeWorldBounds,
  computeWorldFrame,
  generateId,
  invertMatrix,
  isAspectLocked,
  unionBounds,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type DocumentChangeSet,
  type NodeEntity,
  type NodeTransform,
  type Point,
  type PointerHooks,
  type ResizeHandle,
  type SessionChange,
  type SkyNotePlugin,
  type SystemCursor,
  type WorldFrame
} from '@skynote/core';

export const TRANSFORM_PLUGIN_ID = '@skynote/plugins-basic/transform';
const HANDLES_SESSION = 'transform:handles';
/** 高于选择与移动 (0)，低于视口平移 (100) */
const TRANSFORM_PRIORITY = 50;
/** 控制柄的屏幕边长 */
const HANDLE_SIZE_PX = 8;
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
/** 按屏幕方向角 (0° 为向右，每 45° 一档) 取缩放光标 */
const RESIZE_CURSORS: readonly SystemCursor[] = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
/** 8 档方向角旋转光标 (0° ~ 315°，步长 45°) */
const ROTATE_CURSORS: readonly SystemCursor[] = [
  'rotate-0',
  'rotate-45',
  'rotate-90',
  'rotate-135',
  'rotate-180',
  'rotate-225',
  'rotate-270',
  'rotate-315'
];

/** 当前选区的变换外框 */
interface SelectionFrame {
  readonly frame: WorldFrame;
  /** 比例锁定：拖边、拖角都按等比缩放 */
  readonly lockAspect: boolean;
  /** 拖角时等比缩放内容 (单选且节点类型声明时) */
  readonly scaleContentOnCorners: boolean;
  /** 参与变换的节点 (最顶层、未锁定)，及其开始时的快照与世界外框 */
  readonly targets: readonly { node: NodeEntity; frame: WorldFrame }[];
}

type Gesture =
  | {
      kind: 'resize';
      pointerId: number;
      handle: ResizeHandle;
      start: Point;
      selection: SelectionFrame;
      groupId: string;
    }
  | {
      kind: 'rotate';
      pointerId: number;
      corner: ResizeHandle;
      start: Point;
      selection: SelectionFrame;
      groupId: string;
    };

type HandleHit = { kind: 'resize'; handle: ResizeHandle } | { kind: 'rotate'; corner: ResizeHandle };

function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
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
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  unmount(): void {
    this.gesture = null;
    this.selectionCache = undefined;
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (e.isClaimed || e.button !== 0 || this.gesture) return;
    const selection = this.selection;
    const hit = selection && this.hitHandle(selection, e.point);
    if (!selection || !hit) return;
    e.claimPointer(TRANSFORM_PLUGIN_ID);
    this.ctx.host.capturePointer(e.pointerId);
    // 实体会被字段级补丁就地修改，快照必须深拷贝，否则每帧都在上一帧的结果上叠加 (如字号越拖越大)
    const snapshot: SelectionFrame = {
      ...selection,
      targets: selection.targets.map(({ node, frame }) => ({ node: clonePlainData(node), frame }))
    };
    this.gesture = {
      ...hit,
      pointerId: e.pointerId,
      start: e.point,
      selection: snapshot,
      groupId: generateId('transform')
    };
    if (hit.kind === 'rotate') {
      this.ctx.host.setCursor('default');
    }
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { gesture } = this;
    if (!gesture) {
      this.updateHoverCursor(e);
      return;
    }
    if (gesture.pointerId !== e.pointerId) return;
    const transforms =
      gesture.kind === 'resize'
        ? this.computeResize(gesture.selection, gesture.handle, gesture.start, e)
        : this.computeRotate(gesture.selection, gesture.start, e);
    this.ctx.document.transformNodes(transforms, {
      groupId: gesture.groupId,
      label: gesture.kind === 'resize' ? '缩放节点' : '旋转节点'
    });
  }

  onPointerUp(e: CanvasPointerEvent): void {
    if (this.gesture?.pointerId === e.pointerId) this.finish(e.pointerId);
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    if (this.gesture?.pointerId === e.pointerId) this.finish(e.pointerId);
  }

  private finish(pointerId: number): void {
    this.ctx.host.releasePointer(pointerId);
    this.ctx.host.setCursor('default');
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
    // 画布内编辑文字时不显示控制柄：按在文字上是定位光标而不是缩放
    if (session.textEditing) return null;
    const selected = session.selectedNodeIds;
    const targets: { node: NodeEntity; frame: WorldFrame }[] = [];
    for (const id of selected) {
      const runtime = entities.getNode(id);
      // 后代随容器变换，只取最顶层的选中节点
      if (!runtime || runtime.entity.locked || entities.getAncestorIds(id).some((a) => selected.has(a))) continue;
      targets.push({ node: runtime.entity, frame: computeWorldFrame(runtime.entity, entities.getWorldTransform(id)!) });
    }
    if (targets.length === 0) return null;

    if (targets.length === 1) {
      const [{ node, frame }] = targets;
      const definition = nodeTypes.get(node.nodeType);
      return {
        frame,
        lockAspect: isAspectLocked(node, definition),
        scaleContentOnCorners: definition?.scaleContentOnCorners ?? false,
        targets
      };
    }

    let bounds = computeNodeWorldBounds(targets[0].node, entities.getWorldTransform(targets[0].node.id)!);
    for (let i = 1; i < targets.length; i++) {
      bounds = unionBounds(
        bounds,
        computeNodeWorldBounds(targets[i].node, entities.getWorldTransform(targets[i].node.id)!)
      );
    }
    const lockAspect = targets.some(
      ({ node, frame }) => frame.rotation % 360 !== 0 || isAspectLocked(node, nodeTypes.get(node.nodeType))
    );
    return {
      frame: {
        cx: (bounds.left + bounds.right) / 2,
        cy: (bounds.top + bounds.bottom) / 2,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
        rotation: 0
      },
      lockAspect,
      scaleContentOnCorners: false,
      targets
    };
  }

  /** 控制柄在外框局部坐标中的位置 */
  private handlePosition(frame: WorldFrame, handle: ResizeHandle): Point {
    const sign = HANDLE_SIGNS[handle];
    return { x: ((sign.x + 1) / 2) * frame.width, y: ((sign.y + 1) / 2) * frame.height };
  }

  /** 屏幕上过窄的外框只保留角控制柄，避免边控制柄与角重叠而无法拖动 */
  private visibleHandles(selection: SelectionFrame): ResizeHandle[] {
    const zoom = this.ctx.session.viewport.zoom;
    const narrow = selection.frame.width * zoom < HANDLE_SIZE_PX * 3;
    const short = selection.frame.height * zoom < HANDLE_SIZE_PX * 3;
    return ALL_HANDLES.filter((handle) => {
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
    if (!outside) return null;
    const rotateZone = ROTATE_ZONE_PX / zoom;
    for (const corner of CORNERS) {
      const p = this.handlePosition(frame, corner);
      if (Math.hypot(local.x - p.x, local.y - p.y) <= rotateZone) return { kind: 'rotate', corner };
    }
    return null;
  }

  // ================= 缩放 =================

  /**
   * 在外框自身坐标轴中计算新外框：对侧 (或按 Alt 时的中心) 固定，拖动侧跟随指针
   * 再把每个节点从旧外框映射到新外框
   */
  private computeResize(
    selection: SelectionFrame,
    handle: ResizeHandle,
    start: Point,
    e: CanvasPointerEvent
  ): NodeTransform[] {
    const { frame } = selection;

    // 1. [局部坐标投影] 将指针位移转换至外框局部坐标系
    const toLocal = invertMatrix(computeFrameMatrix(frame));
    const p0 = applyMatrix(toLocal, start.x, start.y);
    const p = applyMatrix(toLocal, e.point.x, e.point.y);
    const sign = HANDLE_SIGNS[handle];
    const fromCenter = e.modifiers.alt;
    const factor = fromCenter ? 2 : 1;

    // 2. [缩放比例与尺寸夹取] 依据等比锁定与 Shift 修饰键换算目标宽高与缩放倍数
    let width = sign.x === 0 ? frame.width : frame.width + sign.x * (p.x - p0.x) * factor;
    let height = sign.y === 0 ? frame.height : frame.height + sign.y * (p.y - p0.y) * factor;
    const isCorner = sign.x !== 0 && sign.y !== 0;
    const uniform = selection.lockAspect || e.modifiers.shift || (isCorner && selection.scaleContentOnCorners);
    let scale = 1;
    if (uniform) {
      // 取变化更大的一轴决定整体倍数；边控制柄只看被拖动的那一轴
      scale =
        sign.x === 0
          ? height / frame.height
          : sign.y === 0
            ? width / frame.width
            : Math.max(width / frame.width, height / frame.height);
      scale = Math.max(scale, MIN_SIZE / Math.min(frame.width, frame.height));
      width = frame.width * scale;
      height = frame.height * scale;
    } else {
      width = Math.max(MIN_SIZE, width);
      height = Math.max(MIN_SIZE, height);
    }

    // 像素对齐约束：当外框无旋转时，四舍五入为纯整数像素尺寸
    if (frame.rotation === 0) {
      width = Math.max(MIN_SIZE, Math.round(width));
      height = Math.max(MIN_SIZE, Math.round(height));
      if (uniform && frame.width > 0) {
        scale = width / frame.width;
      }
    }

    // 3. [外框锚定与节点映射] 计算新外框基准点，并将各选中节点相对映射到新外框中
    const left = fromCenter || sign.x === 0 ? (frame.width - width) / 2 : sign.x > 0 ? 0 : frame.width - width;
    const top = fromCenter || sign.y === 0 ? (frame.height - height) / 2 : sign.y > 0 ? 0 : frame.height - height;
    const fromOld = computeFrameMatrix(frame);
    const kx = width / frame.width;
    const ky = height / frame.height;
    const { nodeTypes } = this.ctx;

    return selection.targets.map(({ node, frame: nodeFrame }) => {
      // 节点中心在旧外框局部坐标中的位置，按两轴比例映射到新外框
      const c = applyMatrix(toLocal, nodeFrame.cx, nodeFrame.cy);
      const center = applyMatrix(fromOld, left + c.x * kx, top + c.y * ky);
      const single = selection.targets.length === 1;
      const targetWidth = single
        ? width
        : frame.rotation === 0
          ? Math.round(nodeFrame.width * kx)
          : nodeFrame.width * kx;
      const targetHeight = single
        ? height
        : frame.rotation === 0
          ? Math.round(nodeFrame.height * ky)
          : nodeFrame.height * ky;
      const nextFrame: WorldFrame = {
        cx: center.x,
        cy: center.y,
        width: targetWidth,
        height: targetHeight,
        rotation: nodeFrame.rotation
      };
      const fields = nodeTypes.get(node.nodeType)?.applyResize?.(node, {
        // 多选整体等比缩放时，对每个节点而言等同于拖角
        handle: single || !uniform ? handle : 'se',
        width: nextFrame.width,
        height: nextFrame.height,
        scale: uniform ? scale : 1
      });
      return { id: node.id, frame: nextFrame, fields };
    });
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

    // 2. [节点外框重定位] 围绕整体外框中心公转并自转每个选中的目标节点
    return selection.targets.map(({ node, frame: nodeFrame }) => {
      const c = rotatePoint({ x: nodeFrame.cx, y: nodeFrame.cy }, center, delta);
      return { id: node.id, frame: { ...nodeFrame, cx: c.x, cy: c.y, rotation: nodeFrame.rotation + delta } };
    });
  }

  // ================= 光标与绘制 =================

  /** 悬停在控制柄上时显示对应光标 (方向随外框旋转取最接近的一档)，离开时复位 */
  private updateHoverCursor(e: CanvasPointerEvent): void {
    const selection = this.selection;
    const hit = selection && !e.isClaimed ? this.hitHandle(selection, e.point) : null;
    if (!selection || !hit) {
      if (this.hoverCursorSet) this.ctx.host.setCursor('default');
      this.hoverCursorSet = false;
      return;
    }
    this.hoverCursorSet = true;
    if (hit.kind === 'rotate') {
      const center = { x: selection.frame.cx, y: selection.frame.cy };
      const pointerAngle = (Math.atan2(e.point.y - center.y, e.point.x - center.x) * 180) / Math.PI;
      const relAngle = pointerAngle - 180;
      const step = ((Math.round(relAngle / 45) % 8) + 8) % 8;
      this.ctx.host.setCursor(ROTATE_CURSORS[step]);
      return;
    }
    const sign = HANDLE_SIGNS[hit.handle];
    const angle = (Math.atan2(sign.y, sign.x) * 180) / Math.PI + selection.frame.rotation;
    const step = ((Math.round(angle / 45) % 4) + 4) % 4;
    this.ctx.host.setCursor(RESIZE_CURSORS[step]);
  }

  private onSessionChange(change: SessionChange): void {
    const selectionChanged = change.toggledNodeIds.size > 0 || change.textEditingChanged;
    if (selectionChanged) this.selectionCache = undefined;
    // 平移不改变世界坐标中的控制柄，只有缩放 (控制柄屏幕尺寸固定) 需要重画
    const zoomChanged = change.viewportChanged && this.ctx.session.viewport.zoom !== this.drawnZoom;
    if (selectionChanged || zoomChanged || change.themeChanged) this.redraw();
  }

  private onDocumentChange(changes: DocumentChangeSet): void {
    for (const id of this.ctx.session.selectedNodeIds) {
      if (changes.nodes.worldGeometry.has(id) || changes.nodes.removed.has(id) || changes.nodes.data.has(id)) {
        this.selectionCache = undefined;
        this.redraw();
        return;
      }
    }
  }

  /** 多选时画整体外框；角控制柄为随外框旋转的小方块 (屏幕尺寸固定) */
  private redraw(): void {
    const { session, host } = this.ctx;
    const { selection } = this;
    if (!selection) {
      host.overlay.clear(HANDLES_SESSION);
      return;
    }
    const { theme, viewport } = session;
    this.drawnZoom = viewport.zoom;
    const toWorld = computeFrameMatrix(selection.frame);
    const strokeWidth = 1 / viewport.zoom;
    const half = HANDLE_SIZE_PX / 2 / viewport.zoom;
    const primitives: CanvasPrimitive[] = [];
    if (selection.targets.length > 1) {
      const corners = CORNERS.map((corner) => {
        const p = this.handlePosition(selection.frame, corner);
        return applyMatrix(toWorld, p.x, p.y);
      });
      primitives.push({
        kind: 'polygon',
        points: corners.flatMap((p) => [p.x, p.y]),
        stroke: theme.selectionStroke,
        strokeWidth,
        strokeJoin: 'miter'
      });
    }
    for (const handle of CORNERS) {
      const p = this.handlePosition(selection.frame, handle);
      const square = [
        applyMatrix(toWorld, p.x - half, p.y - half),
        applyMatrix(toWorld, p.x + half, p.y - half),
        applyMatrix(toWorld, p.x + half, p.y + half),
        applyMatrix(toWorld, p.x - half, p.y + half)
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
