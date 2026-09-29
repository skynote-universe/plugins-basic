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
  resolveTextBlockStyle,
  resolveTextPadding,
  type CanvasPrimitive,
  type NodeCreateContent,
  type NodeEntity,
  type NodeSizingPolicy,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition,
  type TextBlockMetrics
} from '@skynote/core';

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

export interface StickyCreateOptions {
  text?: string;
  color?: StickyColor;
}

declare module '@skynote/core' {
  interface NodeCreateOptionsMap {
    sticky: StickyCreateOptions;
  }
}

export class StickyNodeType implements NodeTypeDefinition {
  static readonly TYPE = 'sticky';

  readonly type = StickyNodeType.TYPE;
  readonly label = '便签';
  readonly defaultData = {};
  readonly sizingPolicy: NodeSizingPolicy = 'height-driven';
  readonly slots: NodeTextSlotDefinition[] = [
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
  ];

  /** 新便签：默认方形、黄色底，正文为空 */
  createContent(options: StickyCreateOptions): NodeCreateContent {
    return {
      width: STICKY_DEFAULT_SIZE,
      height: STICKY_DEFAULT_SIZE,
      style: { fill: `$${options.color ?? DEFAULT_STICKY_COLOR}` },
      textBlocks: [{ id: BODY_SLOT, slot: BODY_SLOT, runs: [{ text: options.text ?? '' }] }]
    };
  }

  computeBounds(node: NodeEntity, metrics: Map<string, TextBlockMetrics>): { width: number; height: number } {
    const body = metrics.get(BODY_SLOT);
    const textHeight = body ? body.height + STICKY_PADDING * 2 : 0;
    return { width: node.width, height: Math.max(node.width, Math.ceil(textHeight)) };
  }

  compose(node: NodeEntity): CanvasPrimitive[] {
    const primitives: CanvasPrimitive[] = [
      { kind: 'rect', x: 0, y: 0, width: node.width, height: node.height, fill: solidFill(node), radius: 4 }
    ];
    const block = node.textBlocks?.find((b) => b.slot === BODY_SLOT);
    if (block) {
      const style = resolveTextBlockStyle(node, block, this);
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
}
