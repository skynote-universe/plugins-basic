/**
 * @file content.ts
 * @description 自由文本：无底色的纯文字，外框随内容自动伸缩 (ADR-111)
 *
 * 设计考量 (Why):
 * 1. 两种排版状态共用一个节点类型，只由文本块 sizing 区分：
 *    - 缺省 auto-width：单行不折行，宽高都由内容决定；
 *    - auto-height：用户拖拽改宽后写入 sizing 与 explicitWidth，宽度固定、向下折行。
 * 2. 测量与绘制都只看 sizing 判断是否折行，二者条件一致，量出的尺寸与画面不会分叉。
 */

import {
  createTextBlockPrimitive,
  resolveTextBlockStyle,
  type CanvasPrimitive,
  type NodeCreateContent,
  type NodeEntity,
  type NodeSizingPolicy,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition,
  type TextBlock,
  type TextBlockMetrics
} from '@skynote/core';
const BODY_SLOT = 'body';

/** 固定宽度折行时的排版宽度；自由伸缩时返回 undefined (不折行) */
function wrapWidth(node: NodeEntity, block: TextBlock): number | undefined {
  return block.sizing === 'auto-height' ? (block.explicitWidth ?? node.width) : undefined;
}

export interface FreeTextCreateOptions {
  text?: string;
}

declare module '@skynote/core' {
  interface NodeCreateOptionsMap {
    'free-text': FreeTextCreateOptions;
  }
}

export class FreeTextNodeType implements NodeTypeDefinition {
  static readonly TYPE = 'free-text';

  readonly type = FreeTextNodeType.TYPE;
  readonly label = '文本';
  readonly defaultData = {};
  readonly sizingPolicy: NodeSizingPolicy = 'content-driven';
  readonly slots: NodeTextSlotDefinition[] = [
    { slot: BODY_SLOT, label: '正文', defaultStyle: { fontSize: 18, lineHeight: 1.4 } }
  ];

  /** 初始宽高为 0：注入文本测量器时，提交事务内即派生出实际尺寸 (ADR-105) */
  createContent(options: FreeTextCreateOptions): NodeCreateContent {
    return {
      width: 0,
      height: 0,
      textBlocks: [{ id: BODY_SLOT, slot: BODY_SLOT, runs: [{ text: options.text ?? '' }] }]
    };
  }

  computeBounds(node: NodeEntity, metrics: Map<string, TextBlockMetrics>): { width: number; height: number } {
    const block = node.textBlocks?.find((b) => b.slot === BODY_SLOT);
    const body = metrics.get(BODY_SLOT);
    if (!block || !body) return { width: node.width, height: node.height };
    // 折行时外框宽度即设定宽度 (内容盒可能更窄)，否则外框随最长一行伸缩
    return { width: Math.ceil(wrapWidth(node, block) ?? body.width), height: Math.ceil(body.height) };
  }

  compose(node: NodeEntity): CanvasPrimitive[] {
    const block = node.textBlocks?.find((b) => b.slot === BODY_SLOT);
    if (!block) return [];
    const style = resolveTextBlockStyle(node, block, this);
    return [createTextBlockPrimitive(block, style, { x: 0, y: 0, width: wrapWidth(node, block) })];
  }
}
