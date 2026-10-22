/** 单位倍率必须保持文字继承；首次同点输入不能产生事务或执行扩展 hook。 */
import { describe, expect, it, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  computeWorldFrame,
  type CanvasHost,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type Point,
  type TextInputSession
} from '@skynote/core';
import { BasicNodesPlugin, TransformPlugin } from '../src';

class NoopHost implements CanvasHost, OverlayChannel {
  get overlay(): OverlayChannel {
    return this;
  }
  setPrimitives(_id: string, _primitives: readonly CanvasPrimitive[]): void {}
  clear(): void {}
  setCursor(): void {}
  capturePointer(): void {}
  releasePointer(): void {}
  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

function setup() {
  const engine = new SkyNoteEngine({
    fonts: { measureWidth: (text, font) => text.length * font.size * 0.6 }
  })
    .use(new BasicNodesPlugin())
    .use(new TransformPlugin());
  engine.attachHost(new NoopHost());
  engine.session.setViewportSize({ width: 1600, height: 1000 });
  return { engine, store: engine.documentStore };
}

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point): void {
  const event = new SyntheticPointerEvent({ point, modifiers: { ctrl: true } });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

describe('Transform 零位移与单位倍率', () => {
  it('独立自由文本放大再还原，节点和块级继承及行内字段保持原样', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'free-text', id: 'n', x: 0, y: 0 });
    store.updateNode('n', {
      textStyle: { fontSize: 20, lineHeight: '24px', padding: 2 },
      textBlocks: [{ id: 'body', slot: 'body', runs: [{ text: '文字', fontSize: 18, letterSpacing: 1 }] }]
    });
    engine.session.setSelection({ nodeIds: ['n'] });
    const node = store.getNode('n')!;
    const corner = { x: node.width, y: node.height };
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    pointer(engine, 'down', corner);
    pointer(engine, 'move', { x: corner.x * 2, y: corner.y * 2 });
    expect(store.getNode('n')!.textBlocks![0].runs[0].fontSize).toBe(36);
    pointer(engine, 'move', corner);
    pointer(engine, 'up', corner);
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it.each(['frame', 'shape', 'free-text'])('%s 首次同点输入不写文档或历史', (nodeType) => {
    const { engine, store } = setup();
    store.createNode({ nodeType, id: 'n', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    engine.session.setSelection({ nodeIds: ['n'] });
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    const changed = vi.fn();
    const off = store.subscribe(changed);
    const node = store.getNode('n')!;
    const corner = { x: node.width, y: node.height };
    pointer(engine, 'down', corner);
    pointer(engine, 'move', corner);
    pointer(engine, 'move', corner);
    pointer(engine, 'up', corner);
    expect(store.getView().content).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    expect(store.canUndo).toBe(false);
    off();
    engine.destroy();
  });

  it.each(['frame', 'group'])('%s 放大后回到起点，文字继承与全部后代恢复', (scope) => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'free-text', id: 'text', parentId: 'f', x: 20, y: 30 });
    store.createNode({ nodeType: 'shape', id: 'side', x: 420, y: 0, width: 80, height: 300 });
    const id = scope === 'group' ? store.groupNodes(['f', 'side'])! : 'f';
    const node = store.getNode(id)!;
    const frame = computeWorldFrame(node, engine.entityStore.getWorldTransform(id)!);
    const corner = { x: frame.cx + frame.width / 2, y: frame.cy + frame.height / 2 };
    engine.session.setSelection({ nodeIds: [id] });
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    pointer(engine, 'down', corner);
    pointer(engine, 'move', { x: corner.x + frame.width, y: corner.y + frame.height });
    expect(store.getNode('f')!.textBlocks![0].style?.fontSize).toBe(28);
    pointer(engine, 'move', corner);
    pointer(engine, 'up', corner);
    expect(store.getView().content).toEqual(before);
    // 已发生的两次真实事务仍合并为一步撤销；本测试不将其描述为零事务手势。
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it('快照命令同倍率无通知，放大再恢复保留稀疏布局配置', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.updateNode('f', { layout: { type: 'stack', options: { widthSizing: 'fixed', heightSizing: 'fixed' } } });
    const node = structuredClone(store.getNode('f')!);
    const frame = computeWorldFrame(node, engine.entityStore.getWorldTransform('f')!);
    const scaleSnapshot = { nodes: new Map([['f', { node, frame }]]), connectors: new Map() };
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    const changed = vi.fn();
    const off = store.subscribe(changed);
    expect(store.transformNodes([{ id: 'f', frame, scaleContents: true, scaleSnapshot }])).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(store.canUndo).toBe(false);
    store.transformNodes([
      { id: 'f', frame: { cx: 400, cy: 300, width: 800, height: 600, rotation: 0 }, scaleContents: true, scaleSnapshot }
    ]);
    store.transformNodes([{ id: 'f', frame, scaleContents: true, scaleSnapshot }]);
    expect(store.getView().content).toEqual(before);
    expect(changed).toHaveBeenCalledTimes(2);
    off();
    engine.destroy();
  });

  it('首次同点不调用扩展 hook，低层命令单位倍率仍尊重其最终文本', () => {
    const { engine, store } = setup();
    const hook = vi.fn((node: NodeEntity) => ({
      textBlocks: node.textBlocks!.map((block) => ({ ...block, style: { fontSize: 23.5 } }))
    }));
    engine.nodeTypes.register({
      type: 'custom',
      label: '自定义',
      defaultData: {},
      supportsContentScale: true,
      createContent: () => ({
        width: 100,
        height: 100,
        textBlocks: [{ id: 'body', slot: 'body', runs: [{ text: '文字' }] }]
      }),
      applyContentScale: hook,
      compose: () => []
    });
    store.createNode({ nodeType: 'custom', id: 'n', x: 0, y: 0 });
    engine.session.setSelection({ nodeIds: ['n'] });
    store.clearHistory();
    pointer(engine, 'down', { x: 100, y: 100 });
    pointer(engine, 'move', { x: 100, y: 100 });
    pointer(engine, 'up', { x: 100, y: 100 });
    expect(hook).not.toHaveBeenCalled();
    expect(store.canUndo).toBe(false);
    const node = structuredClone(store.getNode('n')!);
    const frame = computeWorldFrame(node, engine.entityStore.getWorldTransform('n')!);
    store.transformNodes([
      {
        id: 'n',
        frame,
        scaleContents: true,
        scaleSnapshot: { nodes: new Map([['n', { node, frame }]]), connectors: new Map() }
      }
    ]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(store.getNode('n')!.textBlocks![0].style?.fontSize).toBe(24);
    store.undo();
    expect(store.getNode('n')).toEqual(node);
    engine.destroy();
  });
});
