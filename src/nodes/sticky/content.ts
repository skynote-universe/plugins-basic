/**
 * @file content.ts
 * @description 便签：方形彩色底 + 居中文字，文字超出时向下撑高 (ADR-111)
 *
 * 设计考量 (Why):
 * 1. 最小为正方形：与 FigJam 一致，便签默认保持方形，只有文字放不下时才变高；
 *    单纯的 height-driven 会把便签收缩到文字高度，因此由 computeBounds 自己决定外框。
 * 2. 底色引用调色板 (`$yellow` 等)：明暗主题下便签保持明亮底色，文字取调色板的 ink，保证对比度。
 */

import {
  createTextBlockPrimitive,
  defineNodeType,
  resolveTextBlockStyle,
  resolveTextPadding,
  type CanvasPrimitive,
  type FractionalIndex,
  type NodeEntity,
  type NodeTypeDefinition
} from '@skynote/core';

export const STICKY_NODE_TYPE = 'sticky';

/** 便签可选底色 (调色板名称) */
export const STICKY_COLORS = ['yellow', 'orange', 'pink', 'purple', 'blue', 'teal', 'green', 'gray'] as const;
export type StickyColor = (typeof STICKY_COLORS)[number];

export const STICKY_DEFAULT_SIZE = 200;
const STICKY_PADDING = 16;
const BODY_SLOT = 'body';

const DEFAULT_STICKY_COLOR: StickyColor = 'yellow';

/** 便签只支持纯色底 (渐变无意义)，未设置时为默认黄色 */
function solidFill(node: NodeEntity): string {
  const fill = node.style?.fill;
  return typeof fill === 'string' ? fill : `$${DEFAULT_STICKY_COLOR}`;
}

export const stickyNodeType: NodeTypeDefinition = defineNodeType({
  type: STICKY_NODE_TYPE,
  label: '便签',
  defaultData: {},
  sizingPolicy: 'height-driven',
  slots: [
    {
      slot: BODY_SLOT,
      label: '正文',
      sizing: 'auto-height',
      defaultStyle: {
        fontSize: 16,
        lineHeight: 1.4,
        color: '$ink',
        textAlign: 'center',
        verticalAlign: 'middle',
        padding: STICKY_PADDING
      }
    }
  ],
  computeBounds(node, metrics) {
    const body = metrics.get(BODY_SLOT);
    const textHeight = body ? body.height + STICKY_PADDING * 2 : 0;
    return { width: node.width, height: Math.max(node.width, Math.ceil(textHeight)) };
  },
  compose(node) {
    const primitives: CanvasPrimitive[] = [
      { kind: 'rect', x: 0, y: 0, width: node.width, height: node.height, fill: solidFill(node), radius: 4 }
    ];
    const block = node.textBlocks?.find((b) => b.slot === BODY_SLOT);
    if (block) {
      const style = resolveTextBlockStyle(node, block, stickyNodeType);
      const padding = resolveTextPadding(style.padding);
      primitives.push(
        createTextBlockPrimitive(block, style, {
          x: padding.left,
          y: padding.top,
          width: node.width - padding.left - padding.right,
          height: node.height - padding.top - padding.bottom
        })
      );
    }
    return primitives;
  }
});

export interface StickyInit {
  id: string;
  /** 左上角 (父容器局部坐标) */
  x: number;
  y: number;
  zIndex: FractionalIndex;
  parentId?: string;
  text?: string;
  color?: StickyColor;
}

export function createStickyNode(init: StickyInit): NodeEntity {
  return {
    id: init.id,
    type: 'node',
    nodeType: STICKY_NODE_TYPE,
    ...(init.parentId !== undefined && { parentId: init.parentId }),
    x: init.x,
    y: init.y,
    width: STICKY_DEFAULT_SIZE,
    height: STICKY_DEFAULT_SIZE,
    rotation: 0,
    zIndex: init.zIndex,
    locked: false,
    style: { fill: `$${init.color ?? DEFAULT_STICKY_COLOR}` },
    textBlocks: [{ id: BODY_SLOT, slot: BODY_SLOT, runs: [{ text: init.text ?? '' }] }]
  };
}
