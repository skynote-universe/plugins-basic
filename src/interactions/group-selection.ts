/**
 * @file group-selection.ts
 * @description 组合 (Group) 选区归并、双击逐层下钻与 Escape 退回上层纯函数 (ADR-145)
 */

import { GROUP_NODE_TYPE, type CanvasPluginContext, type Point } from '@skynote/core';

/** 真实实体未命中后才查询编组空隙，复用空间索引，避免指针移动时扫描全部节点。 */
export function hitGroupBounds(ctx: CanvasPluginContext, point: Point): string | undefined {
  let result: string | undefined;
  let area = Infinity;
  for (const id of ctx.spatial.search({ left: point.x, top: point.y, right: point.x, bottom: point.y })) {
    if (ctx.entities.getNode(id)?.entity.nodeType !== GROUP_NODE_TYPE) continue;
    const target = resolveGroupTarget(ctx, id);
    const bounds = ctx.spatial.getBounds(target)!;
    const nextArea = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
    if (nextArea < area) {
      result = target;
      area = nextArea;
    }
  }
  return result;
}

export interface ResolveGroupTargetOptions {
  /** 按住 Ctrl / Cmd 时直接穿透选中最底层叶子节点 */
  deep?: boolean;
  /** 双击时在当前已选中的组合层级上向下进入一层 */
  drillDown?: boolean;
}

/**
 * 从命中节点向上收集连续的组合 (group) 祖先链：[hitNodeId, innerGroupId, ..., outerGroupId]
 * 遇到根层级或非组合容器 (如画框 Frame) 即停止，因为画框内的子节点本就可直接点选。
 */
export function getGroupChain(ctx: CanvasPluginContext, hitNodeId: string): string[] {
  const chain = [hitNodeId];
  for (const ancestorId of ctx.entities.getAncestorIds(hitNodeId)) {
    const ancestor = ctx.entities.getNode(ancestorId)?.entity;
    if (!ancestor || ancestor.nodeType !== GROUP_NODE_TYPE) break;
    chain.push(ancestorId);
  }
  return chain;
}

/**
 * 根据当前选区上下文解析命中节点应归并到的目标节点 id：
 * 1. deep 为 true 时直接返回 hitNodeId；
 * 2. 若选区中已有某层组合的后代被选中，说明用户已下钻到该组合内部，单击维持在该组合的直接子层级；
 * 3. 否则单击归并到最外层组合；
 * 4. drillDown 为 true 且当前层级的组合已被选中时，向下一层进入其直接子节点。
 */
export function resolveGroupTarget(
  ctx: CanvasPluginContext,
  hitNodeId: string,
  options?: ResolveGroupTargetOptions
): string {
  if (options?.deep) return hitNodeId;
  const chain = getGroupChain(ctx, hitNodeId);
  if (chain.length === 1) return hitNodeId;

  const selected = ctx.session.selectedNodeIds;
  const isInsideGroup = (groupId: string): boolean => {
    for (const selId of selected) {
      if (ctx.entities.getAncestorIds(selId).includes(groupId)) return true;
    }
    return false;
  };

  let currentLevel = chain.length - 1;
  for (let i = 1; i < chain.length; i++) {
    if (isInsideGroup(chain[i])) {
      currentLevel = i - 1;
      break;
    }
  }

  if (options?.drillDown && currentLevel > 0 && selected.has(chain[currentLevel])) {
    return chain[currentLevel - 1];
  }
  return chain[currentLevel];
}

/**
 * 若当前选中的全部实体均为同一父组合 (group) 的直接子节点，返回该父组合 id (供 Escape 退回上一层组合)；
 * 否则返回 null。
 */
export function resolveParentGroupId(ctx: CanvasPluginContext): string | null {
  const { session, entities } = ctx;
  if (session.selectedConnectorIds.size > 0 || session.selectedNodeIds.size === 0) return null;
  let sharedParentGroupId: string | null = null;
  for (const id of session.selectedNodeIds) {
    const node = entities.getNode(id)?.entity;
    if (!node?.parentId) return null;
    const parent = entities.getNode(node.parentId)?.entity;
    if (!parent || parent.nodeType !== GROUP_NODE_TYPE) return null;
    if (sharedParentGroupId === null) sharedParentGroupId = parent.id;
    else if (sharedParentGroupId !== parent.id) return null;
  }
  return sharedParentGroupId;
}
