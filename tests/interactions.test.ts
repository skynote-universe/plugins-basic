/**
 * @file interactions.test.ts
 * @description 基础交互：点选 / 加选 / 框选 / 拖拽移动、视口平移与缩放、编辑快捷键、选中框覆盖层
 */

import { describe, it, expect } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasKeyboardEvent,
  type CanvasPrimitive,
  type IHostBridge,
  type NodeEntity,
  type OverlayChannel,
  type OverlayOptions,
  type Point,
  type SystemCursor
} from '@skynote/core';
import {
  BasicNodesPlugin,
  EditingShortcutsPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  ViewportNavigationPlugin,
  SELECTION_PLUGIN_ID
} from '../src';

/** 记录光标与指针捕获的假宿主桥 (视口 1000 x 800) */
class FakeHostBridge implements IHostBridge {
  readonly cursors: SystemCursor[] = [];
  readonly captured = new Set<number>();

  getViewportRect(): { width: number; height: number } {
    return { width: 1000, height: 800 };
  }

  setCursor(cursor: SystemCursor): void {
    this.cursors.push(cursor);
  }

  capturePointer(pointerId: number): void {
    this.captured.add(pointerId);
  }

  releasePointer(pointerId: number): void {
    this.captured.delete(pointerId);
  }

  destroy(): void {}
}

/** 按会话记录当前覆盖层图元的假覆盖层 */
class FakeOverlay implements OverlayChannel {
  readonly sessions = new Map<string, { primitives: readonly CanvasPrimitive[]; transient: boolean }>();

  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    if (primitives.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { primitives, transient: options?.transient ?? false });
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** 画布：a (0,0) 与 b (300,0) 两个 160x100 形状，c 在容器 frame (0,400) 内 */
function setup() {
  const engine = new SkyNoteEngine()
    .use(new BasicNodesPlugin())
    .use(new ViewportNavigationPlugin())
    .use(new SelectionPlugin())
    .use(new SelectionOutlinePlugin())
    .use(new EditingShortcutsPlugin());
  const bridge = new FakeHostBridge();
  const overlay = new FakeOverlay();
  engine.attachHost({ bridge, overlay });
  const store = engine.documentStore;
  engine.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0 });
  engine.createNode({ nodeType: 'shape', id: 'b', x: 300, y: 0 });
  engine.createNode({ nodeType: 'shape', id: 'frame', x: 0, y: 400, width: 400, height: 300 });
  engine.createNode({ nodeType: 'shape', id: 'c', x: 20, y: 20, parentId: 'frame' });
  store.clearHistory();
  return { engine, store, overlay: overlay.sessions, cursors: bridge.cursors, captured: bridge.captured };
}

type Engine = SkyNoteEngine;

