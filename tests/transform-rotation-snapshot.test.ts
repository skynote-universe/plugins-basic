/** 旋转指针入口的起始拐点和取消/外部事务生命周期。 */
import { describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine, SyntheticPointerEvent, createEmptyCanvasDocument } from '@skynote/core';
import { BasicNodesPlugin, TransformPlugin } from '../src';

function setup() {
  const doc = createEmptyCanvasDocument();
  for (const [id, x] of [
    ['f', 0],
    ['a', 25],
    ['b', 65]
  ] as const)
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: id === 'f' ? 'frame' : 'rect',
      x,
      y: id === 'f' ? 0 : 40,
      width: id === 'f' ? 100 : 10,
      height: id === 'f' ? 100 : 10,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(id === 'f' ? {} : { parentId: 'f' })
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
  const link = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
  store.updateConnector(link, { controlPoints: [{ x: 60, y: 50 }] });
  engine.session.setSelection({ nodeIds: ['f'] });
  store.clearHistory();
  const pointer = (phase: 'down' | 'move' | 'up' | 'cancel', angle: number): void => {
    const radians = ((45 + angle) * Math.PI) / 180;
    const radius = Math.sqrt(62 * 62 * 2);
    const event = new SyntheticPointerEvent({
      point: { x: 50 + radius * Math.cos(radians), y: 50 + radius * Math.sin(radians) }
    });
    if (phase === 'down') engine.pointer.dispatchPointerDown(event);
    else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
    else if (phase === 'up') engine.pointer.dispatchPointerUp(event);
    else engine.pointer.dispatchPointerCancel(event);
  };
  return { engine, store, link, pointer, capturePointer, releasePointer };
}

describe('Transform 旋转连线快照', () => {
  it('180次半度移动正确到90度，并保持单步撤销重做', () => {
    const { engine, store, link, pointer, capturePointer, releasePointer } = setup();
    const before = structuredClone(store.getView().content);
    pointer('down', 0);
    for (let i = 1; i <= 180; i++) pointer('move', i / 2);
    pointer('up', 90);
    expect(capturePointer).toHaveBeenCalledTimes(1);
    expect(releasePointer).toHaveBeenCalledTimes(1);
    expect(store.getNode('f')!.rotation).toBe(90);
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 50, y: 60 }]);
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it('旋转后回起点恢复原始拐点', () => {
    const { engine, store, pointer } = setup();
    const before = structuredClone(store.getView().content);
    pointer('down', 0);
    for (let i = 1; i <= 90; i++) pointer('move', i);
    for (let i = 89; i >= 0; i--) pointer('move', i);
    pointer('up', 0);
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it('取消释放指针并保留最后结果，后续移动不能回写旧快照', () => {
    const { engine, store, pointer, releasePointer } = setup();
    pointer('down', 0);
    pointer('move', 30);
    pointer('cancel', 30);
    const after = structuredClone(store.getView().content);
    pointer('move', 60);
    expect(releasePointer).toHaveBeenCalledTimes(1);
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it('相关连线外部修改结束手势，不覆盖新值', () => {
    const { engine, store, link, pointer, releasePointer } = setup();
    pointer('down', 0);
    pointer('move', 30);
    store.updateConnector(link, { controlPoints: [{ x: 75, y: 75 }] });
    expect(releasePointer).toHaveBeenCalledTimes(1);
    pointer('move', 60);
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 75, y: 75 }]);
    engine.destroy();
  });

  it('无关节点修改不打断，内部连线删除则结束手势', () => {
    const { engine, store, link, pointer, releasePointer } = setup();
    pointer('down', 0);
    store.updateNode('f', { style: { fill: '#123456' } });
    expect(releasePointer).toHaveBeenCalledTimes(1);
    pointer('down', 0);
    const other = store.createNode({ nodeType: 'frame', x: 500, y: 500 });
    store.updateNode(other!, { style: { fill: '#654321' } });
    expect(releasePointer).toHaveBeenCalledTimes(1);
    pointer('move', 90);
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 50, y: 60 }]);
    store.removeEntities({ connectorIds: [link] });
    expect(releasePointer).toHaveBeenCalledTimes(2);
    pointer('move', 100);
    expect(store.getConnector(link)).toBeUndefined();
    engine.destroy();
  });

  it.each(['readonly', 'uninstall'] as const)('%s 清理旋转快照并释放指针', (action) => {
    const { engine, store, pointer, releasePointer } = setup();
    pointer('down', 0);
    pointer('move', 30);
    const after = structuredClone(store.getView().content);
    if (action === 'readonly') engine.session.setReadOnly(true);
    else engine.plugins.remove('@skynote/plugins-basic/transform');
    expect(releasePointer).toHaveBeenCalledTimes(1);
    pointer('move', 90);
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });
});
