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
  defineNodeType,
  resolveTextBlockStyle,
  resolveTextPadding,
  type CanvasPrimitive,
  type FractionalIndex,
  type NodeEntity,
  type NodeStyle,
  type NodeTypeDefinition
} from '@skynote/core';

export const SHAPE_NODE_TYPE = 'shape';

export const SHAPE_GEOMETRIES = ['rectangle', 'ellipse', 'diamond'] as const;
export type ShapeGeometry = (typeof SHAPE_GEOMETRIES)[number];

export interface ShapeData extends Record<string, unknown> {
  geometry: ShapeGeometry;
}

export const SHAPE_DEFAULT_SIZE = { width: 160, height: 100 } as const;
const LABEL_SLOT = 'label';
const DEFAULT_STROKE_WIDTH = 2;

interface OutlineStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: NodeStyle['radius'];
}

/** 形状轮廓：只描述几何，颜色与线宽统一由样式传入 */
const GEOMETRY_BUILDERS: Record<ShapeGeometry, (w: number, h: number, style: OutlineStyle) => CanvasPrimitive> = {
  rectangle: (w, h, style) => ({ kind: 'rect', x: 0, y: 0, width: w, height: h, ...style }),
  ellipse: (w, h, { fill, stroke, strokeWidth }) => ({
    kind: 'ellipse',
    cx: w / 2,
    cy: h / 2,
    rx: w / 2,
    ry: h / 2,
    fill,
    stroke,
    strokeWidth
  }),
  diamond: (w, h, { fill, stroke, strokeWidth }) => ({
    kind: 'polygon',
    points: [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2],
    fill,
    stroke,
    strokeWidth,
    strokeJoin: 'round'
  })
};

function resolveGeometry(node: NodeEntity): ShapeGeometry {
  const geometry = (node.data as Partial<ShapeData> | undefined)?.geometry;
  return geometry !== undefined && geometry in GEOMETRY_BUILDERS ? geometry : 'rectangle';
}

// 注册表按通用数据形态存储定义；形状数据的具体结构由 resolveGeometry 在读取时校验
export const shapeNodeType: NodeTypeDefinition = defineNodeType<Record<string, unknown>>({
  type: SHAPE_NODE_TYPE,
  label: '形状',
  defaultData: { geometry: 'rectangle' },
  sizingPolicy: 'fixed',
  slots: [
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
  ],
  compose(node, { theme }) {
    const { style } = node;
    const outline = GEOMETRY_BUILDERS[resolveGeometry(node)](node.width, node.height, {
      fill: typeof style?.fill === 'string' ? style.fill : theme.nodeFill,
      stroke: style?.stroke ?? theme.nodeStroke,
      strokeWidth: style?.strokeWidth ?? DEFAULT_STROKE_WIDTH,
      radius: style?.radius
    });
    const primitives: CanvasPrimitive[] = [outline];

    const block = node.textBlocks?.find((b) => b.slot === LABEL_SLOT);
    if (block) {
      const textStyle = resolveTextBlockStyle(node, block, shapeNodeType);
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
});

export interface ShapeInit {
  id: string;
  /** 左上角 (父容器局部坐标) */
  x: number;
  y: number;
  zIndex: FractionalIndex;
  parentId?: string;
  geometry?: ShapeGeometry;
  label?: string;
}

export function createShapeNode(init: ShapeInit): NodeEntity {
  return {
    id: init.id,
    type: 'node',
    nodeType: SHAPE_NODE_TYPE,
    ...(init.parentId !== undefined && { parentId: init.parentId }),
    x: init.x,
    y: init.y,
    width: SHAPE_DEFAULT_SIZE.width,
    height: SHAPE_DEFAULT_SIZE.height,
    rotation: 0,
    zIndex: init.zIndex,
    locked: false,
    data: { geometry: init.geometry ?? 'rectangle' },
    ...(init.label !== undefined && {
      textBlocks: [{ id: LABEL_SLOT, slot: LABEL_SLOT, runs: [{ text: init.label }] }]
    })
  };
}