/** 视口为单位矩阵时屏幕坐标 = 世界坐标，指针落点直接给世界坐标即可 */
function pointer(
  engine: Engine,
  phase: 'down' | 'move' | 'up',
  point: Point,
  init: Partial<{ shift: boolean; button: number; client: Point }> = {}
) {
  const { x, y, zoom } = engine.session.viewport;
  const client = init.client ?? { x: point.x * zoom + x, y: point.y * zoom + y };
  const event = new SyntheticPointerEvent({
    point,
    clientPoint: client,
    target: engine.hitTestNode(point) as NodeEntity | undefined,
    button: init.button ?? 0,
    modifiers: { shift: init.shift ?? false }
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

function key(engine: Engine, code: string, init: Partial<CanvasKeyboardEvent> = {}, phase: 'down' | 'up' = 'down') {
  const event: CanvasKeyboardEvent = {
    key: init.key ?? code,
    code,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...init
  };
  return phase === 'down' ? engine.inputScopes.dispatchKeyDown(event) : engine.inputScopes.dispatchKeyUp(event);
}

const selection = (engine: Engine) => [...engine.session.selectedNodeIds].sort();

describe('点选与加选', () => {
  it('单击选中、Shift 加选与反选、单击空白清空', () => {
    const { engine } = setup();
    pointer(engine, 'down', { x: 10, y: 10 });
    pointer(engine, 'up', { x: 10, y: 10 });
    expect(selection(engine)).toEqual(['a']);

    pointer(engine, 'down', { x: 310, y: 10 }, { shift: true });
    pointer(engine, 'up', { x: 310, y: 10 }, { shift: true });
    expect(selection(engine)).toEqual(['a', 'b']);

    pointer(engine, 'down', { x: 10, y: 10 }, { shift: true });
    pointer(engine, 'up', { x: 10, y: 10 }, { shift: true });
    expect(selection(engine)).toEqual(['b']);

    pointer(engine, 'down', { x: 700, y: 300 });
    pointer(engine, 'up', { x: 700, y: 300 });
    expect(selection(engine)).toEqual([]);
  });

  it('多选中单击其中一个 (未拖拽) 抬起后只选它；按下时不收窄，便于拖动整组', () => {
    const { engine } = setup();
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    pointer(engine, 'down', { x: 10, y: 10 });
    expect(selection(engine)).toEqual(['a', 'b']);
    pointer(engine, 'up', { x: 10, y: 10 });
    expect(selection(engine)).toEqual(['a']);
  });

  it('点在容器内的子节点上直接选中子节点', () => {
    const { engine } = setup();
    pointer(engine, 'down', { x: 30, y: 430 });
    pointer(engine, 'up', { x: 30, y: 430 });
    expect(selection(engine)).toEqual(['c']);
  });
});

describe('拖拽移动', () => {
  it('超过阈值后移动整个选区 (容器带着子节点)，一次拖拽一步撤销', () => {
    const { engine, store, cursors } = setup();
    engine.session.setSelection({ nodeIds: ['a', 'frame'] });
    pointer(engine, 'down', { x: 10, y: 10 });
    for (let i = 1; i <= 10; i++) pointer(engine, 'move', { x: 10 + i * 5, y: 10 + i * 2 });
    pointer(engine, 'up', { x: 60, y: 30 });

    expect(store.getNode('a')).toMatchObject({ x: 50, y: 20 });
    expect(store.getNode('frame')).toMatchObject({ x: 50, y: 420 });
    // 子节点局部坐标不变，随容器移动
    expect(store.getNode('c')).toMatchObject({ x: 20, y: 20 });
    expect(cursors).toContain('move');
    expect(store.coordinator.getUndoEntries()).toHaveLength(1);

    store.undo();
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
    expect(store.getNode('frame')).toMatchObject({ x: 0, y: 400 });
  });

  it('阈值内的抖动不产生移动事务；锁定节点不随选区移动', () => {
    const { engine, store } = setup();
    pointer(engine, 'down', { x: 10, y: 10 });
    pointer(engine, 'move', { x: 11, y: 11 });
    pointer(engine, 'up', { x: 11, y: 11 });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
    expect(store.canUndo).toBe(false);

    store.updateNode('b', { locked: true }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    pointer(engine, 'down', { x: 10, y: 10 });
    pointer(engine, 'move', { x: 110, y: 10 });
    pointer(engine, 'up', { x: 110, y: 10 });
    expect(store.getNode('a')!.x).toBe(100);
    expect(store.getNode('b')!.x).toBe(300);
  });
});

describe('框选', () => {
  it('从空白处拖出选框：选中相交的根层级节点，命中子节点时选中其容器；选框为瞬态覆盖层，松手清除', () => {
    const { engine, overlay } = setup();
    pointer(engine, 'down', { x: -50, y: 50 });
    pointer(engine, 'move', { x: 350, y: 450 });
    expect(overlay.get('selection:marquee')?.transient).toBe(true);
    expect(selection(engine)).toEqual(['a', 'b', 'frame']);

    // 选框缩回时选区随之缩小
    pointer(engine, 'move', { x: 100, y: 90 });
    expect(selection(engine)).toEqual(['a']);
    pointer(engine, 'up', { x: 100, y: 90 });
    expect(overlay.has('selection:marquee')).toBe(false);
  });

  it('Shift 框选在原选区基础上追加', () => {
    const { engine } = setup();
    engine.session.setSelection({ nodeIds: ['b'] });
    pointer(engine, 'down', { x: -50, y: 50 }, { shift: true });
    pointer(engine, 'move', { x: 100, y: 90 }, { shift: true });
    pointer(engine, 'up', { x: 100, y: 90 }, { shift: true });
    expect(selection(engine)).toEqual(['a', 'b']);
  });
});

describe('视口导航', () => {
  it('按住空格拖拽平移画布 (按屏幕像素)，期间不触发框选；中键同样平移', () => {
    const { engine, cursors } = setup();
    key(engine, 'Space', { key: ' ' });
    expect(cursors.at(-1)).toBe('grab');
    pointer(engine, 'down', { x: 700, y: 300 });
    pointer(engine, 'move', { x: 700, y: 300 }, { client: { x: 760, y: 280 } });
    pointer(engine, 'up', { x: 700, y: 300 }, { client: { x: 760, y: 280 } });
    expect(engine.session.viewport).toMatchObject({ x: 60, y: -20 });
    key(engine, 'Space', { key: ' ' }, 'up');
    expect(cursors.at(-1)).toBe('default');

    engine.session.setSelection({ nodeIds: ['a'] });
    pointer(engine, 'down', { x: 10, y: 10 }, { button: 1, client: { x: 70, y: -10 } });
    pointer(engine, 'move', { x: 10, y: 10 }, { button: 1, client: { x: 90, y: -10 } });
    pointer(engine, 'up', { x: 10, y: 10 }, { button: 1, client: { x: 90, y: -10 } });
    expect(engine.session.viewport.x).toBe(80);
    // 中键落在节点上也只平移，不改变选区、不移动节点
    expect(selection(engine)).toEqual(['a']);
    expect(engine.documentStore.getNode('a')!.x).toBe(0);
  });

  it('Ctrl + = / - / 0 以视口中心缩放，Shift + 1 适配全部内容', () => {
    const { engine } = setup();
    key(engine, 'Equal', { key: '=', ctrlKey: true });
    const { x, y, zoom } = engine.session.viewport;
    expect(zoom).toBeCloseTo(1.2);
    // 视口中心 (500, 400) 的世界点保持不动
    expect(500 * zoom + x).toBeCloseTo(500);
    expect(400 * zoom + y).toBeCloseTo(400);

    key(engine, 'Digit0', { key: '0', ctrlKey: true });
    expect(engine.session.viewport.zoom).toBeCloseTo(1);

    key(engine, 'Digit1', { key: '!', shiftKey: true });
    // 内容 460 x 700 (含容器)，可用高度 800 - 160
    expect(engine.session.viewport.zoom).toBeCloseTo(640 / 700);
  });
});

describe('编辑快捷键', () => {
  it('删除选中 (跳过锁定节点)、撤销重做、全选、Esc 清空且不吞掉按键', () => {
    const { engine, store } = setup();
    store.updateNode('b', { locked: true }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    expect(key(engine, 'Delete', { key: 'Delete' })).toBe(true);
    expect(store.getNode('a')).toBeUndefined();
    expect(store.getNode('b')).toBeDefined();

    key(engine, 'KeyZ', { key: 'z', ctrlKey: true });
    expect(store.getNode('a')).toBeDefined();
    key(engine, 'KeyZ', { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(store.getNode('a')).toBeUndefined();
    key(engine, 'KeyY', { key: 'y', ctrlKey: true });
    key(engine, 'KeyZ', { key: 'z', metaKey: true });
    expect(store.getNode('a')).toBeDefined();

    key(engine, 'KeyA', { key: 'a', ctrlKey: true });
    expect(selection(engine)).toEqual(['a', 'b', 'frame']);
    expect(key(engine, 'Escape', { key: 'Escape' })).toBe(false);
    expect(selection(engine)).toEqual([]);
  });

  it('] [ 调整层级 (Shift 置顶置底)，方向键微移 (Shift 10)', () => {
    const { engine, store } = setup();
    engine.session.setSelection({ nodeIds: ['a'] });
    const order = () =>
      [...engine.entityStore.getChildIds(undefined)]
        .map((id) => store.getNode(id)!)
        .sort((l, r) => (l.zIndex < r.zIndex ? -1 : 1))
        .map((n) => n.id);
    key(engine, 'BracketRight', { key: ']' });
    expect(order()).toEqual(['b', 'a', 'frame']);
    key(engine, 'BracketRight', { key: '}', shiftKey: true });
    expect(order()).toEqual(['b', 'frame', 'a']);
    key(engine, 'BracketLeft', { key: '{', shiftKey: true });
    expect(order()).toEqual(['a', 'b', 'frame']);

    key(engine, 'ArrowRight', { key: 'ArrowRight' });
    key(engine, 'ArrowDown', { key: 'ArrowDown', shiftKey: true });
    expect(store.getNode('a')).toMatchObject({ x: 1, y: 10 });
  });

  it('没有选区时删除与方向键不消费按键 (交给页面或其他作用域)', () => {
    const { engine } = setup();
    expect(key(engine, 'Delete', { key: 'Delete' })).toBe(false);
    expect(key(engine, 'ArrowLeft', { key: 'ArrowLeft' })).toBe(false);
  });
});

describe('选中框', () => {
  it('沿每个选中节点的真实外框绘制，线宽按缩放换算；选中节点移动时跟随，清空选区即清除', () => {
    const { engine, store, overlay } = setup();
    store.updateNode('frame', { rotation: 90 }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'c'] });
    let outline = overlay.get('selection:outline')!;
    expect(outline.transient).toBe(false);
    expect(outline.primitives).toHaveLength(2);
    expect(outline.primitives[0]).toMatchObject({
      kind: 'polygon',
      points: [0, 0, 160, 0, 160, 100, 0, 100],
      strokeWidth: 1.5
    });
    // c 随旋转 90° 的容器旋转：局部 (0,0) 落在世界 (400 - 20 - ... ) 处，四角不再轴对齐
    const cPoints = (outline.primitives[1] as { points: number[] }).points;
    expect(cPoints[0]).not.toBe(cPoints[6]);

    engine.session.setViewport({ zoom: 2 });
    expect((overlay.get('selection:outline')!.primitives[0] as { strokeWidth: number }).strokeWidth).toBe(0.75);

    store.moveNodes(['a'], { x: 10 });
    outline = overlay.get('selection:outline')!;
    expect((outline.primitives[0] as { points: number[] }).points[0]).toBe(10);

    engine.session.setSelection({ nodeIds: [] });
    expect(overlay.has('selection:outline')).toBe(false);
  });

  it('卸载插件时清除它绘制的覆盖层', () => {
    const { engine, overlay } = setup();
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(overlay.has('selection:outline')).toBe(true);
    engine.plugins.remove('@skynote/plugins-basic/selection-outline');
    expect(overlay.has('selection:outline')).toBe(false);
    expect(engine.plugins.get(SELECTION_PLUGIN_ID)).toBeDefined();
  });
});
