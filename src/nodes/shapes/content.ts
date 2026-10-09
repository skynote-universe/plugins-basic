/**
 * @file content.ts
 * @description 基础形状：矩形、椭圆、菱形、三角形、星形，可带居中标签；尺寸固定，文字不改变外框 (ADR-111)
 *
 * 设计考量 (Why):
 * 1. 一个节点类型 + geometry 字段：切换形状只改数据，不必更换节点类型 (与 tldraw 的 geo 形状一致)；
 *    新增多边形形状只需在 POLYGONS 中加一个顶点函数，绘制与拾取轮廓共用它。
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

export const SHAPE_GEOMETRIES = ['rectangle', 'ellipse', 'diamond', 'triangle', 'star'] as const;
export type ShapeGeometry = (typeof SHAPE_GEOMETRIES)[number];

declare module '@skynote/core' {
  interface CustomNodeFields {
    geometry?: ShapeGeometry;
  }
}

export const SHAPE_DEFAULT_SIZE = { width: 160, height: 100 } as const;
/** 三角形、星形按 160×100 会被压扁，默认取方形 */
const SQUARE_DEFAULT_SIZE = { width: 120, height: 120 } as const;
const LABEL_SLOT = 'label';
/** 各几何共用的填充与描边 */
interface ShapePaint {
  fill: string;
  stroke: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: NodeStyle['strokeCap'];
  strokeJoin?: NodeStyle['strokeJoin'];
  fillOpacity?: number;
}

type PolygonGeometry = 'diamond' | 'triangle' | 'star';

/** 五角星内外顶点半径之比：取正五角星，边线两两共线 */
const STAR_INNER_RATIO = 0.382;
/** 单位圆上的正五角星 (尖朝上)：最高点 y = -1，最低的两个尖 y = cos 36°，按此纵向范围铺满外框 */
const STAR_UNIT_POINTS: readonly Point[] = Array.from({ length: 10 }, (_, i) => {
  const angle = -Math.PI / 2 + (i * Math.PI) / 5;
  const r = i % 2 === 0 ? 1 : STAR_INNER_RATIO;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
});
const STAR_HALF_WIDTH = Math.cos(Math.PI / 10);
const STAR_BOTTOM = Math.cos(Math.PI / 5);

/** 多边形形状的顶点 (局部坐标)：绘制与拾取轮廓共用 */
const POLYGONS: Record<PolygonGeometry, (w: number, h: number) => Point[]> = {
  diamond: (w, h) => [
    { x: w / 2, y: 0 },
    { x: w, y: h / 2 },
    { x: w / 2, y: h },
    { x: 0, y: h / 2 }
  ],
  triangle: (w, h) => [
    { x: w / 2, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ],
  star: (w, h) =>
    STAR_UNIT_POINTS.map((p) => ({
      x: ((p.x + STAR_HALF_WIDTH) / (2 * STAR_HALF_WIDTH)) * w,
      y: ((p.y + 1) / (1 + STAR_BOTTOM)) * h
    }))
};

/**
 * 声明了连线吸附点的形状：包围盒四边中点投影到三角形斜边上会偏向下方、投影到星形底部会落进两腿之间的凹处，
 * 改为三角形的顶点与各边中点、星形的五个尖角
 */
const GEOMETRY_ANCHORS: Partial<Record<ShapeGeometry, (w: number, h: number) => Point[]>> = {
  triangle: (w, h) => [
    { x: w / 2, y: 0 },
    { x: (w * 3) / 4, y: h / 2 },
    { x: w / 2, y: h },
    { x: w / 4, y: h / 2 }
  ],
  star: (w, h) => POLYGONS.star(w, h).filter((_, i) => i % 2 === 0)
};

function polygon(geometry: PolygonGeometry) {
  return (w: number, h: number, paint: ShapePaint): CanvasPrimitive => ({
    kind: 'polygon',
    points: POLYGONS[geometry](w, h).flatMap((p) => [p.x, p.y]),
    ...paint,
    strokeJoin: paint.strokeJoin ?? 'round'
  });
}

/** 形状轮廓：只描述几何，填充与描边统一传入；圆角只对矩形有意义 */
const GEOMETRY_BUILDERS: Record<
  ShapeGeometry,
  (w: number, h: number, paint: ShapePaint, radius: NodeStyle['radius']) => CanvasPrimitive
> = {
  rectangle: (w, h, paint, radius) => ({ kind: 'rect', x: 0, y: 0, width: w, height: h, radius, ...paint }),
  ellipse: (w, h, paint) => ({ kind: 'ellipse', cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...paint }),
  diamond: polygon('diamond'),
  triangle: polygon('triangle'),
  star: polygon('star')
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
  diamond: POLYGONS.diamond,
  triangle: POLYGONS.triangle,
  star: POLYGONS.star
};

function resolveGeometry(node: NodeEntity): ShapeGeometry {
  const geometry = node.geometry;
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
  readonly defaultData = {};
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
    const size =
      options.geometry === 'triangle' || options.geometry === 'star' ? SQUARE_DEFAULT_SIZE : SHAPE_DEFAULT_SIZE;
    return {
      width: size.width,
      height: size.height,
      geometry: options.geometry ?? 'rectangle',
      textBlocks: [{ id: LABEL_SLOT, slot: LABEL_SLOT, runs: [{ text: options.label ?? '' }] }]
    };
  }

  supportsCornerRadius(node: NodeEntity): boolean {
    return resolveGeometry(node) === 'rectangle';
  }

  anchors(node: NodeEntity): Point[] | undefined {
    return GEOMETRY_ANCHORS[resolveGeometry(node)]?.(node.width, node.height);
  }

  outline(node: NodeEntity): Point[] {
    return GEOMETRY_OUTLINES[resolveGeometry(node)](node.width, node.height);
  }

  compose(node: NodeEntity, { theme }: NodeComposeContext): CanvasPrimitive[] {
    const style = resolveNodeStyle(node, this);
    const paint: ShapePaint = {
      fill: typeof style.fill === 'string' ? style.fill : theme.nodeFill,
      stroke: style.stroke ?? theme.nodeStroke,
      strokeOpacity: style.strokeOpacity,
      strokeWidth: style.strokeWidth,
      strokeDashArray: style.strokeDashArray,
      strokeCap: style.strokeCap,
      strokeJoin: style.strokeJoin,
      fillOpacity: style.fillOpacity
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
