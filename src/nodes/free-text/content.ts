/**
 * @file content.ts
 * @description 自由文本：无底色的纯文字，三种尺寸状态由文本块 sizing 区分 (ADR-111)
 *
 * 设计考量 (Why):
 * 1. 尺寸状态与 Figma 文本一致，全部由用户拖动控制柄切换：
 *    - 适应内容 (缺省 auto-width)：单行不折行，宽高都由文字决定；
 *    - 固定宽度 (auto-height)：拖左右边后写入 explicitWidth，按宽度折行、高度随内容；
 *    - 固定尺寸 (fixed)：拖上下边后再写入 explicitHeight，宽高都固定，文字超出时照常显示。
 *    拖四角等比缩放字号，尺寸状态保持不变；工具栏「适应内容」回到适应内容。
 * 2. 测量与绘制都只看 sizing 判断是否折行，二者条件一致，量出的尺寸与画面不会分叉。
 */

import {
  createTextBlockPrimitive,
  resolveTextBlockStyle,
  type CanvasPrimitive,
  type NodeCreateContent,
  type NodeEntity,
  type NodeResizeRequest,
  type NodeSizingPolicy,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition,
  type TextBlock,
  type TextBlockMetrics
} from '@skynote/core';

const BODY_SLOT = 'body';
const DEFAULT_FONT_SIZE = 18;
/** 等比缩放后的最小字号 */
const MIN_FONT_SIZE = 1;

/** 折行时的排版宽度；适应内容时返回 undefined (不折行) */
function wrapWidth(node: NodeEntity, block: TextBlock): number | undefined {
  return block.sizing === 'auto-height' || block.sizing === 'fixed' ? (block.explicitWidth ?? node.width) : undefined;
}

function findBody(node: NodeEntity): TextBlock | undefined {
  return node.textBlocks?.find((b) => b.slot === BODY_SLOT);
}

/** 以新的正文块替换原正文块 (其他块原样保留) */
function withBody(node: NodeEntity, body: TextBlock): Partial<NodeEntity> {
  return { textBlocks: (node.textBlocks ?? []).map((b) => (b.slot === BODY_SLOT ? body : b)) };
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
  readonly scaleContentOnCorners = true;
  readonly removeWhenEmpty = true;
  readonly slots: NodeTextSlotDefinition[] = [
    {
      slot: BODY_SLOT,
      label: '正文',
      defaultStyle: { fontSize: DEFAULT_FONT_SIZE, lineHeight: 1.4, textOverflow: 'ellipsis' }
    }
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
    const block = findBody(node);
    const body = metrics.get(BODY_SLOT);
    if (!block || !body) return { width: node.width, height: node.height };
    // 固定尺寸时外框即设定尺寸；折行时外框宽度即设定宽度 (内容盒可能更窄)；否则外框随文字伸缩
    const height = block.sizing === 'fixed' ? (block.explicitHeight ?? node.height) : body.height;
    return { width: Math.ceil(wrapWidth(node, block) ?? body.width), height: Math.ceil(height) };
  }

  /**
   * 等比缩放 (拖角、锁定比例或按住 Shift) → 按比例缩放字号与已固定的尺寸；
   * 否则左右边 → 固定宽度 (已是固定尺寸则保持)，上下边 → 固定尺寸
   * 外框宽高由排版派生，这里只写入尺寸状态与字号
   */
  applyResize(node: NodeEntity, request: NodeResizeRequest): Partial<NodeEntity> {
    const block = findBody(node);
    if (!block) return {};
    const { handle, width, height, scale } = request;
    if (scale === 1 && (handle === 'e' || handle === 'w')) {
      return withBody(node, {
        ...block,
        sizing: block.sizing === 'fixed' ? 'fixed' : 'auto-height',
        explicitWidth: Math.round(width)
      });
    }
    if (scale === 1 && (handle === 'n' || handle === 's')) {
      return withBody(node, {
        ...block,
        sizing: 'fixed',
        explicitWidth: Math.round(width),
        explicitHeight: Math.round(height)
      });
    }
    const fontSize = resolveTextBlockStyle(node, block, this).fontSize ?? DEFAULT_FONT_SIZE;
    return withBody(node, {
      ...block,
      style: { ...block.style, fontSize: Math.max(MIN_FONT_SIZE, Math.round(fontSize * scale)) },
      ...(block.explicitWidth !== undefined && { explicitWidth: Math.round(block.explicitWidth * scale) }),
      ...(block.explicitHeight !== undefined && { explicitHeight: Math.round(block.explicitHeight * scale) })
    });
  }

  /** 回到适应内容 (单行)：只切换尺寸状态，外框交给排版派生 */
  fitContent(node: NodeEntity): Partial<NodeEntity> | null {
    const block = findBody(node);
    if (!block) return null;
    if (block.sizing === undefined || block.sizing === 'auto-width') return null;
    const { explicitWidth: _width, explicitHeight: _height, ...rest } = block;
    return withBody(node, { ...rest, sizing: 'auto-width' });
  }

  compose(node: NodeEntity): CanvasPrimitive[] {
    const block = findBody(node);
    if (!block) return [];
    const style = resolveTextBlockStyle(node, block, this);
    return [
      createTextBlockPrimitive(block, style, {
        x: 0,
        y: 0,
        width: wrapWidth(node, block),
        height: block.sizing === 'fixed' ? node.height : undefined
      })
    ];
  }
}
