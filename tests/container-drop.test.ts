/**
 * @file container-drop.test.ts
 * @description 画框与拖入拖出 (ADR-123)：拖动中高亮目标、松手改挂且世界位置不变、一步撤销、标题拾取
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasHost,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type Point,
  type TextInputSession
} from '@skynote/core';
import { BasicNodesPlugin, SelectionPlugin, TextEditPlugin, TransformPlugin } from '../src';

class FakeHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, readonly CanvasPrimitive[]>();
  get overlay(): OverlayChannel {
    return this;
  }
  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[]): void {
    if (primitives.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, primitives);
  }
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
  setCursor(): void {}
  capturePointer(): void {}
  releasePointer(): void {}
  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

/** 画框 F (500, 0) 300 × 200 内有子节点 c；根层级形状 a (0, 0) 160 × 100 */
function setup(frameRotation = 0) {
  const engine = new SkyNoteEngine({ fonts: { measureWidth: (text, font) => text.length * font.size * 0.5 } })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin())
    .use(new TextEditPlugin());
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1600, height: 1000 });
  const store = engine.documentStore;
  store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0 });
  store.createNode({ nodeType: 'frame', id: 'F', x: 500, y: 0, width: 300, height: 200, rotation: frameRotation });
  store.createNode({ nodeType: 'shape', id: 'c', x: 20, y: 20, width: 60, height: 40, parentId: 'F' });
  store.clearHistory();
  return { engine, host, store };
}

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point, clickCount = 1): void {
  const event = new SyntheticPointerEvent({
    point,
    clickCount,
    target: engine.hitTestNode(point) as NodeEntity | undefined,
    // 按住 Ctrl 关闭吸附：这里验证落点的世界位置，不让附近节点把它吸过去
    modifiers: { ctrl: true }
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

/** 从 from 拖到 to (分几步移动)；返回松手前的覆盖层是否高亮了拖放目标 */
function drag(engine: SkyNoteEngine, host: FakeHost, from: Point, to: Point): boolean {
  pointer(engine, 'down', from);
  for (let i = 1; i <= 4; i++) {
    pointer(engine, 'move', { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 });
  }
  const highlighted = host.sessions.has('selection:drop-target');
  pointer(engine, 'up', to);
  return highlighted;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('拖入拖出画框', () => {
  it('拖入画框：拖动中高亮目标，松手改挂且世界位置不变；改挂与移动一步撤销', () => {
    const { engine, host, store } = setup();
    expect(drag(engine, host, { x: 10, y: 10 }, { x: 610, y: 110 })).toBe(true);
    expect(store.getNode('a')!.parentId).toBe('F');
    // 世界位置与拖到的位置一致 (按下点偏移 10, 10)
    expect(engine.getNodeWorldBounds('a')).toMatchObject({ left: 600, top: 100 });
    expect(host.sessions.has('selection:drop-target')).toBe(false);

    store.undo();
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
    expect(store.getNode('a')!.parentId).toBeUndefined();
  });

  it('拖出到空白处移出到根层级；旋转画框中拖入拖出世界位置同样不变', () => {
    const { engine, host, store } = setup(30);
    const before = engine.getNodeWorldBounds('c')!;
    const grab = { x: (before.left + before.right) / 2, y: (before.top + before.bottom) / 2 };
    expect(drag(engine, host, grab, { x: grab.x, y: grab.y + 600 })).toBe(false);
    expect(store.getNode('c')!.parentId).toBeUndefined();
    const after = engine.getNodeWorldBounds('c')!;
    expect(after.left).toBeCloseTo(before.left);
    expect(after.top).toBeCloseTo(before.top + 600);

    // 再拖回旋转画框的中心
    drag(engine, host, { x: grab.x, y: grab.y + 600 }, { x: 650, y: 150 });
    expect(store.getNode('c')!.parentId).toBe('F');
    const back = engine.getNodeWorldBounds('c')!;
    expect((back.left + back.right) / 2).toBeCloseTo(650);
    expect((back.top + back.bottom) / 2).toBeCloseTo(150);
  });

  it('画框不会被拖进自身或其后代；不接收拖入的父节点中的子节点不会被拖出', () => {
    const { engine, host, store } = setup();
    // 拖动画框本身 (按在标题带上)，落点仍在画框原范围内
    drag(engine, host, { x: 520, y: -8 }, { x: 560, y: 30 });
    expect(store.getNode('F')!.parentId).toBeUndefined();

    store.createNode({ nodeType: 'shape', id: 'box', x: 0, y: 400, width: 300, height: 200 });
    store.createNode({ nodeType: 'shape', id: 'inner', x: 10, y: 10, width: 50, height: 50, parentId: 'box' });
    drag(engine, host, { x: 30, y: 430 }, { x: 30, y: 900 });
    expect(store.getNode('inner')!.parentId).toBe('box');
  });
});

describe('画框标题', () => {
  it('点在框外标题带上选中画框；双击标题编辑标题，双击框内空白不进入编辑', () => {
    const { engine, store } = setup();
    expect(engine.hitTestNode({ x: 510, y: -8 })?.id).toBe('F');
    expect(engine.hitTestNode({ x: 510, y: -40 })).toBeUndefined();

    pointer(engine, 'down', { x: 700, y: 150 });
    pointer(engine, 'up', { x: 700, y: 150 });
    pointer(engine, 'down', { x: 700, y: 150 }, 2);
    pointer(engine, 'up', { x: 700, y: 150 }, 2);
    expect(engine.session.textEditing).toBeNull();

    pointer(engine, 'down', { x: 505, y: -8 });
    pointer(engine, 'up', { x: 505, y: -8 });
    pointer(engine, 'down', { x: 505, y: -8 }, 2);
    expect(engine.session.textEditing).toMatchObject({ kind: 'node', id: 'F', blockId: 'title' });
    expect(store.getNode('F')!.textBlocks![0].runs[0].text).toBe('画框');
  });
});

describe('画框体验增强 (ADR-145 阶段二)', () => {
  it('新建画框时自动收纳完全落入外框内的同层节点，保持世界坐标不变，一步撤销整体还原', () => {
    const { engine, store } = setup();
    // a 在 (0, 0) 160x100，再建一个 s2 在 (180, 20) 80x60，以及超出范围的 out 在 (350, 0) 100x100
    store.createNode({ nodeType: 'shape', id: 's2', x: 180, y: 20, width: 80, height: 60 });
    store.createNode({ nodeType: 'shape', id: 'out', x: 350, y: 0, width: 100, height: 100 });
    store.clearHistory();

    const beforeA = engine.getNodeWorldBounds('a')!;
    const beforeS2 = engine.getNodeWorldBounds('s2')!;

    // 在 (-20, -20) 创建 320x200 的画框 wrapFrame，正好完全包裹 a 与 s2，但不完全包含 out
    const frameId = store.createNode({
      nodeType: 'frame',
      id: 'wrapFrame',
      x: -20,
      y: -20,
      width: 320,
      height: 200
    });
    expect(frameId).toBe('wrapFrame');
    expect(store.getNode('a')?.parentId).toBe('wrapFrame');
    expect(store.getNode('s2')?.parentId).toBe('wrapFrame');
    expect(store.getNode('out')?.parentId).toBeUndefined();
    expect(engine.getNodeWorldBounds('a')).toEqual(beforeA);
    expect(engine.getNodeWorldBounds('s2')).toEqual(beforeS2);

    // 一步撤销同时移除画框并恢复 a、s2 为根层级节点
    store.undo();
    expect(store.getNode('wrapFrame')).toBeUndefined();
    expect(store.getNode('a')?.parentId).toBeUndefined();
    expect(store.getNode('s2')?.parentId).toBeUndefined();
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
    expect(store.getNode('s2')).toMatchObject({ x: 180, y: 20 });
  });

  it('画框 fitContent 按 24px 内边距紧缩包裹子节点并保持子节点世界坐标不变，ungroupNodes 解散画框外壳', () => {
    const { engine, store } = setup();
    // F 在 (500, 0) 300x200，内部子节点 c 在局部 (20, 20) 60x40 (世界 520, 20)
    const beforeC = engine.getNodeWorldBounds('c')!;
    expect(store.canFitContent('F')).toBe(true);

    store.fitContent(['F']);
    // 紧缩后：c 的局部坐标变为 (24, 24)，F 尺寸变为 60 + 48 = 108, 40 + 48 = 88，F 世界位置变为 (520 - 24, 20 - 24) = (496, -4)
    expect(store.getNode('F')).toMatchObject({ x: 496, y: -4, width: 108, height: 88 });
    expect(store.getNode('c')).toMatchObject({ x: 24, y: 24 });
    expect(engine.getNodeWorldBounds('c')).toEqual(beforeC);
    expect(store.canFitContent('F')).toBe(false);

    // 解散画框外壳：释放 c 到根层级并保持世界坐标 (520, 20)，删除 F
    const released = store.ungroupNodes(['F']);
    expect(released).toEqual(['c']);
    expect(store.getNode('F')).toBeUndefined();
    expect(store.getNode('c')?.parentId).toBeUndefined();
    expect(engine.getNodeWorldBounds('c')).toEqual(beforeC);
  });
});
