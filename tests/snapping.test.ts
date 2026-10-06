/**
 * @file snapping.test.ts
 * @description 吸附对齐：边缘与中心线对齐、等间距分布 (纯计算)，以及拖动、缩放时的吸附与参考线
 */

import { describe, it, expect } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasHost,
  type CanvasPrimitive,
  type EventModifiers,
  type NodeEntity,
  type OverlayChannel,
  type Point,
  type RectBounds,
  type TextInputSession
} from '@skynote/core';
import { BasicNodesPlugin, SelectionPlugin, TransformPlugin } from '../src';
import { SnapTargets } from '../src/interactions/snapping';

const box = (left: number, top: number, width: number, height: number): RectBounds => ({
  left,
  top,
  right: left + width,
  bottom: top + height
});

describe('吸附计算', () => {
  it('边缘与中心线对齐：每轴取修正量最小的一种，超出阈值不吸附', () => {
    const targets = new SnapTargets([box(0, 0, 100, 100)]);
    // 左边 103 → 100 (对齐右边缘)；竖直方向 120 / 170 / 220 离 0、50、100 都超出阈值
    expect(targets.snapMove(box(103, 120, 50, 100), 6)).toEqual({ x: -3, y: 0 });
    // 中心线：竖直中心 52 → 50
    expect(targets.snapMove(box(300, 27, 50, 50), 6)).toEqual({ x: 0, y: -2 });
    expect(targets.snapMove(box(110, 300, 50, 50), 6)).toEqual({ x: 0, y: 0 });
  });

  it('等间距：夹在两节点之间时两侧间距相等；与同一行已有的间距相等', () => {
    // a [0,100]、b [300,400]，同一行
    const targets = new SnapTargets([box(0, 0, 100, 100), box(300, 0, 100, 100)]);
    // 宽 100 放在中间：左边应为 150
    expect(targets.snapMove(box(154, 0, 100, 100), 6).x).toBe(-4);
    // 放在 b 右侧：已有间距 200 → 左边应为 600
    expect(targets.snapMove(box(597, 10, 100, 80), 6).x).toBe(3);
    // 不在同一行 (竖直方向不重叠) 的节点不参与等间距
    expect(targets.snapMove(box(597, 300, 100, 80), 6).x).toBe(0);
  });

  it('参考线：所有重合的边缘与中心线，以及相等的间距', () => {
    const targets = new SnapTargets([box(0, 0, 100, 100), box(300, 0, 100, 100)]);
    const { aligns, gaps } = targets.guides(box(150, 0, 100, 100), true);
    // 上边、中心、下边三条横线都与两侧节点重合，从最左延伸到最右
    expect(aligns.filter((g) => g.axis === 'y')).toEqual([
      { axis: 'y', at: 0, from: 0, to: 400 },
      { axis: 'y', at: 50, from: 0, to: 400 },
      { axis: 'y', at: 100, from: 0, to: 400 }
    ]);
    expect(gaps).toEqual([
      { axis: 'x', from: 100, to: 150, cross: 50 },
      { axis: 'x', from: 250, to: 300, cross: 50 }
    ]);
    // 缩放时只画对齐线
    expect(targets.guides(box(150, 0, 100, 100), false).gaps).toEqual([]);
  });

  it('容器只参与对齐，不参与等间距', () => {
    const targets = new SnapTargets([box(100, 100, 50, 50)], box(0, 0, 1000, 1000));
    expect(targets.snapEdge('x', 995, 6)).toBe(5);
    // 子节点在容器左边缘与兄弟节点之间：不按「容器边 → 兄弟」的间距吸附
    expect(targets.guides(box(40, 100, 20, 50), true).gaps).toEqual([]);
  });
});

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

