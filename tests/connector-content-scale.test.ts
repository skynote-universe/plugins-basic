/** 内部连线标注和节点共用起始快照，路径、文字与偏移原子缩放。 */
import { describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine, SyntheticPointerEvent, computeWorldFrame } from '@skynote/core';
import { BasicNodesPlugin, TransformPlugin } from '../src';

function setup(group: boolean, points: boolean) {
  const engine = new SkyNoteEngine().use(new BasicNodesPlugin()).use(new TransformPlugin());
  engine.attachHost({
    overlay: { setPrimitives() {}, clear() {} },
    setCursor() {},
    capturePointer() {},
    releasePointer() {},
    openTextInput() {
      return { setCaretRect() {}, focus() {}, close() {} };
    }
  });
  engine.session.setViewportSize({ width: 1600, height: 1000 });
  const store = engine.documentStore;
  store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
  for (const [id, x] of [
    ['a', 20],
    ['b', 200]
  ] as const)
    store.createNode({ nodeType: 'shape', id, x, y: 20, width: 80, height: 50, parentId: 'f' });
  store.createNode({ nodeType: 'shape', id: 'outside', x: 600, y: 0, width: 100, height: 100 });
  let root = 'f';
  if (group) {
    store.createNode({ nodeType: 'shape', id: 'side', x: 420, y: 0, width: 80, height: 300 });
    root = store.groupNodes(['f', 'side'])!;
  }
  const id = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
  const external = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'outside' } })!;
  for (const link of [id, external])
    store.updateConnector(link, {
      ...(points ? { controlPoints: [{ x: 150, y: 70 }] } : {}),
      textBlocks: [
        {
          id: 'explicit',
          slot: 'label',
          position: 0.3,
          offsetX: 4,
          offsetY: -6,
          explicitWidth: 45,
          style: { fontSize: 18, padding: 2, lineHeight: '21px' },
          runs: [{ text: '标注', fontSize: 16, letterSpacing: 1 }]
        },
        { id: 'inherited', slot: 'label', position: 0.7, runs: [{ text: '默认标注' }] }
      ]
    });
  engine.session.setSelection({ nodeIds: [root] });
  store.clearHistory();
  const frame = computeWorldFrame(store.getNode(root)!, engine.entityStore.getWorldTransform(root)!);
  const corner = { x: frame.cx + frame.width / 2, y: frame.cy + frame.height / 2 };
  const input = (phase: 'down' | 'move' | 'up', scale: number) => {
    const event = new SyntheticPointerEvent({
      point: { x: corner.x + frame.width * (scale - 1), y: corner.y + frame.height * (scale - 1) },
      modifiers: { ctrl: true }
    });
    if (phase === 'down') engine.pointer.dispatchPointerDown(event);
    else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
    else engine.pointer.dispatchPointerUp(event);
  };
  return { engine, store, id, external, input };
}

describe('内部连线标注整体缩放', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ] as const)('组合=%s 手动点=%s，往返、继承、外部连线与撤销重做', (group, points) => {
    const { engine, store, id, external, input } = setup(group, points);
    const before = structuredClone(store.getView().content);
    input('down', 1);
    input('move', 2);
    const scaled = store.getConnector(id)!;
    expect(scaled.textBlocks![0]).toMatchObject({
      position: 0.3,
      offsetX: 8,
      offsetY: -12,
      explicitWidth: 90,
      style: { fontSize: 36, padding: 4, lineHeight: '42px' },
      runs: [{ fontSize: 32, letterSpacing: 2 }]
    });
    expect(scaled.textBlocks![1]).toMatchObject({ position: 0.7, style: { fontSize: 28, lineHeight: 1.4 } });
    expect(Object.hasOwn(scaled.textBlocks![1], 'offsetX')).toBe(false);
    if (points) expect(scaled.controlPoints).toEqual([{ x: 300, y: 140 }]);
    expect(store.getConnector(external)).toEqual(before.connectors[external]);
    input('move', 1);
    expect(store.getView().content).toEqual(before);
    input('move', 1.5);
    input('up', 1.5);
    expect(store.getConnector(id)!.textBlocks![0].style!.fontSize).toBe(27);
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it('重复目标无通知，外部标注编辑结束手势且不被旧快照覆盖', () => {
    const { engine, store, id, input } = setup(false, false);
    input('down', 1);
    input('move', 2);
    const changed = vi.fn();
    const off = store.subscribe(changed);
    input('move', 2);
    expect(changed).not.toHaveBeenCalled();
    store.updateConnector(id, {
      textBlocks: [{ id: 'changed', slot: 'label', position: 0.5, runs: [{ text: '新的标注' }] }]
    });
    const after = structuredClone(store.getView().content);
    input('move', 3);
    input('up', 3);
    expect(store.getView().content).toEqual(after);
    off();
    engine.destroy();
  });

  it('旋转与仅调整外框不缩放标注', () => {
    const { engine, store, id } = setup(false, true);
    const blocks = structuredClone(store.getConnector(id)!.textBlocks);
    store.rotateNodes(['f'], 30);
    expect(store.getConnector(id)!.textBlocks).toEqual(blocks);
    store.resizeNodes(['f'], { width: 500 });
    expect(store.getConnector(id)!.textBlocks).toEqual(blocks);
    engine.destroy();
  });
});
