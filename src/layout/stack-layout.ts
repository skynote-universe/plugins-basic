/**
 * @file stack-layout.ts
 * @description 画框自动堆叠布局 (ADR-145 阶段三)：支持水平/垂直方向、间距、内边距、交叉轴对齐与自适应 (hug) / 固定 (fixed) 容器尺寸
 *
 * 设计考量 (Why):
 * 1. 纯函数派生：arrange(tree) 只根据当前按层叠顺序排列的子成员宽高与布局参数计算各子成员的局部坐标及容器自适应宽高，
 *    由内核容器依赖调度在同一事务内写入补丁，读取文字测量及更深层容器的最新几何。
 * 2. 顺序唯一真源为 zIndex：子成员在主轴上的排列顺序完全由兄弟层叠顺序决定，拖拽换序只需调整目标节点的 zIndex。
 */

import {
  generateNKeysBetween,
  sortSiblingsByLayer,
  type CanvasPluginContext,
  type EntityReader,
  type LayoutDefinition,
  type LayoutPlacement,
  type LayoutTree,
  type NodeEntity,
  type Point
} from '@skynote/core';

export const STACK_LAYOUT_ID = 'stack' as const;

export type StackDirection = 'horizontal' | 'vertical';
export type StackAlign = 'start' | 'center' | 'end';
export type StackJustify = StackAlign | 'space-between';
export type StackSizing = 'hug' | 'fixed';

/** 规范化四向内边距结构 (上、右、下、左) */
export interface StackPaddingBox {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** 外部允许传入的灵活边距格式：单一数字、CSS 风格数组或具名对象 */
export type StackPaddingInput =
  | number
  | readonly [vertical: number, horizontal: number]
  | readonly [top: number, right: number, bottom: number, left: number]
  | Partial<StackPaddingBox>;

/** 规范化持久化存储格式：四边相等时紧凑为数字，不等时存储为具名对象 */
export type StackPadding = number | StackPaddingBox;

export interface StackLayoutOptions {
  readonly direction: StackDirection;
  readonly gap: number;
  readonly padding: StackPadding;
  readonly align: StackAlign;
  readonly justify: StackJustify;
  readonly widthSizing: StackSizing;
  readonly heightSizing: StackSizing;
}

export const DEFAULT_STACK_LAYOUT_OPTIONS: StackLayoutOptions = {
  direction: 'horizontal',
  gap: 16,
  padding: 24,
  align: 'start',
  justify: 'start',
  widthSizing: 'hug',
  heightSizing: 'hug'
};

function normalizePaddingNum(val: unknown, fallback: number): number {
  return typeof val === 'number' && Number.isFinite(val) ? Math.max(0, Math.round(val)) : fallback;
}

/** 将任何输入格式的 padding 统一解析为标准的四向边距对象 */
export function parseStackPaddingBox(raw: unknown, fallback = 24): StackPaddingBox {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const val = Math.max(0, Math.round(raw));
    return { top: val, right: val, bottom: val, left: val };
  }

  // 支持 CSS 风格数组: [vertical, horizontal] 或 [top, right, bottom, left]
  if (Array.isArray(raw)) {
    if (raw.length === 2) {
      const v = normalizePaddingNum(raw[0], fallback);
      const h = normalizePaddingNum(raw[1], fallback);
      return { top: v, right: h, bottom: v, left: h };
    }
    if (raw.length >= 4) {
      return {
        top: normalizePaddingNum(raw[0], fallback),
        right: normalizePaddingNum(raw[1], fallback),
        bottom: normalizePaddingNum(raw[2], fallback),
        left: normalizePaddingNum(raw[3], fallback)
      };
    }
  }

  // 支持具名对象
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    return {
      top: normalizePaddingNum(obj.top, fallback),
      right: normalizePaddingNum(obj.right, fallback),
      bottom: normalizePaddingNum(obj.bottom, fallback),
      left: normalizePaddingNum(obj.left, fallback)
    };
  }

  return { top: fallback, right: fallback, bottom: fallback, left: fallback };
}

/** 格式化为持久化存储的紧凑格式：若四边一致存数字，否则存具名对象 */
export function compactStackPadding(box: StackPaddingBox): StackPadding {
  if (box.top === box.right && box.right === box.bottom && box.bottom === box.left) {
    return box.top;
  }
  return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
}

