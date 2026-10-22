/**
 * @file layout-membership.ts
 * @description 节点是否处在已安装布局的布局树中 (ADR-130)：选择 (拖入即加入)、快速连接 (不显示「+」)
 *              与变换 (成员没有旋转热区) 共用
 *
 * 设计考量 (Why):
 * 只看内核的通用布局概念，不针对任何具体布局；布局未安装时不排版，按普通节点对待。
 */

import { findLayoutRootId, findMemberRootId, type CanvasPluginContext } from '@skynote/core';
import { STACK_LAYOUT_ID } from './stack-layout';

const isInstalledRoot = (ctx: CanvasPluginContext, rootId: string | undefined): boolean => {
  const type = rootId === undefined ? undefined : ctx.document.getNode(rootId)?.layout?.type;
  return type !== undefined && ctx.layouts.get(type) !== undefined;
};

/** 是已安装布局的根或成员 */
export function isInInstalledLayout(ctx: CanvasPluginContext, nodeId: string): boolean {
  return isInstalledRoot(
    ctx,
    findLayoutRootId(nodeId, (id) => ctx.document.getNode(id))
  );
}

/** 是已安装布局的成员 (不含根)：位置与朝向由布局决定 */
export function isInstalledLayoutMember(ctx: CanvasPluginContext, nodeId: string): boolean {
  return isInstalledRoot(
    ctx,
    findMemberRootId(nodeId, (id) => ctx.document.getNode(id))
  );
}

/** 是自动堆叠布局 (stack) 的子成员：拖拽时节点本身实时跟随指针移动，并在容器内按落点动态换序 */
export function isStackLayoutMember(ctx: CanvasPluginContext, nodeId: string): boolean {
  const rootId = findMemberRootId(nodeId, (id) => ctx.document.getNode(id));
  if (!isInstalledRoot(ctx, rootId)) return false;
  return ctx.document.getNode(rootId!)?.layout?.type === STACK_LAYOUT_ID;
}

/** 节点是否可作为已安装布局的父节点接收拖入的子成员 (堆叠布局仅根容器接收，树形布局任意成员皆可接收) */
export function canAcceptLayoutChildren(ctx: CanvasPluginContext, nodeId: string): boolean {
  const rootId = findLayoutRootId(nodeId, (id) => ctx.document.getNode(id));
  if (!isInstalledRoot(ctx, rootId)) return false;
  const root = ctx.document.getNode(rootId!);
  if (root?.layout?.type === STACK_LAYOUT_ID && nodeId !== rootId) return false;
  return true;
}
