/**
 * @file editing-shortcuts.ts
 * @description 编辑快捷键：删除、撤销重做、全选、取消选择、创建副本、锁定、层级调整、方向键微移、切换比例锁定、
 *              Enter / F2 编辑选中节点的文字
 *
 * 设计考量 (Why):
 * 1. 全部注册到焦点栈 (ADR-005)，只在画布持有焦点时生效；文本编辑等更高优先级作用域先行消费，
 *    打字时的 Backspace、方向键不会误删节点或移动节点。
 * 2. 操作选区中的节点与连线，锁定的不参与删除、移动、复制与层级调整；锁定开关作用于全部选中节点 (否则无法解锁)。
 * 3. 锁定用 Ctrl+Shift+L：Ctrl+L 是浏览器聚焦地址栏的快捷键，常被浏览器或扩展抢先处理。
 * 4. Esc 清空选区后不消费按键，让更低优先级的兜底 (清除瞬态图元) 继续执行。
 * 5. Enter / F2 只发出编辑意图 (session.requestTextEditing)，由文字编辑插件决定如何进入；
 *    导图等更高优先级的作用域可先行把 Enter 用作别的操作 (插入同级主题)。
 */

import {
  isAspectLocked,
  type CanvasKeyboardEvent,
  type EntityIds,
  type CanvasPluginContext,
  type LayerMove,
  type SkyNotePlugin
} from '@skynote/core';

export const EDITING_SHORTCUTS_PLUGIN_ID = '@skynote/plugins-basic/editing-shortcuts';
/** 方向键微移的世界距离：普通 1，按住 Shift 为 10 */
const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;
/** 创建副本相对原节点的世界偏移 */
const DUPLICATE_OFFSET = { x: 20, y: 20 };

const ARROW_DELTAS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }
};

export class EditingShortcutsPlugin implements SkyNotePlugin {
  readonly id = EDITING_SHORTCUTS_PLUGIN_ID;
  readonly name = '编辑快捷键';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerInputScope({ id: 'canvas:editing', priority: 0, onKeyDown: (e) => this.onKeyDown(e) });
  }

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    if (this.ctx.session.isReadOnly) return false;
    const mod = e.ctrlKey || e.metaKey;
    const { document, session, entities } = this.ctx;

    if (mod && e.code === 'KeyZ') {
      if (e.shiftKey) document.redo();
      else document.undo();
    } else if (mod && e.code === 'KeyY') {
      document.redo();
    } else if (mod && e.code === 'KeyA') {
      session.setSelection({
        nodeIds: entities.getChildIds(undefined),
        connectorIds: entities.getAllConnectors().map((runtime) => runtime.entity.id)
      });
    } else if (mod && !e.shiftKey && e.code === 'KeyD') {
      const refs = this.editableEntities();
      if (refs.nodeIds.length + refs.connectorIds.length === 0) return false;
      const copies = document.duplicateEntities(refs, DUPLICATE_OFFSET);
      if (copies.nodeIds.length + copies.connectorIds.length > 0) session.setSelection(copies);
    } else if (mod && e.shiftKey && e.code === 'KeyL') {
      const nodeIds = [...session.selectedNodeIds];
      const connectorIds = [...session.selectedConnectorIds];
      if (nodeIds.length + connectorIds.length === 0) return false;
      // 全部已锁定时解锁，否则全部锁定 (与工具栏、右键菜单一致)
      const locked = !(
        nodeIds.every((id) => entities.getNode(id)!.entity.locked) &&
        connectorIds.every((id) => entities.getConnector(id)!.entity.locked)
      );
      document.batch(
        () => {
          document.updateNodes(nodeIds, { locked });
          document.updateConnectors(connectorIds, { locked });
        },
        locked ? '锁定' : '解锁'
      );
    } else if (!mod && !e.shiftKey && (e.key === 'Enter' || e.key === 'F2')) {
      const [nodeId, ...rest] = session.selectedNodeIds;
      const node = nodeId === undefined ? undefined : entities.getNode(nodeId)!.entity;
      if (!node || rest.length > 0 || node.locked || !node.textBlocks?.length) return false;
      session.requestTextEditing(node.id);
    } else if (e.key === 'Escape') {
      session.setSelection({ nodeIds: [], connectorIds: [] });
      return false;
    } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      const refs = this.editableEntities();
      if (refs.nodeIds.length + refs.connectorIds.length === 0) return false;
      document.removeEntities(refs);
    } else if (!mod && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      const ids = this.editableSelection();
      if (ids.length === 0) return false;
      const up = e.code === 'BracketRight';
      const move: LayerMove = e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward';
      document.moveLayers(ids, move);
    } else if (e.shiftKey && !mod && e.code === 'KeyL') {
      const ids = this.editableSelection();
      if (ids.length === 0) return false;
      // 全部已锁定时解锁，否则全部锁定 (与工具栏开关一致)
      const allLocked = ids.every((id) => {
        const node = entities.getNode(id)!.entity;
        return isAspectLocked(node, this.ctx.nodeTypes.get(node.nodeType));
      });
      document.setAspectLocked(ids, !allLocked);
    } else if (!mod && e.key in ARROW_DELTAS) {
      const refs = this.editableEntities();
      if (refs.nodeIds.length + refs.connectorIds.length === 0) return false;
      const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
      const direction = ARROW_DELTAS[e.key];
      document.moveEntities(refs, { x: direction.x * step, y: direction.y * step }, { label: '微移' });
    } else {
      return false;
    }
    // 阻止浏览器默认行为 (全选页面文字、Backspace 后退、方向键滚动页面)
    e.preventDefault();
    return true;
  }

  /** 选区中未锁定的节点 */
  private editableSelection(): string[] {
    const { session, entities } = this.ctx;
    return [...session.selectedNodeIds].filter((id) => !entities.getNode(id)?.entity.locked);
  }

  /** 选区中未锁定的节点与连线 */
  private editableEntities(): EntityIds {
    const { session, entities } = this.ctx;
    return {
      nodeIds: this.editableSelection(),
      connectorIds: [...session.selectedConnectorIds].filter((id) => !entities.getConnector(id)?.entity.locked)
    };
  }
}
