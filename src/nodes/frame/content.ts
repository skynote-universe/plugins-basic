/**
 * @file content.ts
 * @description 画框：可接收子节点的容器，标题在框外左上角，超出外框的子节点被裁剪 (ADR-123)
 *
 * 设计考量 (Why):
 * 1. 自由布局的外框归用户；自动布局按轴选择固定尺寸或适应内容，适应内容的轴不接受手动缩放。
 * 2. 标题在框外：框内空间全部留给子节点；标题带经 extent 纳入拾取 (outline 只是画框本体，悬停高亮贴合画框)，
 *    点标题带选中画框，双击标题编辑。单行标题支持格式，标题带随行内字号与行高变化，超长时省略。
 * 3. 子节点坐标相对画框 (ADR-114)：移动、旋转画框只改画框自身；拖入拖出由选择插件按 acceptsChildren 改挂。
 * 4. 颜色缺省跟随主题 (nodeFill / nodeStroke)，显式设置的颜色原样保留。
 */

import {
  createTextBlockPrimitive,
  resolveNodeStyle,
  resolveTextBlockStyle,
  measureSingleLineHeight,
  resolveTextPadding,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeResizeAxes,
  type NodeResizeBehavior,
  type ResizeHandle,
  type NodeSizingPolicy,
  type NodeStyle,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition,
  type Point,
  type RectBounds
} from '@skynote/core';
import {
  STACK_LAYOUT_ID,
  parseStackLayoutOptions,
  parseStackPaddingBox,
  compactStackPadding,
  type StackLayoutOptions
} from '../../layout/stack-layout';

/** 关闭自动布局时保留的参数；启用时由 node.layout 作为唯一生效来源。 */
export interface FrameNodeFields {
  inactiveLayout?: StackLayoutOptions;
  cornerResize?: NodeResizeBehavior;
}

export const FRAME_DEFAULT_SIZE = { width: 480, height: 320 } as const;
const TITLE_SLOT = 'title';
const TITLE_FONT_SIZE = 14;
const TITLE_LINE_HEIGHT = 1.4;
const TITLE_HEIGHT = Math.ceil(TITLE_FONT_SIZE * TITLE_LINE_HEIGHT);
/** 标题带与外框之间的留白 */
const TITLE_GAP = 4;

export interface FrameCreateOptions {
  title?: string;
}

declare module '@skynote/core' {
  interface CustomNodeFields {
    frame?: FrameNodeFields;
  }
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
  readonly supportsContentScale = true;

  getResizeBehavior(node: NodeEntity, handle: ResizeHandle): NodeResizeBehavior {
    if (node.layout?.type === STACK_LAYOUT_ID) return 'scale-contents';
    return handle.length === 2 ? (node.frame?.cornerResize ?? 'scale-contents') : 'resize-bounds';
  }

  /** 整体缩放保持布局模式，间距与四向边距一起缩放，避免 hug 派生把容器拉回原尺寸。 */
  applyContentScale(node: NodeEntity, scale: number): Partial<NodeEntity> {
    // 起始配置可能省略默认选项；回到 1 倍时恢复原字段，不固化解析后的默认值。
    if (scale === 1) return { layout: node.layout, frame: node.frame };
    const scaled = (options: StackLayoutOptions): StackLayoutOptions => {
      const padding = parseStackPaddingBox(options.padding);
      return {
        ...options,
        gap: Math.round(options.gap * scale),
        padding: compactStackPadding({
          top: Math.round(padding.top * scale),
          right: Math.round(padding.right * scale),
          bottom: Math.round(padding.bottom * scale),
          left: Math.round(padding.left * scale)
        })
      };
    };
    return {
      ...(node.layout?.type === STACK_LAYOUT_ID
        ? { layout: { ...node.layout, options: { ...scaled(parseStackLayoutOptions(node.layout.options)) } } }
        : {}),
      ...(node.frame?.inactiveLayout
        ? { frame: { ...node.frame, inactiveLayout: scaled(node.frame.inactiveLayout) } }
        : {})
    };
  }
  readonly acceptsChildren = true;
  readonly slots: NodeTextSlotDefinition[] = [
    {
      slot: TITLE_SLOT,
      label: '标题',
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
    return { left: 0, top: -(this.titleHeight(node) + TITLE_GAP), right: node.width, bottom: node.height };
  }

  /** 缩放后的标题沿用有效字号计算标题带，避免文字放大后仍被固定高度裁剪。 */
  private titleHeight(node: NodeEntity): number {
    const title = node.textBlocks?.find((block) => block.slot === TITLE_SLOT);
    if (!title) return TITLE_HEIGHT;
    const style = resolveTextBlockStyle(node, title, this);
    const padding = resolveTextPadding(style.padding);
    return Math.ceil(measureSingleLineHeight(title.runs, style) + padding.top + padding.bottom);
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

  supportsCornerRadius(): boolean {
    return true;
  }

  /** 适应内容的轴由布局拥有，手动调整前必须显式切为固定，避免缩放暗中改变模式。 */
  getResizeAxes(node: NodeEntity): NodeResizeAxes {
    if (node.layout?.type !== STACK_LAYOUT_ID) return 'both';
    const { widthSizing, heightSizing } = parseStackLayoutOptions(node.layout.options);
    if (widthSizing === 'fixed') return heightSizing === 'fixed' ? 'both' : 'width';
    return heightSizing === 'fixed' ? 'height' : 'none';
  }

  /** 固定尺寸模式下的自动堆叠画框点击「适应内容」时恢复为自适应尺寸 (hug) */
  fitContent(node: NodeEntity): Partial<NodeEntity> | null {
    if (node.layout?.type === STACK_LAYOUT_ID) {
      const options = parseStackLayoutOptions(node.layout.options);
      if (options.widthSizing === 'hug' && options.heightSizing === 'hug') return null;
      return {
        layout: {
          ...node.layout,
          options: { ...options, widthSizing: 'hug', heightSizing: 'hug' }
        }
      };
    }
    return null;
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
        fillOpacity: style.fillOpacity,
        stroke: style.stroke ?? theme.nodeStroke,
        strokeOpacity: style.strokeOpacity,
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
          y: -(this.titleHeight(node) + TITLE_GAP),
          width: node.width,
          height: this.titleHeight(node)
        })
      );
    }
    return primitives;
  }
}
