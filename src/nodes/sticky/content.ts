/**
 * @file content.ts
 * @description 便签：方形彩色底 + 居中文字 (ADR-121)
 *
 * 设计考量 (Why):
 * 1. 外框完全由用户决定：默认正方形并锁定比例 (头脑风暴排成网格时尺寸一致)，解锁后可拉成任意长方形；
 *    文字不再撑大外框，放不下时显示省略号，缩放时外框与指针始终一致；需要时由用户显式「适应内容」一次性调整高度。
 * 2. 底色引用调色板 (`$yellow` 等)：明暗主题下便签保持明亮底色，文字取调色板的 ink，保证对比度。
 */

import {
  createTextBlockPrimitive,
  getPlainText,
  resolveTextBlockStyle,
  resolveTextPadding,
  type CanvasPrimitive,
  type NodeFitContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeSizingPolicy,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition
} from '@skynote/core';

/** 便签可选底色 (调色板名称) */
export const STICKY_COLORS = ['yellow', 'orange', 'pink', 'purple', 'blue', 'teal', 'green', 'gray'] as const;
export type StickyColor = (typeof STICKY_COLORS)[number];

export const STICKY_DEFAULT_SIZE = 200;
const STICKY_PADDING = 16;
const BODY_SLOT = 'body';
/** 测量抖动容差：差距不足半像素视为已适应内容 */
const SIZE_EPSILON = 0.5;

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
  readonly sizingPolicy: NodeSizingPolicy = 'fixed';
  readonly defaultAspectLocked = true;
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
        textOverflow: 'ellipsis',
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

  /**
   * 保持宽度，高度一次性调整为刚好放下文字 (不回到自动撑高，外框仍归用户)
   * 比例锁定只约束拖拽；这是用户的显式命令，照常执行，之后锁定按新比例生效。空便签没有可适应的内容
   */
  fitContent(node: NodeEntity, context: NodeFitContext): Partial<NodeEntity> | null {
    const block = node.textBlocks?.find((b) => b.slot === BODY_SLOT);
    if (!block || getPlainText(block) === '') return null;
    const padding = resolveTextPadding(resolveTextBlockStyle(node, block, this).padding);
    const contentWidth = node.width - padding.left - padding.right;
    // 比内边距还窄的便签放不下文字，没有可适应的高度
    const text = contentWidth > 0 ? context.measureText(block, contentWidth) : null;
    if (!text) return null;
    const height = Math.ceil(text.height + padding.top + padding.bottom);
    return Math.abs(height - node.height) < SIZE_EPSILON ? null : { height };
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
          width: Math.max(0, node.width - padding.left - padding.right),
          height: Math.max(0, node.height - padding.top - padding.bottom)
        })
      );
    }
    return primitives;
  }
}