export function parseStackLayoutOptions(raw: unknown): StackLayoutOptions {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const direction: StackDirection = obj.direction === 'vertical' ? 'vertical' : 'horizontal';
  const gap =
    typeof obj.gap === 'number' && Number.isFinite(obj.gap)
      ? Math.max(0, Math.round(obj.gap))
      : DEFAULT_STACK_LAYOUT_OPTIONS.gap;
  const paddingBox = parseStackPaddingBox(obj.padding, 24);
  const padding = compactStackPadding(paddingBox);
  const align: StackAlign = obj.align === 'center' || obj.align === 'end' ? obj.align : 'start';
  const justify: StackJustify =
    obj.justify === 'center' || obj.justify === 'end' || obj.justify === 'space-between' ? obj.justify : 'start';
  const widthSizing: StackSizing = obj.widthSizing === 'fixed' ? 'fixed' : 'hug';
  const heightSizing: StackSizing = obj.heightSizing === 'fixed' ? 'fixed' : 'hug';
  return { direction, gap, padding, align, justify, widthSizing, heightSizing };
}

export class StackLayoutDefinition implements LayoutDefinition {
  readonly id = STACK_LAYOUT_ID;
  readonly label = '自动堆叠';

  parseOptions(raw: unknown): Record<string, unknown> {
    return { ...parseStackLayoutOptions(raw) };
  }

  arrange(tree: LayoutTree): ReadonlyMap<string, LayoutPlacement> {
    const { children, node: root } = tree.root;
    const { direction, gap, padding, align, justify, widthSizing, heightSizing } = parseStackLayoutOptions(
      tree.options
    );
    const pad = parseStackPaddingBox(padding);
    const horizontal = direction === 'horizontal';
    let mainSize = 0;
    let crossSize = 0;
    for (const child of children) {
      mainSize += horizontal ? child.node.width : child.node.height;
      crossSize = Math.max(crossSize, horizontal ? child.node.height : child.node.width);
    }
    mainSize += gap * Math.max(0, children.length - 1);
    const hugWidth = Math.round(Math.max(1, (horizontal ? mainSize : crossSize) + pad.left + pad.right));
    const hugHeight = Math.round(Math.max(1, (horizontal ? crossSize : mainSize) + pad.top + pad.bottom));
    const crossSizing = horizontal ? heightSizing : widthSizing;
    const availableCross = horizontal ? root.height - pad.top - pad.bottom : root.width - pad.left - pad.right;
    const innerCross = crossSizing === 'fixed' ? Math.max(0, availableCross) : crossSize;
    const placements = new Map<string, LayoutPlacement>();
    // 主轴对齐只分配固定容器的剩余空间；内容超出或 hug 时保留间距并从起点排布。
    const mainSizing = horizontal ? widthSizing : heightSizing;
    const availableMain = horizontal ? root.width - pad.left - pad.right : root.height - pad.top - pad.bottom;
    const freeMain = mainSizing === 'fixed' ? Math.max(0, availableMain - mainSize) : 0;
    const mainOffset = justify === 'center' ? freeMain / 2 : justify === 'end' ? freeMain : 0;
    const effectiveGap =
      justify === 'space-between' && children.length > 1 ? gap + freeMain / (children.length - 1) : gap;
    let cursor = (horizontal ? pad.left : pad.top) + mainOffset;
    for (const child of children) {
      const childCross = horizontal ? child.node.height : child.node.width;
      const freeCross = Math.max(0, innerCross - childCross);
      const offset = align === 'center' ? freeCross / 2 : align === 'end' ? freeCross : 0;
      placements.set(child.node.id, {
        x: Math.round(horizontal ? cursor : pad.left + offset),
        y: Math.round(horizontal ? pad.top + offset : cursor),
        rotation: 0
      });
      cursor += (horizontal ? child.node.width : child.node.height) + effectiveGap;
    }
    if (widthSizing === 'hug' || heightSizing === 'hug') {
      placements.set(root.id, {
        x: root.x,
        y: root.y,
        ...(widthSizing === 'hug' ? { width: hugWidth } : {}),
        ...(heightSizing === 'hug' ? { height: hugHeight } : {})
      });
    }
    return placements;
  }
}

/**
 * 根据指针在自动堆叠容器局部坐标系中的落点，计算被拖拽节点在剩余子成员中的插入下标 (0 .. remaining.length)
 */
export function computeStackInsertIndex(
  root: Readonly<NodeEntity>,
  remainingMembers: readonly Readonly<NodeEntity>[],
  localPoint: Point
): number {
  const { direction } = parseStackLayoutOptions(root.layout?.options);
  const pos = direction === 'vertical' ? localPoint.y : localPoint.x;
  for (let i = 0; i < remainingMembers.length; i++) {
    const m = remainingMembers[i];
    const center = direction === 'vertical' ? m.y + m.height / 2 : m.x + m.width / 2;
    if (pos < center) return i;
  }
  return remainingMembers.length;
}

