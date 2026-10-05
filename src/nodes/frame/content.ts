/**
 * @file content.ts
 * @description 画框：可接收子节点的容器，标题在框外左上角，超出外框的子节点被裁剪 (ADR-123)
 *
 * 设计考量 (Why):
 * 1. 外框归用户：尺寸由用户决定，不随子节点变化 (与组合不同，组合外框由子节点派生)。
 * 2. 标题在框外：框内空间全部留给子节点；标题带经 extent 纳入拾取 (outline 只是画框本体，悬停高亮贴合画框)，
 *    点标题带选中画框，双击标题改名。标题是单行纯文本插槽：字号固定，标题带高度因此是常量，超长时省略。
 * 3. 子节点坐标相对画框 (ADR-114)：移动、旋转画框只改画框自身；拖入拖出由选择插件按 acceptsChildren 改挂。
 * 4. 颜色缺省跟随主题 (nodeFill / nodeStroke)，显式设置的颜色原样保留。
 */

import {
  createTextBlockPrimitive,
  resolveNodeStyle,
  resolveTextBlockStyle,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeSizingPolicy,
  type NodeStyle,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition,
  type Point,
  type RectBounds
} from '@skynote/core';

export const FRAME_DEFAULT_SIZE = { width: 480, height: 320 } as const;
const TITLE_SLOT = 'title';
const TITLE_FONT_SIZE = 14;
const TITLE_LINE_HEIGHT = 1.4;
const TITLE_HEIGHT = Math.ceil(TITLE_FONT_SIZE * TITLE_LINE_HEIGHT);
/** 框外标题带的高度 (标题行高 + 与外框的间距) */
const TITLE_BAND = TITLE_HEIGHT + 4;

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
  readonly defaultStyle: NodeStyle = { strokeWidth: 1, radius: 4 };
  readonly sizingPolicy: NodeSizingPolicy = 'fixed';
  readonly clipChildren = true;
  readonly acceptsChildren = true;
  readonly slots: NodeTextSlotDefinition[] = [
    {
      slot: TITLE_SLOT,
      label: '标题',
      plainText: true,
      singleLine: true,
      defaultStyle: {
        fontSize: TITLE_FONT_SIZE,
        lineHeight: TITLE_LINE_HEIGHT,
        textWrap: 'none',
        textOverflow: 'ellipsis'
      }
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

  /** 画框本体轮廓 (悬停高亮贴合画框)；框外标题带经 extent 参与拾取 */
  outline(node: NodeEntity): Point[] {
    const { width: w, height: h } = node;
    return [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h }
    ];
  }

  compose(node: NodeEntity, { theme }: NodeComposeContext): CanvasPrimitive[] {
    const style = resolveNodeStyle(node, this);
    const primitives: CanvasPrimitive[] = [
      {
        kind: 'rect',
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: typeof style.fill === 'string' ? style.fill : theme.nodeFill,
        stroke: style.stroke ?? theme.nodeStroke,
        strokeWidth: style.strokeWidth,
        strokeDashArray: style.strokeDashArray,
        radius: style.radius
      }
    ];
    const title = node.textBlocks?.find((b) => b.slot === TITLE_SLOT);
    if (title) {
      // 标题宽度即画框宽度：超长时省略号结尾，编辑时完整延展
      primitives.push(
        createTextBlockPrimitive(title, resolveTextBlockStyle(node, title, this), {
          x: 0,
          y: -TITLE_BAND,
          width: node.width,
          height: TITLE_HEIGHT
        })
      );
    }
    return primitives;
  }
}
