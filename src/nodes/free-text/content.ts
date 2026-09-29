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
  defineNodeType,
  resolveTextBlockStyle,
  type FractionalIndex,
  type NodeEntity,
  type NodeTypeDefinition,
  type TextBlock
} from '@skynote/core';

export const FREE_TEXT_NODE_TYPE = 'free-text';
const BODY_SLOT = 'body';

/** 固定宽度折行时的排版宽度；自由伸缩时返回 undefined (不折行) */
function wrapWidth(node: NodeEntity, block: TextBlock): number | undefined {
  return block.sizing === 'auto-height' ? (block.explicitWidth ?? node.width) : undefined;
}

export const freeTextNodeType: NodeTypeDefinition = defineNodeType({
  type: FREE_TEXT_NODE_TYPE,
  label: '文本',
  defaultData: {},
  sizingPolicy: 'content-driven',
  slots: [{ slot: BODY_SLOT, label: '正文', defaultStyle: { fontSize: 18, lineHeight: 1.4 } }],
  computeBounds(node, metrics) {
    const block = node.textBlocks?.find((b) => b.slot === BODY_SLOT);
    const body = metrics.get(BODY_SLOT);
    if (!block || !body) return { width: node.width, height: node.height };
    // 折行时外框宽度即设定宽度 (内容盒可能更窄)，否则外框随最长一行伸缩
    return { width: Math.ceil(wrapWidth(node, block) ?? body.width), height: Math.ceil(body.height) };
  },
  compose(node) {
    const block = node.textBlocks?.find((b) => b.slot === BODY_SLOT);
    if (!block) return [];
    const style = resolveTextBlockStyle(node, block, freeTextNodeType);
    return [createTextBlockPrimitive(block, style, { x: 0, y: 0, width: wrapWidth(node, block) })];
  }
});

export interface FreeTextInit {
  id: string;
  /** 左上角 (父容器局部坐标) */
  x: number;
  y: number;
  zIndex: FractionalIndex;
  parentId?: string;
  text?: string;
}

/** 初始宽高为 0：注入文本测量器时，提交事务内即派生出实际尺寸 (ADR-105) */
export function createFreeTextNode(init: FreeTextInit): NodeEntity {
  return {
    id: init.id,
    type: 'node',
    nodeType: FREE_TEXT_NODE_TYPE,
    ...(init.parentId !== undefined && { parentId: init.parentId }),
    x: init.x,
    y: init.y,
    width: 0,
    height: 0,
    rotation: 0,
    zIndex: init.zIndex,
    locked: false,
    textBlocks: [{ id: BODY_SLOT, slot: BODY_SLOT, runs: [{ text: init.text ?? '' }] }]
  };
}
