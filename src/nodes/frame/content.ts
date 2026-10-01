/**
 * @file content.ts
 * @description 画框：可接收子节点的容器，标题在框外左上角，超出外框的子节点被裁剪 (ADR-123)
 *
 * 设计考量 (Why):
 * 1. 外框归用户：尺寸由用户决定，不随子节点变化 (与组合不同，组合外框由子节点派生)。
 * 2. 标题在框外：框内空间全部留给子节点；标题区域经 extent 与 outline 纳入拾取，点标题选中画框，双击标题改名。
 * 3. 子节点坐标相对画框 (ADR-114)：移动、旋转画框只改画框自身；拖入拖出由选择插件按 acceptsChildren 改挂。
 * 4. 颜色缺省跟随主题 (nodeFill / nodeStroke)，显式设置的颜色原样保留。
 */

import {
  createTextBlockPrimitive,
  resolveTextBlockStyle,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeSizingPolicy,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition,
  type Point,
  type RectBounds
} from '@skynote/core';

export const FRAME_DEFAULT_SIZE = { width: 480, height: 320 } as const;
const TITLE_SLOT = 'title';
const TITLE_FONT_SIZE = 14;
const TITLE_LINE_HEIGHT = 1.4;
/** 标题与外框的间距 */
const TITLE_GAP = 4;
/** 框外标题区域的高度 (标题行高 + 间距) */
const TITLE_BAND = Math.ceil(TITLE_FONT_SIZE * TITLE_LINE_HEIGHT) + TITLE_GAP;

export interface FrameCreateOptions {
  title?: string;
}

declare module '@skynote/core' {
  interface NodeCreateOptionsMap {
    frame: FrameCreateOptions;
  }
}

export class FrameNodeType implements NodeTypeDefinition {
  static readonly TYPE = 'frame';

  readonly type = FrameNodeType.TYPE;
  readonly label = '画框';
  readonly defaultData = {};
  readonly sizingPolicy: NodeSizingPolicy = 'fixed';
  readonly clipChildren = true;
  readonly acceptsChildren = true;
  readonly slots: NodeTextSlotDefinition[] = [
    {
      slot: TITLE_SLOT,
      label: '标题',
      defaultStyle: { fontSize: TITLE_FONT_SIZE, lineHeight: TITLE_LINE_HEIGHT, textWrap: 'none' }
    }
  ];

  createContent(options: FrameCreateOptions): NodeCreateContent {
    return {
      ...FRAME_DEFAULT_SIZE,
      textBlocks: [{ id: TITLE_SLOT, slot: TITLE_SLOT, runs: [{ text: options.title ?? '画框' }] }]
    };
  }

  /** 外框上方的标题带纳入占据范围 (整条与画框同宽，标题短于画框时空白处同样可点选画框) */
  extent(node: NodeEntity): RectBounds {
    return { left: 0, top: -TITLE_BAND, right: node.width, bottom: node.height };
  }

  outline(node: NodeEntity): Point[] {
    const { width: w, height: h } = node;
    return [
      { x: 0, y: -TITLE_BAND },
      { x: w, y: -TITLE_BAND },
      { x: w, y: h },
      { x: 0, y: h }
    ];
  }

  compose(node: NodeEntity, { theme }: NodeComposeContext): CanvasPrimitive[] {
    const fill = node.style?.fill;
    const primitives: CanvasPrimitive[] = [
      {
        kind: 'rect',
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: typeof fill === 'string' ? fill : theme.nodeFill,
        stroke: node.style?.stroke ?? theme.nodeStroke,
        strokeWidth: node.style?.strokeWidth ?? 1,
        radius: node.style?.radius ?? 4
      }
    ];
    const title = node.textBlocks?.find((b) => b.slot === TITLE_SLOT);
    if (title) {
      primitives.push(
        createTextBlockPrimitive(title, resolveTextBlockStyle(node, title, this), { x: 0, y: -TITLE_BAND })
      );
    }
    return primitives;
  }
}
