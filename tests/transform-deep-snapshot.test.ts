/** 深层整体缩放的指针入口验证，配合 Core 的祖先查询复杂度回归。 */
import { expect, it, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  createEmptyCanvasDocument,
  type CanvasPluginContext
} from '@skynote/core';
import { BasicNodesPlugin, TransformPlugin } from '../src';

/** 只计控制柄经公开上下文发起的读取，避免把空间索引等其他订阅者的开销混入插件预算。 */
class MeasuredTransformPlugin extends TransformPlugin {
  reads = 0;
  override install(ctx: CanvasPluginContext): void {
    const getNode: CanvasPluginContext['entities']['getNode'] = (id) => {
      this.reads++;
      return ctx.entities.getNode(id);
    };
    const entities = new Proxy(ctx.entities, {
      get: (target, key) => (key === 'getNode' ? getNode : Reflect.get(target, key, target))
    });
    super.install(
      new Proxy(ctx, {
        get: (target, key) => {
          if (key === 'entities') return entities;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      })
    );
  }
}

it.each([200, 400])('%s层嵌套多选的控制柄建立及几何刷新读取保持线性', (depth) => {
  const doc = createEmptyCanvasDocument();
  const ids = Array.from({ length: depth }, (_, i) => `f${i}`);
  for (const [i, id] of ids.entries())
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: 'frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: ids[i - 1] } : {})
    };
  const transform = new MeasuredTransformPlugin();
  const engine = new SkyNoteEngine({ initialDoc: doc }).use(new BasicNodesPlugin()).use(transform);
  transform.reads = 0;
  engine.session.setSelection({ nodeIds: ids });
  expect(transform.reads).toBeLessThan(depth * 5);
  for (const rotation of [1, 2]) {
    transform.reads = 0;
    engine.documentStore.updateNode(ids[0], { rotation });
    expect(transform.reads).toBeLessThan(depth * 5);
  }
  engine.destroy();
});

it('400 层容器指针快照、缩放与单步撤销完整闭环', () => {
  const doc = createEmptyCanvasDocument();
  const depth = 400;
  for (let i = 0; i < depth; i++)
    doc.content.nodes[`n${i}`] = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      locked: false,
      zIndex: 'a0',
      ...(i ? { parentId: `n${i - 1}` } : {})
    };
  const engine = new SkyNoteEngine({ initialDoc: doc }).use(new BasicNodesPlugin()).use(new TransformPlugin());
  const capturePointer = vi.fn();
  const releasePointer = vi.fn();
  engine.attachHost({
    overlay: { setPrimitives() {}, clear() {} },
    setCursor() {},
    capturePointer,
    releasePointer,
    openTextInput() {
      return { setCaretRect() {}, focus() {}, close() {} };
    }
  });
  engine.session.setViewportSize({ width: 1600, height: 1000 });
  engine.session.setSelection({ nodeIds: ['n0'] });
  const store = engine.documentStore;
  store.clearHistory();
  const before = structuredClone(store.getView().content);
  const spy = vi.spyOn(engine.entityStore, 'getWorldTransform');
  const start = performance.now();
  engine.pointer.dispatchPointerDown(
    new SyntheticPointerEvent({ point: { x: 100, y: 100 }, modifiers: { ctrl: true } })
  );
  console.info(
    `[bench] 400 层容器 pointer down: ${(performance.now() - start).toFixed(2)}ms，公开矩阵读取 ${spy.mock.calls.length} 次`
  );
  expect(capturePointer).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls.length).toBeLessThan(depth * 3);
  spy.mockRestore();
  engine.pointer.dispatchPointerMove(
    new SyntheticPointerEvent({ point: { x: 200, y: 200 }, modifiers: { ctrl: true } })
  );
  engine.pointer.dispatchPointerUp(new SyntheticPointerEvent({ point: { x: 200, y: 200 }, modifiers: { ctrl: true } }));
  expect(releasePointer).toHaveBeenCalledTimes(1);
  for (const node of Object.values(store.getView().content.nodes)) expect(node.width).toBe(200);
  store.undo();
  expect(store.getView().content).toEqual(before);
  expect(store.canUndo).toBe(false);
  engine.destroy();
});
