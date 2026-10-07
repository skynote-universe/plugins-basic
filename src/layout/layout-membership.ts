/**
 * @file layout-membership.ts
 * @description 节点是否处在已安装布局的布局树中 (ADR-130)：选择 (拖入即加入) 与快速连接 (不显示「+」) 共用
 *
 * 设计考量 (Why):
 * 只看内核的通用布局概念，不针对任何具体布局；布局未安装时不排版，按普通节点对待。
 */

import { findLayoutRootId, type CanvasPluginContext } from '@skynote/core';

export function isInInstalledLayout(ctx: CanvasPluginContext, nodeId: string): boolean {
  const getNode = (id: string) => ctx.document.getNode(id);
  const rootId = findLayoutRootId(nodeId, getNode);
  const type = rootId === undefined ? undefined : getNode(rootId)?.layout?.type;
  return type !== undefined && ctx.layouts.get(type) !== undefined;
}