/**
 * 把外部传入的内边距与现有内边距合并：数字与数组为完整取值，直接解析；具名对象只覆盖给出的方向，其余方向沿用 base
 */
export function mergeStackPadding(input: StackPaddingInput | undefined, base: StackPaddingBox): StackPaddingBox {
  if (input === undefined) return base;
  if (typeof input === 'number' || Array.isArray(input)) return parseStackPaddingBox(input, base.top);
  const partial = input as Partial<StackPaddingBox>;
  return {
    top: normalizePaddingNum(partial.top, base.top),
    right: normalizePaddingNum(partial.right, base.right),
    bottom: normalizePaddingNum(partial.bottom, base.bottom),
    left: normalizePaddingNum(partial.left, base.left)
  };
}

/** 设置画框自动布局时可传入的参数：除内边距外均为可选覆盖，内边距接受任意输入格式 */
export type StackLayoutPatch = Partial<Omit<StackLayoutOptions, 'padding'>> & { padding?: StackPaddingInput };

/**
 * 开启、修改或关闭画框的自动堆叠布局 (单事务完成：首次开启时按子节点的视觉主轴坐标初始化层叠顺序并打上 layoutItem，关闭时移除 layout 与子成员标记)
 * 传入 groupId 时与同组的其他编辑合并为一步撤销 (如拖动滑块的连续调整)
 */
export function setFrameAutoLayout(
  document: CanvasPluginContext['document'],
  entities: EntityReader,
  frameIds: Iterable<string>,
  options: StackLayoutPatch | null,
  commandOptions?: { groupId?: string; label?: string }
): void {
  const targets = [...frameIds]
    .map((id) => document.getNode(id))
    .filter((n): n is Readonly<NodeEntity> => n !== undefined && !n.locked && n.nodeType === 'frame');
  if (targets.length === 0) return;

  const label = commandOptions?.label ?? (options === null ? '关闭自动布局' : '自动布局');
  const edit = { groupId: commandOptions?.groupId, label };

  const run = (): void => {
    for (const frame of targets) {
      const wasStack = frame.layout?.type === STACK_LAYOUT_ID;
      if (options === null) {
        if (!wasStack) continue;
        document.updateNode(
          frame.id,
          {
            layout: undefined,
            frame: { ...frame.frame, inactiveLayout: parseStackLayoutOptions(frame.layout?.options) }
          },
          edit
        );
        const childIds = [...entities.getChildIds(frame.id)];
        if (childIds.length > 0) {
          document.updateNodes(childIds, (child) => (child.layout ? {} : { layoutItem: undefined }), edit);
        }
        continue;
      }

      const base = parseStackLayoutOptions(wasStack ? frame.layout?.options : frame.frame?.inactiveLayout);
      const padding = compactStackPadding(mergeStackPadding(options.padding, parseStackPaddingBox(base.padding)));
      const next = parseStackLayoutOptions({ ...base, ...options, padding });
      const children = sortSiblingsByLayer(
        [...entities.getChildIds(frame.id)]
          .map((id) => document.getNode(id))
          .filter((c): c is Readonly<NodeEntity> => c !== undefined)
      );

      if (!wasStack && children.length > 0) {
        const sorted = [...children].sort((a, b) => (next.direction === 'vertical' ? a.y - b.y : a.x - b.x));
        const keys = generateNKeysBetween(null, null, sorted.length);
        const keyOf = new Map(sorted.map((c, i) => [c.id, keys[i]]));
        document.updateNodes(
          [...keyOf.keys()],
          (node) => ({
            zIndex: keyOf.get(node.id)!,
            ...(node.layoutItem ? {} : { layoutItem: {} })
          }),
          edit
        );
      } else if (children.length > 0) {
        const missing = children.filter((c) => !c.layoutItem).map((c) => c.id);
        if (missing.length > 0) document.updateNodes(missing, { layoutItem: {} }, edit);
      }

      const { inactiveLayout: _inactiveLayout, ...retainedFrameFields } = frame.frame ?? {};
      document.updateNode(
        frame.id,
        {
          layout: { type: STACK_LAYOUT_ID, options: { ...next } },
          ...(frame.frame?.inactiveLayout
            ? { frame: Object.keys(retainedFrameFields).length > 0 ? retainedFrameFields : undefined }
            : {})
        },
        edit
      );
    }
  };

  // 统一以批次提交：多画框或需要同时改子成员时合并为一步；批次内各命令沿用同一 groupId 与标签
  document.batch(run, edit);
}
