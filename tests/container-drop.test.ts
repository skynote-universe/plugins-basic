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
    target: engine.hitTestNode(point) as NodeEntity | undefined
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
    expect(engine.session.textEditing).toMatchObject({ nodeId: 'F', blockId: 'title' });
    expect(store.getNode('F')!.textBlocks![0].runs[0].text).toBe('画框');
  });
});
