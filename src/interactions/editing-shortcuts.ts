/**
 * @file editing-shortcuts.ts
 * @description 编辑快捷键：删除、撤销重做、全选、取消选择、层级调整、方向键微移、切换比例锁定
 *
 * 设计考量 (Why):
 * 1. 全部注册到焦点栈 (ADR-005)，只在画布持有焦点时生效；文本编辑等更高优先级作用域先行消费，
 *    打字时的 Backspace、方向键不会误删节点或移动节点。
 * 2. 操作选区中的节点，锁定节点不参与删除、移动与层级调整。
 * 3. Esc 清空选区后不消费按键，让更低优先级的兜底 (清除瞬态图元) 继续执行。
 */

import {
  isAspectLocked,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type LayerMove,
  type SkyNotePlugin
} from '@skynote/core';

export const EDITING_SHORTCUTS_PLUGIN_ID = '@skynote/plugins-basic/editing-shortcuts';
/** 方向键微移的世界距离：普通 1，按住 Shift 为 10 */
const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;

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
    const mod = e.ctrlKey || e.metaKey;
    const { document, session, entities } = this.ctx;

    if (mod && e.code === 'KeyZ') {
      if (e.shiftKey) document.redo();
      else document.undo();
    } else if (mod && e.code === 'KeyY') {
      document.redo();
    } else if (mod && e.code === 'KeyA') {
      session.setSelection({ nodeIds: entities.getChildIds(undefined), connectorIds: [] });
    } else if (e.key === 'Escape') {
      session.setSelection({ nodeIds: [], connectorIds: [] });
      return false;
    } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      const ids = this.editableSelection();
      if (ids.length === 0) return false;
      document.removeNodes(ids);
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
      const ids = this.editableSelection();
      if (ids.length === 0) return false;
      const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
      const direction = ARROW_DELTAS[e.key];
      document.moveNodes(ids, { x: direction.x * step, y: direction.y * step }, { label: '微移节点' });
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
}
