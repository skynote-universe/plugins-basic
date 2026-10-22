/** 多选共同旋转包含跨根内部连线，单端在外及独立目标仍不归入共享作用域。 */
import { describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine, SyntheticPointerEvent, createEmptyCanvasDocument } from '@skynote/core';
import { BasicNodesPlugin, TransformPlugin } from '../src';

function setup(descendants = false, reverse = false) {
  const doc = createEmptyCanvasDocument();
  for (const [id, x] of [
    ['f', 0],
    ['g', 200],
    ['outside', 500]
  ] as const)
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: 'frame',
      x,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
  if (descendants)
    for (const [id, parentId] of [
      ['a', 'f'],
      ['b', 'g']
    ] as const)
      doc.content.nodes[id] = {
        id,
        type: 'node',
        nodeType: 'rect',
        parentId,
        x: 10,
        y: 10,
        width: 20,
        height: 20,
        rotation: 0,
        zIndex: 'a0',
        locked: false
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
  const store = engine.documentStore;
  const from = descendants ? 'a' : 'f',
    to = descendants ? 'b' : 'g';
  const link = store.createConnector({ from: { nodeId: from }, to: { nodeId: to } })!;
  const external = store.createConnector({ from: { nodeId: from }, to: { nodeId: 'outside' } })!;
  store.updateConnector(link, { controlPoints: [{ x: 150, y: 25 }] });
  store.updateConnector(external, { controlPoints: [{ x: 425, y: 25 }] });
  engine.session.setSelection({ nodeIds: reverse ? ['g', 'f'] : ['f', 'g'] });
  store.clearHistory();
  const pointer = (phase: 'down' | 'move' | 'up', angle: number): void => {
    const radians = (angle * Math.PI) / 180;
    const event = new SyntheticPointerEvent({
      point: {
        x: 150 + 162 * Math.cos(radians) - 62 * Math.sin(radians),
        y: 50 + 162 * Math.sin(radians) + 62 * Math.cos(radians)
      }
    });
    if (phase === 'down') engine.pointer.dispatchPointerDown(event);
    else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
    else engine.pointer.dispatchPointerUp(event);
  };
  return { engine, store, link, external, pointer, capturePointer, releasePointer };
}

describe('多选共同旋转', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])('跨根连线、往返与撤销重做，后代=%s、反序=%s', (descendants, reverse) => {
    const { engine, store, link, external, pointer, capturePointer } = setup(descendants, reverse);
    const before = structuredClone(store.getView().content);
    const unsubscribe = store.subscribe((_change, record) => {
      expect(
        record.patches.filter((p) => p.path[1] === 'connectors' && p.path[2] === link && p.path[3] === 'controlPoints')
          .length
      ).toBeLessThanOrEqual(1);
    });
    pointer('down', 0);
    expect(capturePointer).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 90; i++) pointer('move', i);
    expect(store.getNode('f')!.rotation).toBe(90);
    expect(store.getNode('g')!.rotation).toBe(90);
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 175, y: 50 }]);
    expect(store.getConnector(external)).toEqual(before.connectors[external]);
    const after = structuredClone(store.getView().content);
    unsubscribe();
    for (let i = 89; i >= 0; i--) pointer('move', i);
    expect(store.getView().content).toEqual(before);
    for (let i = 1; i <= 90; i++) pointer('move', i);
    pointer('up', 90);
    expect(store.getView().content).toEqual(after);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it.each(['modify', 'remove'] as const)('跨根连线被%s时结束手势，旧快照不能回写', (action) => {
    const { engine, store, link, pointer, releasePointer } = setup(true);
    pointer('down', 0);
    pointer('move', 30);
    if (action === 'modify') store.updateConnector(link, { controlPoints: [{ x: 123, y: 456 }] });
    else store.removeEntities({ connectorIds: [link] });
    expect(releasePointer).toHaveBeenCalledTimes(1);
    const after = structuredClone(store.getView().content);
    pointer('move', 60);
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it('公开 rotateNodes 与共同指针旋转具有相同跨根连线语义', () => {
    const { engine, store, link, external } = setup(true);
    const before = structuredClone(store.getView().content);
    expect(store.rotateNodes(['f', 'g'], 90)).not.toBeNull();
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 175, y: 50 }]);
    expect(store.getConnector(external)).toEqual(before.connectors[external]);
    store.undo();
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it('公开旋转先规整角度，亚整数输入不单独移动连线', () => {
    const { engine, store } = setup(true);
    const before = structuredClone(store.getView().content);
    expect(store.rotateNodes(['f', 'g'], 0.4)).toBeNull();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });
});
