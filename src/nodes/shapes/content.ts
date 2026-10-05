/**
 * @file content.ts
 * @description 基础形状：矩形、椭圆、菱形，可带居中标签；尺寸固定，文字不改变外框 (ADR-111)
 *
 * 设计考量 (Why):
 * 1. 一个节点类型 + geometry 字段：切换形状只改数据，不必更换节点类型 (与 tldraw 的 geo 形状一致)；
 *    新增形状只需在 GEOMETRY_BUILDERS 中加一个轮廓函数。
 * 2. 颜色缺省即跟随主题 (nodeFill / nodeStroke / textColor)，显式设置的颜色 (含 `$名称` 引用) 原样保留。
 */

import {
  createTextBlockPrimitive,
  resolveNodeStyle,
  resolveTextBlockStyle,
  resolveTextPadding,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeSizingPolicy,
  type NodeStyle,
  type NodeTextSlotDefinition,
  type NodeTypeDefinition,
  type Point
} from '@skynote/core';

export const SHAPE_GEOMETRIES = ['rectangle', 'ellipse', 'diamond'] as const;
export type ShapeGeometry = (typeof SHAPE_GEOMETRIES)[number];

export interface ShapeData extends Record<string, unknown> {
  geometry: ShapeGeometry;
}

export const SHAPE_DEFAULT_SIZE = { width: 160, height: 100 } as const;
const LABEL_SLOT = 'label';
/** 各几何共用的填充与描边 */
interface ShapePaint {
  fill: string;
  stroke: string;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: NodeStyle['strokeCap'];
  strokeJoin?: NodeStyle['strokeJoin'];
}

/** 形状轮廓：只描述几何，填充与描边统一传入；圆角只对矩形有意义 */
const GEOMETRY_BUILDERS: Record<
  ShapeGeometry,
  (w: number, h: number, paint: ShapePaint, radius: NodeStyle['radius']) => CanvasPrimitive
> = {
  rectangle: (w, h, paint, radius) => ({ kind: 'rect', x: 0, y: 0, width: w, height: h, radius, ...paint }),
  ellipse: (w, h, paint) => ({ kind: 'ellipse', cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...paint }),
  diamond: (w, h, paint) => ({
    kind: 'polygon',
    points: [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2],
    ...paint,
    strokeJoin: paint.strokeJoin ?? 'round'
  })
};

/** 椭圆轮廓的分段数：拾取精度在常见尺寸下优于 1px */
const ELLIPSE_SEGMENTS = 64;

/** 形状轮廓 (局部坐标)：用于精确拾取与悬停高亮 */
const GEOMETRY_OUTLINES: Record<ShapeGeometry, (w: number, h: number) => Point[]> = {
  rectangle: (w, h) => [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ],
  ellipse: (w, h) =>
    Array.from({ length: ELLIPSE_SEGMENTS }, (_, i) => {
      const angle = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
      return { x: w / 2 + (Math.cos(angle) * w) / 2, y: h / 2 + (Math.sin(angle) * h) / 2 };
    }),
  diamond: (w, h) => [
    { x: w / 2, y: 0 },
    { x: w, y: h / 2 },
    { x: w / 2, y: h },
    { x: 0, y: h / 2 }
  ]
};

function resolveGeometry(node: NodeEntity): ShapeGeometry {
  const geometry = (node.data as Partial<ShapeData> | undefined)?.geometry;
  return geometry !== undefined && geometry in GEOMETRY_BUILDERS ? geometry : 'rectangle';
}

export interface ShapeCreateOptions {
  geometry?: ShapeGeometry;
  /** 居中标签文字；缺省时不带标签文本块 */
  label?: string;
}

declare module '@skynote/core' {
  interface NodeCreateOptionsMap {
    shape: ShapeCreateOptions;
  }
}

/** 注册表按通用数据形态存储定义；形状数据的具体结构由 resolveGeometry 在读取时校验 */
export class ShapeNodeType implements NodeTypeDefinition {
  static readonly TYPE = 'shape';

  readonly type = ShapeNodeType.TYPE;
  readonly label = '形状';
  readonly defaultData: ShapeData = { geometry: 'rectangle' };
  readonly defaultStyle: NodeStyle = { strokeWidth: 2 };
  readonly sizingPolicy: NodeSizingPolicy = 'fixed';
  readonly slots: NodeTextSlotDefinition[] = [
    {
      slot: LABEL_SLOT,
      label: '标签',
      defaultStyle: {
        fontSize: 16,
        lineHeight: 1.4,
        textAlign: 'center',
        verticalAlign: 'middle',
        textOverflow: 'ellipsis',
        padding: 12
      }
    }
  ];

  /** 新形状：默认矩形；默认带标签文本块以便双击编辑 */
  createContent(options: ShapeCreateOptions): NodeCreateContent {
    return {
      width: SHAPE_DEFAULT_SIZE.width,
      height: SHAPE_DEFAULT_SIZE.height,
      data: { geometry: options.geometry ?? 'rectangle' },
      textBlocks: [{ id: LABEL_SLOT, slot: LABEL_SLOT, runs: [{ text: options.label ?? '' }] }]
    };
  }

  outline(node: NodeEntity): Point[] {
    return GEOMETRY_OUTLINES[resolveGeometry(node)](node.width, node.height);
  }

  compose(node: NodeEntity, { theme }: NodeComposeContext): CanvasPrimitive[] {
    const style = resolveNodeStyle(node, this);
    const paint: ShapePaint = {
      fill: typeof style.fill === 'string' ? style.fill : theme.nodeFill,
      stroke: style.stroke ?? theme.nodeStroke,
      strokeWidth: style.strokeWidth,
      strokeDashArray: style.strokeDashArray,
      strokeCap: style.strokeCap,
      strokeJoin: style.strokeJoin
    };
    const shape = GEOMETRY_BUILDERS[resolveGeometry(node)](node.width, node.height, paint, style.radius);
    const primitives: CanvasPrimitive[] = [shape];

    const block = node.textBlocks?.find((b) => b.slot === LABEL_SLOT);
    if (block) {
      const textStyle = resolveTextBlockStyle(node, block, this);
      const padding = resolveTextPadding(textStyle.padding);
      primitives.push(
        createTextBlockPrimitive(block, textStyle, {
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
