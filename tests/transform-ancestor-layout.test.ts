/**
 * @file transform-ancestor-layout.test.ts
 * @description 祖先布局事务不一定改变后代几何，通用变换不得依赖 Frame extent 的失效副作用。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  applyMatrix,
  type CanvasHost,
  type CanvasPrimitive,
  type OverlayChannel,
  type Point,
  type TextInputSession
} from '@skynote/core';
import { BasicNodesPlugin, TransformPlugin, setFrameAutoLayout } from '../src';

class AncestorHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, readonly CanvasPrimitive[]>();
  get overlay(): OverlayChannel {
    return this;
  }
  readonly capturePointer = vi.fn<CanvasHost['capturePointer']>();
  readonly releasePointer = vi.fn<CanvasHost['releasePointer']>();
  readonly setCursor = vi.fn<CanvasHost['setCursor']>();
  readonly setPrimitives = vi.fn((id: string, primitives: readonly CanvasPrimitive[]) => {
    if (primitives.length) this.sessions.set(id, primitives);
    else this.sessions.delete(id);
  });
  clear(id: string): void {
    this.sessions.delete(id);
  }
  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

function setup(options: { enabled?: boolean; middle?: boolean } = {}) {
  const engine = new SkyNoteEngine().use(new BasicNodesPlugin()).use(new TransformPlugin());
  const host = new AncestorHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1600, height: 1000 });
  const store = engine.documentStore;
  engine.nodeTypes.register({
    type: 'plain-container',
    label: '无 extent 容器',
    defaultData: {},
    acceptsChildren: true,
    createContent: () => ({ width: 500, height: 400 }),
    compose: () => []
  });
  store.createNode({ nodeType: 'plain-container', id: 'outer', x: 0, y: 0 });
  if (options.middle) {
    store.createNode({ nodeType: 'plain-container', id: 'middle', parentId: 'outer', x: 24, y: 24 });
    store.updateNode('middle', { layoutItem: {} });
  }
  store.createNode({
    nodeType: 'frame',
    id: 'inner',
    parentId: options.middle ? 'middle' : 'outer',
    x: 24,
    y: 24,
    width: 200,
    height: 100,
    autoWrap: false
  });
  setFrameAutoLayout(store, engine.entityStore, ['inner'], { widthSizing: 'fixed', heightSizing: 'fixed' });
  store.updateNode('inner', { layoutItem: {} });
  const layout = { type: 'stack', options: { widthSizing: 'fixed', heightSizing: 'fixed' } };
  if (options.enabled !== false) store.updateNode('outer', { layout });
  engine.session.setSelection({ nodeIds: ['inner'] });
  store.clearHistory();
  const world = engine.entityStore.getWorldTransform('inner')!;
  return { engine, host, store, layout, corner: applyMatrix(world, 200, 100), rotate: applyMatrix(world, 212, 112) };
}

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point): void {
  const event = new SyntheticPointerEvent({ point, modifiers: { ctrl: true } });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

describe('Transform 祖先布局事务依赖', () => {
  it('祖先关闭布局及撤销重做均即时更新旋转，后代几何保持不变', () => {
    const { engine, host, store, rotate } = setup();
    const before = structuredClone(store.getNode('inner'));
    store.updateNode('outer', { layout: undefined });
    expect(store.getNode('inner')).toEqual(before);
    pointer(engine, 'down', rotate);
    expect(host.capturePointer).toHaveBeenCalledTimes(1);
    pointer(engine, 'up', rotate);
    host.capturePointer.mockClear();
    store.undo();
    expect(store.getNode('inner')).toEqual(before);
    pointer(engine, 'down', rotate);
    expect(host.capturePointer).not.toHaveBeenCalled();
    store.redo();
    pointer(engine, 'down', rotate);
    expect(host.capturePointer).toHaveBeenCalledTimes(1);
    pointer(engine, 'up', rotate);
    engine.destroy();
  });

  it.each(['local', 'remote'] as const)('%s 事务启用祖先布局后结束活动旋转', (origin) => {
    const { engine, host, store, rotate, layout } = setup({ enabled: false });
    const before = structuredClone(store.getNode('inner'));
    pointer(engine, 'down', rotate);
    expect(host.capturePointer).toHaveBeenCalledTimes(1);
    store.commit({ origin, patches: [{ op: 'set', path: ['content', 'nodes', 'outer', 'layout'], value: layout }] });
    expect(store.getNode('inner')).toEqual(before);
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    const after = structuredClone(store.getView().content);
    pointer(engine, 'move', { x: rotate.x + 100, y: rotate.y + 100 });
    pointer(engine, 'up', rotate);
    expect(store.getView().content).toEqual(after);
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('中间祖先 layoutItem 归属变化及撤销更新后代旋转', () => {
    const { engine, host, store, rotate } = setup({ middle: true });
    const before = structuredClone(store.getNode('inner'));
    store.updateNode('middle', { layoutItem: undefined });
    expect(store.getNode('inner')).toEqual(before);
    pointer(engine, 'down', rotate);
    expect(host.capturePointer).toHaveBeenCalledTimes(1);
    pointer(engine, 'up', rotate);
    host.capturePointer.mockClear();
    store.undo();
    pointer(engine, 'down', rotate);
    expect(host.capturePointer).not.toHaveBeenCalled();
    engine.destroy();
  });

  it('祖先嵌套布局参数补丁结束缩放，不因对象就地修改漏判', () => {
    const { engine, host, store, corner } = setup();
    pointer(engine, 'down', corner);
    pointer(engine, 'move', { x: corner.x + 200, y: corner.y + 100 });
    expect(store.getNode('inner')!.width).toBe(400);
    const before = structuredClone(store.getNode('inner'));
    store.commit({
      patches: [{ op: 'set', path: ['content', 'nodes', 'outer', 'layout', 'options', 'gap'], value: 37 }]
    });
    expect(store.getNode('inner')).toEqual(before);
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    pointer(engine, 'move', { x: corner.x + 400, y: corner.y + 200 });
    expect(store.getNode('inner')!.width).toBe(400);
    engine.destroy();
  });

  it.each(['style', 'same-layout'] as const)('祖先 %s 修改不结束手势或重绘', (change) => {
    const { engine, host, store, corner } = setup();
    pointer(engine, 'down', corner);
    pointer(engine, 'move', { x: corner.x + 200, y: corner.y + 100 });
    expect(store.getNode('inner')!.width).toBe(400);
    host.setPrimitives.mockClear();
    if (change === 'style') store.updateNode('outer', { style: { opacity: 0.5 } });
    else
      store.commit({
        patches: [
          { op: 'set', path: ['content', 'nodes', 'outer', 'layout', 'options', 'widthSizing'], value: 'fixed' }
        ]
      });
    expect(host.releasePointer).not.toHaveBeenCalled();
    expect(host.setPrimitives).not.toHaveBeenCalled();
    pointer(engine, 'move', { x: corner.x + 400, y: corner.y + 200 });
    expect(store.getNode('inner')!.width).toBe(600);
    pointer(engine, 'up', corner);
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    engine.destroy();
  });
});
