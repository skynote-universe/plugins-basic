/**
 * @file content.ts
 * @description 组合 (Group)：无可见背景与边框的逻辑编组容器 (ADR-123, ADR-145)
 *
 * 设计考量 (Why):
 * 1. 与画框 (Frame) 职责分离：组合自身不绘制任何图元、不裁剪子节点 (clipChildren: false)，也不接收拖拽落入 (acceptsChildren: false)。
 * 2. 空白穿透：hitTest 与 intersectsBounds 始终返回 false，点选或框选组合内部的空白间隙时直接穿透，
 *    只有命中内部子图元时才由交互层按组合层级归并或双击下钻。
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

  /** 组合自身无填充与边框，空白区域不响应点选，由内部子节点触发拾取后向上归并 */
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
