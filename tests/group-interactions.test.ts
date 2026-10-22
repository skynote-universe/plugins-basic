/**
 * @file group-interactions.test.ts
 * @description ADR-145 组合 (Group) 交互测试：单击选中最外层组合、双击逐层下钻与文本编辑衔接、Ctrl/Cmd 深层直选、Escape 逐层上退、Mod+G/Mod+Shift+G 快捷键、组合控制柄拖拽缩放
 */

import { describe, it, expect } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasKeyboardEvent,
  type CanvasHost,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type OverlayOptions,
  type Point,
  type CanvasCursor,
  type TextInputSession
} from '@skynote/core';
import {
  BasicNodesPlugin,
  EditingShortcutsPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  TextEditPlugin,
  TransformPlugin,
  ViewportNavigationPlugin
} from '../src';

class FakeHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, { primitives: readonly CanvasPrimitive[]; transient: boolean }>();
  readonly cursors: CanvasCursor[] = [];
  readonly captured = new Set<number>();

  get overlay(): OverlayChannel {
    return this;
  }

  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    if (primitives.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { primitives, transient: options?.transient ?? false });
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setCursor(cursor: CanvasCursor): void {
    this.cursors.push(cursor);
  }

  capturePointer(pointerId: number): void {
    this.captured.add(pointerId);
  }

  releasePointer(pointerId: number): void {
    this.captured.delete(pointerId);
  }

  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

const fonts = { measureWidth: (text: string, font: { size: number }) => [...text].length * font.size * 0.5 };

function setup() {
  const engine = new SkyNoteEngine({ fonts })
    .use(new BasicNodesPlugin())
    .use(new ViewportNavigationPlugin())
    .use(new TransformPlugin())
    .use(new TextEditPlugin())
    .use(new SelectionPlugin())
    .use(new SelectionOutlinePlugin())
    .use(new EditingShortcutsPlugin());
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1000, height: 800 });
  const store = engine.documentStore;
  store.createNode({ nodeType: 'shape', id: 'a', x: 100, y: 100, width: 100, height: 80 });
  store.createNode({ nodeType: 'shape', id: 'b', x: 250, y: 100, width: 100, height: 80 });
  store.createNode({ nodeType: 'shape', id: 'c', x: 100, y: 240, width: 100, height: 80 });
  store.clearHistory();
  return { engine, store, host };
}