/** a (0,0) 与 b (300,0) 两个 100×100 形状，视口 1000×800 (世界坐标即屏幕坐标) */
function setup() {
  const engine = new SkyNoteEngine().use(new BasicNodesPlugin()).use(new SelectionPlugin()).use(new TransformPlugin());
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1000, height: 800 });
  const store = engine.documentStore;
  store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0, width: 100, height: 100 });
  store.createNode({ nodeType: 'shape', id: 'b', x: 300, y: 0, width: 100, height: 100 });
  store.clearHistory();
  return { engine, host, store };
}

function pointer(
  engine: SkyNoteEngine,
  phase: 'down' | 'move' | 'up',
  point: Point,
  modifiers: Partial<EventModifiers> = {}
): void {
  const event = new SyntheticPointerEvent({
    point,
    modifiers,
    target: engine.hitTestNode(point) as NodeEntity | undefined
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

describe('拖动与缩放时吸附', () => {
  it('拖动节点：靠近时吸到对齐位置并画参考线，松手后参考线消失；整个拖动一步撤销', () => {
    const { engine, host, store } = setup();
    pointer(engine, 'down', { x: 50, y: 50 });
    pointer(engine, 'move', { x: 100, y: 200 });
    // 左边 x=303 离 b 的左边差 3，上边 y=104 离 b 的下边差 4
    pointer(engine, 'move', { x: 353, y: 154 });
    expect(store.getNode('a')).toMatchObject({ x: 300, y: 100 });
    expect(host.sessions.has('snap:guides')).toBe(true);
    pointer(engine, 'up', { x: 353, y: 154 });
    expect(host.sessions.has('snap:guides')).toBe(false);

    store.undo();
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
  });

  it('按住 Ctrl 不吸附，也不画参考线', () => {
    const { engine, host, store } = setup();
    pointer(engine, 'down', { x: 50, y: 50 }, { ctrl: true });
    pointer(engine, 'move', { x: 100, y: 200 }, { ctrl: true });
    pointer(engine, 'move', { x: 353, y: 154 }, { ctrl: true });
    expect(store.getNode('a')).toMatchObject({ x: 303, y: 104 });
    expect(host.sessions.has('snap:guides')).toBe(false);
    pointer(engine, 'up', { x: 353, y: 154 }, { ctrl: true });
  });

  it('拖右边缘缩放：被拖的边吸到附近节点的边缘', () => {
    const { engine, host, store } = setup();
    engine.session.setSelection({ nodeIds: ['a'] });
    pointer(engine, 'down', { x: 100, y: 50 });
    pointer(engine, 'move', { x: 296, y: 50 });
    expect(store.getNode('a')!.width).toBe(300);
    expect(host.sessions.has('snap:guides')).toBe(true);
    pointer(engine, 'up', { x: 296, y: 50 });
    expect(host.sessions.has('snap:guides')).toBe(false);
  });

  it('完全透明的节点不作为对齐目标', () => {
    const { engine, store } = setup();
    store.updateNode('b', { style: { opacity: 0 } });
    pointer(engine, 'down', { x: 50, y: 50 });
    pointer(engine, 'move', { x: 100, y: 200 });
    pointer(engine, 'move', { x: 353, y: 154 });
    expect(store.getNode('a')).toMatchObject({ x: 303, y: 104 });
    pointer(engine, 'up', { x: 353, y: 154 });
  });

  it('只与同一容器的兄弟节点及该容器对齐', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 300, width: 400, height: 300 });
    store.createNode({ nodeType: 'shape', id: 'c', x: 20, y: 20, width: 50, height: 50, parentId: 'F' });
    // c 的左边移到 x=303：离 b 的左边 300 只差 3，但 b 不在画框 F 中，不吸附
    pointer(engine, 'down', { x: 45, y: 345 });
    pointer(engine, 'move', { x: 200, y: 400 });
    pointer(engine, 'move', { x: 328, y: 400 });
    expect(engine.getNodeWorldBounds('c')!.left).toBe(303);
    // 右边贴近画框右边缘 400：吸附
    pointer(engine, 'move', { x: 373, y: 400 });
    expect(engine.getNodeWorldBounds('c')!.right).toBe(400);
    pointer(engine, 'up', { x: 373, y: 400 });
  });
});
