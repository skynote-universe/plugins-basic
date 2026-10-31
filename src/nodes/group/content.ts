/**
 * @file content.ts
 * @description 组合 (Group)：无可见背景与边框的逻辑编组容器 (ADR-123, ADR-145)
 *
 * 设计考量 (Why):
 * 1. 与画框 (Frame) 职责分离：组合自身不绘制任何图元、不裁剪子节点 (clipChildren: false)，也不接收拖拽落入 (acceptsChildren: false)。
 * 2. 本体拾取保持穿透；交互层在真实实体未命中时以空间索引查询编组空隙，成员命中仍按层级归并或双击下钻。
 * 3. 组合只通过已有节点编组生成，不提供空节点新建接口；外框由事务内容器依赖派生自动紧缩。
 */

import { GROUP_NODE_TYPE, type CanvasPrimitive, type NodeSizingPolicy, type NodeTypeDefinition } from '@skynote/core';

export class GroupNodeType implements NodeTypeDefinition {
  static readonly TYPE = GROUP_NODE_TYPE;

  readonly type = GroupNodeType.TYPE;
  readonly label = '组合';
  readonly defaultData = {};
  readonly sizingPolicy: NodeSizingPolicy = 'fixed';
  readonly clipChildren = false;
  readonly acceptsChildren = false;

  /** 原生实体命中保持穿透，空隙整体选择由通用交互层处理。 */
  hitTest(): boolean {
    return false;
  }

  /** 框选接触组合空白外框角时不触发选中，仅在框中内部子节点时归并选中组合 */
  intersectsBounds(): boolean {
    return false;
  }

  compose(): CanvasPrimitive[] {
    return [];
  }
}