function pointer(
  engine: SkyNoteEngine,
  phase: 'down' | 'move' | 'up',
  point: Point,
  init: Partial<{ shift: boolean; alt: boolean; ctrl: boolean; meta: boolean; clickCount: number }> = {}
) {
  const { x, y, zoom } = engine.session.viewport;
  const client = { x: point.x * zoom + x, y: point.y * zoom + y };
  const event = new SyntheticPointerEvent({
    point,
    clientPoint: client,
    target: engine.hitTestNode(point) as NodeEntity | undefined,
    clickCount: init.clickCount ?? 1,
    modifiers: {
      shift: init.shift ?? false,
      alt: init.alt ?? false,
      ctrl: init.ctrl ?? false,
      meta: init.meta ?? false
    }
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

function key(engine: SkyNoteEngine, code: string, init: Partial<CanvasKeyboardEvent> = {}) {
  engine.inputScopes.dispatchKeyDown({
    key: init.key ?? code,
    code,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {}
  });
}

describe('ADR-145 组合 (Group) 交互行为', () => {
  it('Mod+G 成组并选中新组合，Mod+Shift+G 解组并选中原成员', () => {
    const { engine, store } = setup();
    engine.session.setSelection({ nodeIds: ['a', 'b'] });

    key(engine, 'KeyG', { key: 'g', ctrlKey: true });
    const selectedAfterGroup = [...engine.session.selectedNodeIds];
    expect(selectedAfterGroup).toHaveLength(1);
    const groupId = selectedAfterGroup[0];
    expect(store.getNode(groupId)?.nodeType).toBe('group');
    expect(store.getNode('a')?.parentId).toBe(groupId);
    expect(store.getNode('b')?.parentId).toBe(groupId);

    key(engine, 'KeyG', { key: 'G', ctrlKey: true, shiftKey: true });
    expect(store.getNode(groupId)).toBeUndefined();
    expect([...engine.session.selectedNodeIds].sort()).toEqual(['a', 'b']);
  });

  it('单击选中最外层组合，双击逐层下钻并在叶子层进入文本编辑，Escape 逐层退回父组合', () => {
    const { engine, store } = setup();
    const innerGroupId = store.groupNodes(['a', 'b'])!;
    const outerGroupId = store.groupNodes([innerGroupId, 'c'])!;

    // 1. 单击叶子节点 a (120, 120) -> 命中 a，但选区归约为最外层组合 outerGroupId
    pointer(engine, 'down', { x: 120, y: 120 }, { clickCount: 1 });
    pointer(engine, 'up', { x: 120, y: 120 }, { clickCount: 1 });
    expect([...engine.session.selectedNodeIds]).toEqual([outerGroupId]);
    expect(engine.session.textEditing).toBeNull();

    // 2. 在 outerGroupId 已选中的上下文下双击 a -> 下钻一层选中 innerGroupId，不直接进文本编辑
    pointer(engine, 'down', { x: 120, y: 120 }, { clickCount: 2 });
    pointer(engine, 'up', { x: 120, y: 120 }, { clickCount: 2 });
    expect([...engine.session.selectedNodeIds]).toEqual([innerGroupId]);
    expect(engine.session.textEditing).toBeNull();

    // 3. 在 innerGroupId 已选中的上下文下再次双击 a -> 下钻选中叶子节点 a
    pointer(engine, 'down', { x: 120, y: 120 }, { clickCount: 2 });
    pointer(engine, 'up', { x: 120, y: 120 }, { clickCount: 2 });
    expect([...engine.session.selectedNodeIds]).toEqual(['a']);
    expect(engine.session.textEditing).toBeNull();

    // 4. 叶子节点 a 已在选区上下文中，再次双击 a -> 进入 a 的文本编辑态
    pointer(engine, 'down', { x: 120, y: 120 }, { clickCount: 2 });
    pointer(engine, 'up', { x: 120, y: 120 }, { clickCount: 2 });
    expect(engine.session.textEditing?.id).toBe('a');

    // 5. Escape 先退出文本编辑，再按 Escape 退回 innerGroupId，再按退回 outerGroupId，最后清空选区
    key(engine, 'Escape');
    expect(engine.session.textEditing).toBeNull();
    expect([...engine.session.selectedNodeIds]).toEqual(['a']);

    key(engine, 'Escape');
    expect([...engine.session.selectedNodeIds]).toEqual([innerGroupId]);

    key(engine, 'Escape');
    expect([...engine.session.selectedNodeIds]).toEqual([outerGroupId]);

    key(engine, 'Escape');
    expect([...engine.session.selectedNodeIds]).toEqual([]);
  });

  it('Ctrl/Cmd + 单击直接穿透组合选中最深层叶子节点', () => {
    const { engine, store } = setup();
    const innerGroupId = store.groupNodes(['a', 'b'])!;
    store.groupNodes([innerGroupId, 'c']);

    pointer(engine, 'down', { x: 270, y: 120 }, { ctrl: true });
    pointer(engine, 'up', { x: 270, y: 120 }, { ctrl: true });
    expect([...engine.session.selectedNodeIds]).toEqual(['b']);
  });

  it('拖拽组合右下角控制柄时等比/按比例缩放组合内所有叶子节点并同步收敛组合外框', () => {
    const { engine, store } = setup();
    const groupId = store.groupNodes(['a', 'b'])!;
    engine.session.setSelection({ nodeIds: [groupId] });
    // group 初始外框: x=100, y=100, width=250 (100..350), height=80 (100..180)
    expect(store.getNode(groupId)).toMatchObject({ x: 100, y: 100, width: 250, height: 80 });

    // 拖拽东侧控制柄 (350, 140) 到 (600, 140)，宽度放大 2 倍 (250 -> 500)
    pointer(engine, 'down', { x: 350, y: 140 });
    pointer(engine, 'move', { x: 600, y: 140 }, { ctrl: true }); // ctrl 禁用吸附干扰
    pointer(engine, 'up', { x: 600, y: 140 });

    expect(store.getNode(groupId)).toMatchObject({ x: 100, y: 100, width: 500, height: 80 });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0, width: 200, height: 80 });
    expect(store.getNode('b')).toMatchObject({ x: 300, y: 0, width: 200, height: 80 });
  });
});
