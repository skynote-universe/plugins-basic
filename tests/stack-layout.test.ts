/**
 * @file stack-layout.test.ts
 * @description ADR-145 阶段三：画框自动堆叠布局 (stack) — 水平/垂直排列、自适应与固定尺寸切换、
 *              拖拽插入与换序、拖出脱离、以及「文字撑开 → 画框自动布局 → 外层组合紧缩」三阶段单事务级联测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  applyMatrix,
  computeWorldFrame,
  parseCanvasDocument,
  type CanvasHost,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type Point,
  type TextInputSession
} from '@skynote/core';
import {
  BasicNodesPlugin,
  SelectionPlugin,
  TransformPlugin,
  parseStackLayoutOptions,
  setFrameAutoLayout
} from '../src';

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

function setup() {
  const engine = new SkyNoteEngine({
    fonts: { measureWidth: (text, font) => text.length * font.size * 0.6 }
  })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin());
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1600, height: 1000 });
  const store = engine.documentStore;
  return { engine, host, store };
}

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point): void {
  const event = new SyntheticPointerEvent({
    point,
    target: engine.hitTestNode(point) as NodeEntity | undefined,
    modifiers: { ctrl: true }
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

function drag(engine: SkyNoteEngine, from: Point, to: Point): void {
  pointer(engine, 'down', from);
  for (let i = 1; i <= 4; i++) {
    pointer(engine, 'move', { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 });
  }
  pointer(engine, 'up', to);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('画框自动堆叠布局 (ADR-145 阶段三)', () => {
  it.each(['rotate', 'remove', 'reparent-out', 'reparent-in'] as const)(
    '组合成员 %s 而外框不变时刷新控制柄策略',
    (change) => {
      const { engine, store, host } = setup();
      engine.nodeTypes.register({
        type: 'axis-child',
        label: '受限节点',
        defaultData: {},
        resize: 'width',
        createContent: () => ({ width: 100, height: 40 }),
        compose: () => []
      });
      store.createNode({ nodeType: 'shape', id: 'background', x: 0, y: 0, width: 400, height: 300 });
      store.createNode({ nodeType: 'shape', id: 'anchor', x: 20, y: 20, width: 20, height: 20 });
      const group = store.groupNodes(['background', 'anchor'])!;
      store.createNode({
        nodeType: 'axis-child',
        id: 'child',
        x: 100,
        y: 100,
        ...(change !== 'reparent-in' ? { parentId: group } : {})
      });
      engine.session.setSelection({ nodeIds: [group] });
      const count = () => host.sessions.get('transform:handles')?.length ?? 0;
      expect(count()).toBe(change === 'reparent-in' ? 4 : 2);
      if (change === 'rotate') store.updateNode('child', { rotation: 45 });
      if (change === 'remove') store.removeEntities({ nodeIds: ['child'] });
      if (change === 'reparent-out') store.reparentNodes(['child'], undefined);
      if (change === 'reparent-in') store.reparentNodes(['child'], group);
      expect(store.getNode(group)).toMatchObject({ width: 400, height: 300 });
      expect(count()).toBe(change === 'rotate' ? 0 : change === 'reparent-in' ? 2 : 4);
      if (change === 'rotate') {
        pointer(engine, 'down', { x: 400, y: 150 });
        pointer(engine, 'move', { x: 500, y: 150 });
        pointer(engine, 'up', { x: 500, y: 150 });
        expect(store.getNode('child')!.width).toBe(100);
      }
      engine.destroy();
    }
  );

  it.each([
    ['e', { x: 400, y: 150 }, { x: 800, y: 150 }],
    ['w', { x: 0, y: 150 }, { x: -400, y: 150 }],
    ['n', { x: 200, y: 0 }, { x: 200, y: -300 }],
    ['s', { x: 200, y: 300 }, { x: 200, y: 600 }],
    ['nw', { x: 0, y: 0 }, { x: -400, y: -300 }],
    ['ne', { x: 400, y: 0 }, { x: 800, y: -300 }],
    ['se', { x: 400, y: 300 }, { x: 800, y: 600 }],
    ['sw', { x: 0, y: 300 }, { x: -400, y: 600 }]
  ] as const)('仅 %s 手柄合法时显示、悬停和缩放一致', (allowed, from, to) => {
    const { engine, store, host } = setup();
    const hook = vi.fn(() => ({}));
    engine.nodeTypes.register({
      type: 'handle-container',
      label: '分手柄容器',
      defaultData: {},
      resize: 'none',
      supportsContentScale: true,
      getResizeBehavior: (_node, handle) => (handle === allowed ? 'scale-contents' : 'resize-bounds'),
      applyContentScale: hook,
      createContent: () => ({ width: 400, height: 300 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'handle-container', id: 'f', x: 0, y: 0 });
    engine.session.setSelection({ nodeIds: ['f'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(1);
    const cursor = vi.spyOn(host, 'setCursor');
    pointer(engine, 'move', from);
    expect(cursor).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'resize' }));
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    pointer(engine, 'down', from);
    pointer(engine, 'move', to);
    pointer(engine, 'up', to);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(store.getNode('f')).toMatchObject({ width: 800, height: 600 });
    store.undo();
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it.each(['none', 'height'] as const)('捕获指针前拒绝已变为 %s 的右边策略', (axes) => {
    const transform = new TransformPlugin();
    const engine = new SkyNoteEngine().use(new BasicNodesPlugin()).use(transform);
    const host = new FakeHost();
    engine.attachHost(host);
    const store = engine.documentStore;
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    engine.session.setSelection({ nodeIds: ['f'] });
    const before = structuredClone(store.getView().content);
    vi.spyOn(store, 'getNodeResizePolicy').mockReturnValue({ behavior: 'resize-bounds', axes, lockAspect: false });
    const capture = vi.spyOn(host, 'capturePointer');
    pointer(engine, 'down', { x: 400, y: 150 });
    pointer(engine, 'move', { x: 800, y: 150 });
    pointer(engine, 'up', { x: 800, y: 150 });
    expect(capture).not.toHaveBeenCalled();
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it.each(['width', 'height'] as const)('单选比例锁定的 %s 节点仍可调整其声明的单轴', (axes) => {
    const { engine, store, host } = setup();
    engine.nodeTypes.register({
      type: 'locked-axis',
      label: '锁定单轴',
      defaultData: {},
      resize: axes,
      getResizeBehavior: () => 'resize-bounds',
      createContent: () => ({ width: 100, height: 100 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'locked-axis', id: 'f', x: 0, y: 0 });
    store.setAspectLocked(['f'], true);
    engine.session.setSelection({ nodeIds: ['f'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(2);
    const from = axes === 'width' ? { x: 100, y: 50 } : { x: 50, y: 100 };
    const to = axes === 'width' ? { x: 200, y: 50 } : { x: 50, y: 200 };
    pointer(engine, 'down', from);
    pointer(engine, 'move', to);
    pointer(engine, 'up', to);
    expect(store.getNode('f')).toMatchObject({
      width: axes === 'width' ? 200 : 100,
      height: axes === 'height' ? 200 : 100
    });
    engine.destroy();
  });

  it('八个手柄共享组合成员约束，悬停和无关事务不重新展开成员', () => {
    const { engine, store } = setup();
    const axes = vi.fn(() => 'both' as const);
    engine.nodeTypes.register({
      type: 'policy-child',
      label: '约束节点',
      defaultData: {},
      getResizeAxes: axes,
      compose: () => []
    });
    store.createNode({ nodeType: 'shape', id: 'background', x: 0, y: 0, width: 400, height: 300 });
    store.createNode({ nodeType: 'shape', id: 'anchor', x: 20, y: 20, width: 20, height: 20 });
    store.createNode({ nodeType: 'shape', id: 'far', x: 1000, y: 1000, width: 20, height: 20 });
    const group = store.groupNodes(['background', 'anchor'])!;
    store.commit({
      patches: Array.from({ length: 1000 }, (_, i) => ({
        op: 'set' as const,
        path: ['content', 'nodes', `c${i}`],
        value: {
          id: `c${i}`,
          type: 'node',
          nodeType: 'policy-child',
          parentId: group,
          x: i % 10,
          y: 20,
          width: 10,
          height: 10,
          rotation: 0,
          zIndex: 'a0',
          locked: false
        }
      }))
    });
    engine.session.setSelection({ nodeIds: [group] });
    expect(axes).toHaveBeenCalledTimes(1000);
    axes.mockClear();
    for (let i = 0; i < 100; i++) pointer(engine, 'move', { x: 400, y: 150 });
    store.updateNode('far', { style: { opacity: 0.5 } });
    expect(axes).not.toHaveBeenCalled();
    store.updateNode('c0', { rotation: 45 });
    expect(axes).toHaveBeenCalledTimes(1000);
    engine.destroy();
  });

  it('混合多选保留旋转单轴成员的集合约束', () => {
    const { engine, store, host } = setup();
    engine.nodeTypes.register({
      type: 'rotated-axis',
      label: '旋转单轴',
      defaultData: {},
      resize: 'width',
      createContent: () => ({ width: 100, height: 40 }),
      compose: () => []
    });
    engine.nodeTypes.register({
      type: 'varying-bounds',
      label: '按柄外框',
      defaultData: {},
      getResizeBehavior: () => 'resize-bounds',
      createContent: () => ({ width: 400, height: 300 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'rotated-axis', id: 'a', x: 100, y: 100 });
    store.updateNode('a', { rotation: 45 });
    store.createNode({ nodeType: 'varying-bounds', id: 'b', x: 600, y: 0 });
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    // 只剩多选外框；单选的可调宽度不能绕过多选相对旋转约束。
    expect(host.sessions.get('transform:handles')).toHaveLength(1);
    engine.destroy();
  });

  it('小尺寸仅边手柄合法时不因角柄避让隐藏唯一入口', () => {
    const { engine, store, host } = setup();
    engine.nodeTypes.register({
      type: 'tiny-edge',
      label: '小尺寸边柄',
      defaultData: {},
      resize: 'none',
      supportsContentScale: true,
      getResizeBehavior: (_node, handle) => (handle === 'e' ? 'scale-contents' : 'resize-bounds'),
      createContent: () => ({ width: 8, height: 8 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'tiny-edge', id: 'f', x: 0, y: 0 });
    engine.session.setSelection({ nodeIds: ['f'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(1);
    pointer(engine, 'down', { x: 8, y: 4 });
    pointer(engine, 'move', { x: 16, y: 4 });
    pointer(engine, 'up', { x: 16, y: 4 });
    expect(store.getNode('f')).toMatchObject({ width: 16, height: 16 });
    engine.destroy();
  });

  it('混合多选仅开放各节点都支持的实际手柄', () => {
    const { engine, store, host } = setup();
    const hook = vi.fn(() => ({}));
    engine.nodeTypes.register({
      type: 'mixed-handle',
      label: '混合手柄',
      defaultData: {},
      resize: 'none',
      supportsContentScale: true,
      getResizeBehavior: (_node, handle) => (handle === 'e' ? 'scale-contents' : 'resize-bounds'),
      applyContentScale: hook,
      createContent: () => ({ width: 400, height: 300 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'mixed-handle', id: 'f', x: 0, y: 0 });
    store.createNode({ nodeType: 'shape', id: 'b', x: 600, y: 0, width: 400, height: 300 });
    engine.session.setSelection({ nodeIds: ['f', 'b'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(2);
    pointer(engine, 'down', { x: 1000, y: 150 });
    pointer(engine, 'move', { x: 2000, y: 150 });
    pointer(engine, 'up', { x: 2000, y: 150 });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(store.getNode('f')!.width).toBe(800);
    expect(store.getNode('b')!.width).toBe(800);
    engine.destroy();
  });

  it.each(['readonly', 'selection', 'unmount'] as const)('%s 中断释放原生指针并停止旧手势', (mode) => {
    const { engine, store, host } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'f' });
    engine.session.setSelection({ nodeIds: ['f'] });
    const release = vi.spyOn(host, 'releasePointer');
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    if (mode === 'readonly') engine.session.setReadOnly(true);
    if (mode === 'selection') engine.session.setSelection({ nodeIds: [] });
    if (mode === 'unmount') engine.plugins.remove('@skynote/plugins-basic/transform');
    expect(release).toHaveBeenCalledTimes(1);
    const before = structuredClone(store.getView().content);
    pointer(engine, 'move', { x: 1200, y: 900 });
    pointer(engine, 'up', { x: 1200, y: 900 });
    expect(store.getView().content).toEqual(before);
    release.mockRestore();
    engine.destroy();
  });
  it.each(['add', 'edit', 'remove'] as const)('外部连线 %s 事务结束相关手势', (change) => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    for (const [id, x] of [
      ['a', 20],
      ['b', 200]
    ] as const)
      store.createNode({ nodeType: 'shape', id, x, y: 20, width: 80, height: 50, parentId: 'f' });
    const id = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    store.updateConnector(id, { controlPoints: [{ x: 150, y: 120 }] });
    engine.session.setSelection({ nodeIds: ['f'] });
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    if (change === 'add')
      store.commit({
        origin: 'remote',
        undoable: false,
        patches: [
          {
            op: 'set',
            path: ['content', 'connectors', 'late-link'],
            value: { ...store.getConnector(id), id: 'late-link' }
          }
        ]
      });
    if (change === 'edit')
      store.commit({
        origin: 'remote',
        undoable: false,
        patches: [{ op: 'set', path: ['content', 'connectors', id, 'controlPoints'], value: [{ x: 111, y: 222 }] }]
      });
    if (change === 'remove')
      store.commit({
        origin: 'remote',
        undoable: false,
        patches: [{ op: 'unset', path: ['content', 'connectors', id] }]
      });
    const after = structuredClone(store.getView().content);
    pointer(engine, 'move', { x: 1200, y: 900 });
    pointer(engine, 'up', { x: 1200, y: 900 });
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it('快照命令本身也固定作用域，不逐帧缩放后来加入的节点', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'f' });
    const snapshot = {
      nodes: new Map(
        ['f', 'a'].map((id) => [
          id,
          {
            node: structuredClone(store.getNode(id)!),
            frame: computeWorldFrame(store.getNode(id)!, engine.entityStore.getWorldTransform(id)!)
          }
        ])
      ),
      connectors: new Map()
    };
    store.createNode({ nodeType: 'shape', id: 'late', x: 30, y: 30, width: 10, height: 10, parentId: 'f' });
    for (const scale of [2, 3, 4])
      store.transformNodes([
        {
          id: 'f',
          frame: { cx: 200 * scale, cy: 150 * scale, width: 400 * scale, height: 300 * scale, rotation: 0 },
          scaleContents: true,
          scaleSnapshot: snapshot
        }
      ]);
    expect(store.getNode('a')!.width).toBe(320);
    expect(store.getNode('late')!.width).toBe(10);
    engine.destroy();
  });

  it('显式移除文本的 hook 不会被默认缩放补回', () => {
    const { engine, store } = setup();
    engine.nodeTypes.register({
      type: 'remove-text',
      label: '移除文字',
      defaultData: {},
      createContent: () => ({
        width: 100,
        height: 100,
        textBlocks: [{ id: 'body', slot: 'body', runs: [{ text: '移除' }] }]
      }),
      applyContentScale: () => ({ textBlocks: undefined }),
      compose: () => []
    });
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'remove-text', id: 'custom', x: 20, y: 20, parentId: 'f' });
    const before = structuredClone(store.getView().content);
    engine.session.setSelection({ nodeIds: ['f'] });
    store.clearHistory();
    drag(engine, { x: 400, y: 300 }, { x: 800, y: 600 });
    expect(store.getNode('custom')!.textBlocks).toBeUndefined();
    const restored = setup();
    restored.engine.nodeTypes.register(engine.nodeTypes.get('remove-text')!);
    expect(
      restored.store.restoreRecovery(
        JSON.parse(JSON.stringify(store.getView())),
        JSON.parse(JSON.stringify(store.getHistorySnapshot()))
      ).ok
    ).toBe(true);
    restored.store.undo();
    expect(restored.store.getView().content).toEqual(before);
    restored.engine.destroy();
    store.undo();
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it('相同坐标切换 Shift 不被重复输入短路', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0, width: 100, height: 100 });
    engine.session.setSelection({ nodeIds: ['a'] });
    pointer(engine, 'down', { x: 100, y: 100 });
    pointer(engine, 'move', { x: 200, y: 100 });
    expect(store.getNode('a')!.height).toBe(100);
    engine.pointer.dispatchPointerMove(
      new SyntheticPointerEvent({ point: { x: 200, y: 100 }, modifiers: { ctrl: true, shift: true } })
    );
    expect(store.getNode('a')!.height).toBe(200);
    pointer(engine, 'up', { x: 200, y: 100 });
    engine.destroy();
  });
  it.each([
    ['bounds', 'bounds'],
    ['bounds', 'scale'],
    ['bounds', 'auto'],
    ['scale', 'auto']
  ] as const)('多选 %s / %s 按各节点策略调整，内容位置和一次撤销保持一致', (first, second) => {
    const { engine, store } = setup();
    for (const [i, mode] of [first, second].entries()) {
      store.createNode({ nodeType: 'frame', id: `f${i}`, x: i * 400, y: 0, width: 200, height: 200, autoWrap: false });
      store.createNode({ nodeType: 'shape', id: `c${i}`, x: 20, y: 20, width: 80, height: 50, parentId: `f${i}` });
      store.updateNode(`f${i}`, { frame: { cornerResize: mode === 'scale' ? 'scale-contents' : 'resize-bounds' } });
      if (mode === 'auto')
        setFrameAutoLayout(store, engine.entityStore, [`f${i}`], {
          direction: 'horizontal',
          widthSizing: 'fixed',
          heightSizing: 'fixed'
        });
    }
    engine.session.setSelection({ nodeIds: ['f0', 'f1'] });
    const before = structuredClone(store.getView().content);
    const positions = ['c0', 'c1'].map((id) => engine.entityStore.getWorldTransform(id)!);
    store.clearHistory();
    drag(engine, { x: 600, y: 200 }, { x: 1200, y: 400 });
    [first, second].forEach((mode, i) => {
      expect(store.getNode(`f${i}`)!.width).toBe(400);
      expect(store.getNode(`c${i}`)!.width).toBe(mode === 'bounds' ? 80 : 160);
      if (mode === 'bounds') expect(engine.entityStore.getWorldTransform(`c${i}`)).toEqual(positions[i]);
    });
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it.each(['add', 'remove', 'reparent-in', 'reparent-out', 'replace', 'config'] as const)(
    '外部 %s 事务结束手势，不覆盖远端结果或继续放大新增成员',
    (change) => {
      const { engine, store } = setup();
      store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
      store.createNode({ nodeType: 'frame', id: 'outside', x: 1000, y: 0, width: 200, height: 200, autoWrap: false });
      store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'f' });
      store.createNode({ nodeType: 'shape', id: 'b', x: 20, y: 20, width: 30, height: 30, parentId: 'outside' });
      engine.session.setSelection({ nodeIds: ['f'] });
      store.clearHistory();
      pointer(engine, 'down', { x: 400, y: 300 });
      pointer(engine, 'move', { x: 800, y: 600 });
      if (change === 'add')
        store.commit({
          origin: 'remote',
          undoable: false,
          patches: [
            {
              op: 'set',
              path: ['content', 'nodes', 'late'],
              value: { ...store.getNode('a'), id: 'late', x: 30, y: 30, width: 10, height: 10 }
            }
          ]
        });
      if (change === 'remove')
        store.commit({
          origin: 'remote',
          undoable: false,
          patches: [{ op: 'unset', path: ['content', 'nodes', 'a'] }]
        });
      if (change === 'reparent-in')
        store.commit({
          origin: 'remote',
          undoable: false,
          patches: [{ op: 'set', path: ['content', 'nodes', 'b', 'parentId'], value: 'f' }]
        });
      if (change === 'reparent-out')
        store.commit({
          origin: 'remote',
          undoable: false,
          patches: [{ op: 'set', path: ['content', 'nodes', 'a', 'parentId'], value: 'outside' }]
        });
      if (change === 'replace')
        store.commit({
          origin: 'remote',
          undoable: false,
          patches: [{ op: 'set', path: ['content'], value: structuredClone(store.getView().content) }]
        });
      if (change === 'config')
        store.commit({
          origin: 'remote',
          undoable: false,
          patches: [{ op: 'set', path: ['content', 'nodes', 'f', 'frame'], value: { cornerResize: 'resize-bounds' } }]
        });
      const after = structuredClone(store.getView().content);
      pointer(engine, 'move', { x: 1200, y: 900 });
      pointer(engine, 'move', { x: 1600, y: 1200 });
      pointer(engine, 'up', { x: 1600, y: 1200 });
      expect(store.getView().content).toEqual(after);
      if (change === 'add') {
        expect(store.getNode('late')!.width).toBe(10);
        store.undo();
        expect(store.getNode('f')!.width).toBe(400);
        expect(store.getNode('late')!.width).toBe(10);
      }
      engine.destroy();
    }
  );

  it('无关远端事务不打断当前缩放', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'f' });
    engine.session.setSelection({ nodeIds: ['f'] });
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    store.commit({
      origin: 'remote',
      undoable: false,
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', 'far'],
          value: { ...store.getNode('a'), id: 'far', parentId: undefined, x: 2000, y: 2000, width: 10, height: 10 }
        }
      ]
    });
    pointer(engine, 'move', { x: 1600, y: 1200 });
    pointer(engine, 'up', { x: 1600, y: 1200 });
    expect(store.getNode('f')!.width).toBe(1600);
    expect(store.getNode('a')!.width).toBe(320);
    expect(store.getNode('far')!.width).toBe(10);
    engine.destroy();
  });

  it.each(['content', 'resize', 'direct-resize'] as const)('%s hook 的文本是最终结果，像素取整但不二次缩放', (kind) => {
    const { engine, store } = setup();
    const final = vi.fn((node: NodeEntity) => ({
      textBlocks: node.textBlocks!.map((block) => ({
        ...block,
        explicitWidth: 13.5,
        style: { fontSize: 12.5, lineHeight: 1.4, padding: 2.2 },
        runs: [{ text: '扩展结果', fontSize: 11.7, lineHeight: '12.3px' as const }]
      }))
    }));
    engine.nodeTypes.register({
      type: 'audit-text',
      label: '扩展文字',
      defaultData: {},
      createContent: () => ({
        width: 100,
        height: 100,
        textBlocks: [{ id: 'body', slot: 'body', runs: [{ text: '原始文字' }] }]
      }),
      ...(kind === 'content' ? { applyContentScale: final } : { applyResize: final }),
      compose: () => []
    });
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({
      nodeType: 'audit-text',
      id: 'custom',
      x: 20,
      y: 20,
      parentId: kind === 'direct-resize' ? undefined : 'f'
    });
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    engine.session.setSelection({ nodeIds: [kind === 'direct-resize' ? 'custom' : 'f'] });
    const from = kind === 'direct-resize' ? { x: 120, y: 120 } : { x: 400, y: 300 };
    const to = kind === 'direct-resize' ? { x: 220, y: 220 } : { x: 800, y: 600 };
    pointer(engine, 'down', from);
    pointer(engine, 'move', to);
    pointer(engine, 'up', to);
    expect(final).toHaveBeenCalledTimes(1);
    expect(store.getNode('custom')!.textBlocks![0]).toMatchObject({
      explicitWidth: 14,
      style: { fontSize: 13, lineHeight: 1.4, padding: 2 },
      runs: [{ text: '扩展结果', fontSize: 12, lineHeight: '12px' }]
    });
    store.undo();
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it.each([
    ['root', 'content'],
    ['root', 'resize'],
    ['group', 'content'],
    ['group', 'resize'],
    ['command', 'content'],
    ['command', 'resize']
  ] as const)('%s 容器整体缩放只调用一次 %s hook，最终字段与撤销正确', (scope, kind) => {
    const { engine, store } = setup();
    const final = (node: NodeEntity, scale: number) => ({
      textBlocks: node.textBlocks!.map((block) => ({ ...block, style: { fontSize: 10 * scale + 0.2 } }))
    });
    const contentHook = vi.fn(final);
    const resizeHook = vi.fn((node: NodeEntity, request: { scale: number }) => final(node, request.scale));
    engine.nodeTypes.register({
      type: 'hook-container',
      label: '扩展容器',
      defaultData: {},
      supportsContentScale: true,
      getResizeBehavior: () => 'scale-contents',
      applyResize: resizeHook,
      ...(kind === 'content' ? { applyContentScale: contentHook } : {}),
      createContent: () => ({
        width: 100,
        height: 100,
        textBlocks: [{ id: 'body', slot: 'body', runs: [{ text: '文字' }] }]
      }),
      compose: () => []
    });
    store.createNode({ nodeType: 'hook-container', id: 'custom', x: 0, y: 0 });
    let selected = 'custom';
    if (scope === 'group') {
      store.createNode({ nodeType: 'shape', id: 'b', x: 200, y: 0, width: 100, height: 100 });
      selected = store.groupNodes(['custom', 'b'])!;
    }
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    engine.session.setSelection({ nodeIds: [selected] });
    const from = { x: scope === 'group' ? 300 : 100, y: 100 };
    const to = { x: from.x * 2, y: 200 };
    if (scope === 'command') {
      store.transformNodes([
        { id: selected, frame: { cx: 100, cy: 100, width: 200, height: 200, rotation: 0 }, scaleContents: true }
      ]);
    } else {
      pointer(engine, 'down', from);
      pointer(engine, 'move', to);
      pointer(engine, 'move', to);
      pointer(engine, 'up', to);
    }
    expect(kind === 'content' ? contentHook : resizeHook).toHaveBeenCalledTimes(1);
    if (kind === 'content') expect(resizeHook).not.toHaveBeenCalled();
    expect(store.getNode('custom')).toMatchObject({
      width: 200,
      height: 200,
      textBlocks: [{ style: { fontSize: 20 } }]
    });
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    expect(store.getNode('custom')!.width).toBe(200);
    engine.destroy();
  });

  it('可缩放容器只调外框时仍只调用 applyResize', () => {
    const { engine, store } = setup();
    const contentHook = vi.fn(() => ({}));
    const resizeHook = vi.fn(() => ({}));
    engine.nodeTypes.register({
      type: 'bounds-container',
      label: '外框容器',
      defaultData: {},
      supportsContentScale: true,
      getResizeBehavior: () => 'resize-bounds',
      applyContentScale: contentHook,
      applyResize: resizeHook,
      createContent: () => ({ width: 100, height: 100 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'bounds-container', id: 'custom', x: 0, y: 0 });
    engine.session.setSelection({ nodeIds: ['custom'] });
    pointer(engine, 'down', { x: 100, y: 100 });
    pointer(engine, 'move', { x: 200, y: 200 });
    pointer(engine, 'up', { x: 200, y: 200 });
    expect(resizeHook).toHaveBeenCalledTimes(1);
    expect(contentHook).not.toHaveBeenCalled();
    engine.destroy();
  });

  it('可缩放容器 hook 每帧只调用一次，重复输入在生成大型字段前短路', () => {
    vi.useRealTimers();
    const { engine, store } = setup();
    const hook = vi.fn((node: NodeEntity, scale: number) => ({
      textBlocks: node.textBlocks!.map((block) => ({
        ...block,
        runs: block.runs.map((run) => ({ ...run, fontSize: Math.round(16 * scale) }))
      }))
    }));
    engine.nodeTypes.register({
      type: 'heavy-container',
      label: '重文本扩展',
      defaultData: {},
      supportsContentScale: true,
      applyContentScale: hook,
      createContent: () => ({
        width: 100,
        height: 100,
        textBlocks: [
          { id: 'body', slot: 'body', runs: Array.from({ length: 10000 }, () => ({ text: '字', fontSize: 16 })) }
        ]
      }),
      compose: () => []
    });
    store.createNode({ nodeType: 'heavy-container', id: 'custom', x: 0, y: 0 });
    store.createNode({ nodeType: 'shape', id: 'b', x: 200, y: 0, width: 100, height: 100 });
    const group = store.groupNodes(['custom', 'b'])!;
    engine.session.setSelection({ nodeIds: [group] });
    pointer(engine, 'down', { x: 300, y: 100 });
    pointer(engine, 'move', { x: 600, y: 200 });
    expect(hook).toHaveBeenCalledTimes(1);
    const changed = vi.fn();
    const off = store.subscribe(changed);
    hook.mockClear();
    const start = performance.now();
    for (let i = 0; i < 20; i++) pointer(engine, 'move', { x: 600, y: 200 });
    console.info(
      `[bench] 10000 行内文本重复输入 20 次: ${(performance.now() - start).toFixed(2)}ms，hook ${hook.mock.calls.length} 次`
    );
    expect(hook).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    pointer(engine, 'move', { x: 900, y: 300 });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(store.getNode('custom')!.textBlocks![0].runs[0].fontSize).toBe(48);
    off();
    pointer(engine, 'up', { x: 900, y: 300 });
    engine.destroy();
  });

  it('组合缩放不把成员的零跨度变成一个像素', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0, width: 100, height: 0 });
    store.createNode({ nodeType: 'shape', id: 'b', x: 200, y: 0, width: 100, height: 50 });
    const group = store.groupNodes(['a', 'b'])!;
    store.resizeNodes([group], { width: 600, height: 100 });
    expect(store.getNode('a')).toMatchObject({ width: 200, height: 0 });
    engine.destroy();
  });
  it('旋转容器只枚举成员，不准备后代世界框快照', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 30, width: 80, height: 50, parentId: 'F' });
    engine.session.setSelection({ nodeIds: ['F'] });
    const descendants = vi.spyOn(engine.entityStore, 'collectDescendantIds');
    const world = vi.spyOn(engine.entityStore, 'getWorldTransform');
    pointer(engine, 'down', { x: 412, y: 312 });
    expect(descendants).toHaveBeenCalledTimes(1);
    expect(world.mock.calls.some(([id]) => id === 'a')).toBe(false);
    pointer(engine, 'move', { x: 380, y: 360 });
    pointer(engine, 'up', { x: 380, y: 360 });
    expect(store.getNode('F')!.rotation).not.toBe(0);
    descendants.mockRestore();
    world.mockRestore();
    engine.destroy();
  });
  it.each(['se', 'nw', 'w'] as const)('%s 自由画框只调整外框时内容世界位置、文字及连线保持不变', (handle) => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 100, y: 100, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 30, width: 80, height: 50, parentId: 'F' });
    store.createNode({ nodeType: 'free-text', id: 'b', x: 180, y: 130, parentId: 'F', options: { text: '固定内容' } });
    store.updateNode('F', { frame: { cornerResize: 'resize-bounds' } });
    const connector = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    store.updateConnector(connector, { controlPoints: [{ x: 240, y: 200 }] });
    const before = structuredClone(store.getView().content);
    const world = ['a', 'b'].map((id) => engine.entityStore.getWorldTransform(id)!);
    engine.session.setSelection({ nodeIds: ['F'] });
    store.clearHistory();
    const from = handle === 'se' ? { x: 500, y: 400 } : handle === 'nw' ? { x: 100, y: 100 } : { x: 100, y: 250 };
    drag(engine, from, { x: from.x + 37, y: from.y + (handle === 'w' ? 0 : 29) });
    ['a', 'b'].forEach((id, i) => {
      expect(engine.entityStore.getWorldTransform(id)).toEqual(world[i]);
      expect(store.getNode(id)!.width).toBe(before.nodes[id].width);
      expect(store.getNode(id)!.textBlocks).toEqual(before.nodes[id].textBlocks);
    });
    expect(store.getConnector(connector)).toEqual(before.connectors[connector]);
    expect(store.getNode('F')!.width).not.toBe(before.nodes.F.width);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });

  it('自由画框四边只改外框；自动布局覆盖拖角偏好，关闭后保存并恢复', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 81, height: 51, parentId: 'F' });
    store.updateNode('F', { frame: { cornerResize: 'resize-bounds' } });
    expect(store.getNodeResizePolicy('F', 'pointer', 'se').behavior).toBe('resize-bounds');
    setFrameAutoLayout(store, engine.entityStore, ['F'], { direction: 'horizontal' });
    expect(store.getNodeResizePolicy('F', 'pointer', 'w')).toMatchObject({
      behavior: 'scale-contents',
      axes: 'both',
      lockAspect: true
    });
    const f = structuredClone(store.getNode('F')!);
    engine.session.setSelection({ nodeIds: ['F'] });
    drag(engine, { x: f.width, y: f.height }, { x: f.width * 2, y: f.height * 2 });
    expect(store.getNode('a')!.width).toBe(162);
    setFrameAutoLayout(store, engine.entityStore, ['F'], null);
    setFrameAutoLayout(store, engine.entityStore, ['F'], { direction: 'vertical' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], null);
    expect(store.getNodeResizePolicy('F', 'pointer', 'se').behavior).toBe('resize-bounds');
    const parsed = parseCanvasDocument(JSON.parse(JSON.stringify(store.getView())));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.content.nodes.F.frame?.cornerResize).toBe('resize-bounds');
    engine.destroy();
  });

  it('组合整体等比缩放覆盖形状标签与富文本，旋转成员尺寸输入共用手柄约束', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0, width: 100, height: 100 });
    store.createNode({ nodeType: 'shape', id: 'b', x: 200, y: 0, width: 100, height: 100 });
    store.updateNode('a', {
      textBlocks: store.getNode('a')!.textBlocks!.map((block) => ({
        ...block,
        style: { fontSize: 16, lineHeight: '20px' },
        runs: [{ text: '标签', fontSize: 18 }]
      }))
    });
    const group = store.groupNodes(['a', 'b'])!;
    store.resizeNodes([group], { width: 600, height: 200 });
    expect(store.getNode('a')!.textBlocks![0]).toMatchObject({
      style: { fontSize: 32, lineHeight: '40px' },
      runs: [{ text: '标签', fontSize: 36 }]
    });
    store.undo();
    store.updateNode('a', { rotation: 45 });
    const before = structuredClone(store.getNode(group)!);
    expect(store.getNodeResizePolicy(group, 'size').lockAspect).toBe(true);
    store.resizeNodes([group], { width: before.width * 2 });
    expect(Math.abs(store.getNode(group)!.width - before.width * 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(store.getNode(group)!.height - before.height * 2)).toBeLessThanOrEqual(2);
    engine.destroy();
  });

  it('重复相同缩放目标为零补丁，连线与后代不会重复通知', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    for (const [id, x] of [
      ['a', 20],
      ['b', 180]
    ] as const)
      store.createNode({ nodeType: 'shape', id, x, y: 20, width: 80, height: 50, parentId: 'F' });
    const connector = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    store.updateConnector(connector, { controlPoints: [{ x: 150, y: 120 }] });
    engine.session.setSelection({ nodeIds: ['F'] });
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    const changed = vi.fn();
    const off = store.subscribe(changed);
    changed.mockClear();
    pointer(engine, 'move', { x: 800, y: 600 });
    pointer(engine, 'move', { x: 800.01, y: 600.01 });
    expect(changed).not.toHaveBeenCalled();
    off();
    pointer(engine, 'up', { x: 800, y: 600 });
    engine.destroy();
  });

  it.each([
    ['free', false],
    ['horizontal', false],
    ['vertical', false],
    ['free', true],
    ['horizontal', true],
    ['vertical', true]
  ] as const)('%s 含自由文字时连续往返缩放使用起始快照，像素属性始终为整数（嵌套组合=%s）', (mode, nested) => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({
      nodeType: 'free-text',
      id: 'text',
      x: 20,
      y: 20,
      parentId: 'F',
      options: { text: '连续缩放文字' }
    });
    store.updateNode('text', {
      textBlocks: store.getNode('text')!.textBlocks!.map((block) => ({
        ...block,
        style: { fontSize: 18, lineHeight: '25px', letterSpacing: 1, padding: 3 }
      }))
    });
    store.createNode({ nodeType: 'shape', id: 'shape', x: 160, y: 100, width: 71, height: 53, parentId: 'F' });
    if (nested) {
      const group = store.groupNodes(['text', 'shape'])!;
      store.updateNode(group, { rotation: 17 });
    }
    if (mode !== 'free')
      setFrameAutoLayout(store, engine.entityStore, ['F'], { direction: mode, gap: 13, padding: 17 });
    const connector = store.createConnector({ from: { nodeId: 'text' }, to: { nodeId: 'shape' } })!;
    store.updateConnector(connector, { controlPoints: [{ x: 151, y: 121 }] });
    engine.session.setSelection({ nodeIds: ['F'] });
    const before = structuredClone(store.getView().content);
    const frame = before.nodes.F;
    const initialFont = before.nodes.text.textBlocks![0].style?.fontSize ?? 18;
    store.clearHistory();
    pointer(engine, 'down', { x: frame.width, y: frame.height });
    for (const factor of [1.13, 1.27, 0.81, 1.76, 0.55, 2, 1, 1.37]) {
      pointer(engine, 'move', { x: frame.width * factor, y: frame.height * factor });
      expect(store.getNode('text')!.textBlocks![0].style!.fontSize).toBe(Math.round(initialFont * factor));
      expect(store.getNode('text')!.textBlocks![0].style).toMatchObject({
        lineHeight: `${Math.round(25 * factor)}px`,
        padding: Math.round(3 * factor),
        letterSpacing: Math.round(factor)
      });
      for (const node of Object.values(store.getView().content.nodes))
        for (const key of ['x', 'y', 'width', 'height'] as const) expect(Number.isInteger(node[key])).toBe(true);
      const points = store.getConnector(connector)!.controlPoints!;
      expect(points).toEqual([{ x: Math.round(151 * factor), y: Math.round(121 * factor) }]);
      if (mode !== 'free')
        expect(store.getNode('F')!.layout!.options).toMatchObject({
          gap: Math.round(13 * factor),
          padding: Math.round(17 * factor)
        });
    }
    pointer(engine, 'up', { x: frame.width * 1.37, y: frame.height * 1.37 });
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
    store.undo();
    pointer(engine, 'down', { x: frame.width, y: frame.height });
    pointer(engine, 'move', { x: frame.width * 1.37, y: frame.height * 1.37 });
    pointer(engine, 'up', { x: frame.width * 1.37, y: frame.height * 1.37 });
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it.each(['horizontal', 'vertical'] as const)('%s 固定交叉轴溢出时小成员仍按容器边界居中或末尾对齐', (direction) => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 100, height: 100, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'large', x: 0, y: 0, width: 160, height: 160, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'small', x: 0, y: 0, width: 20, height: 20, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      direction,
      widthSizing: 'fixed',
      heightSizing: 'fixed',
      padding: 10,
      align: 'end'
    });
    const cross = direction === 'horizontal' ? 'y' : 'x';
    expect(store.getNode('small')?.[cross]).toBe(70);
    expect(store.getNode('large')?.[cross]).toBe(10);
    setFrameAutoLayout(store, engine.entityStore, ['F'], { align: 'center' });
    expect(store.getNode('small')?.[cross]).toBe(40);
    expect(store.getNode('large')?.[cross]).toBe(10);
    engine.destroy();
  });

  it('旋转容器整体缩放保留嵌套局部坐标与旋转，一步撤销；尺寸输入组合包含 hug 画框时同样整体等比缩放', () => {
    const { engine, store } = setup();
    store.createNode({
      nodeType: 'frame',
      id: 'F',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      rotation: 30,
      autoWrap: false
    });
    store.createNode({
      nodeType: 'frame',
      id: 'N',
      x: 60,
      y: 70,
      width: 100,
      height: 80,
      rotation: 20,
      parentId: 'F',
      autoWrap: false
    });
    store.createNode({ nodeType: 'shape', id: 'a', x: 10, y: 15, width: 20, height: 30, parentId: 'N' });
    engine.session.setSelection({ nodeIds: ['F'] });
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    const matrix = engine.entityStore.getWorldTransform('F')!;
    drag(engine, applyMatrix(matrix, 400, 300), applyMatrix(matrix, 800, 600));
    expect(store.getNode('F')?.width).toBeCloseTo(800, 3);
    expect(store.getNode('N')?.x).toBeCloseTo(120, 3);
    expect(store.getNode('N')?.rotation).toBe(20);
    expect(store.getNode('a')?.x).toBeCloseTo(20, 3);
    expect(store.getNode('a')?.width).toBeCloseTo(40, 3);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    engine.destroy();
    const next = setup();
    next.store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 200, height: 100, autoWrap: false });
    next.store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'F' });
    next.store.createNode({ nodeType: 'shape', id: 'b', x: 300, y: 0, width: 80, height: 50 });
    setFrameAutoLayout(next.store, next.engine.entityStore, ['F'], {});
    const group = next.store.groupNodes(['F', 'b'])!;
    const oldWidth = next.store.getNode(group)!.width;
    next.store.resizeNodes([group], { width: oldWidth * 2 });
    expect(next.store.getNode('a')).toMatchObject({ width: 160, height: 100 });
    expect(next.store.getNode('F')?.layout?.options).toMatchObject({
      widthSizing: 'hug',
      heightSizing: 'hug',
      padding: 48
    });
    next.engine.destroy();
  });

  it.each(['free', 'horizontal', 'vertical'] as const)(
    '%s 容器拖拽整体等比缩放节点、文字、内部连线及布局参数，一步撤销重做',
    (mode) => {
      const { engine, store } = setup();
      store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
      store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'F' });
      store.createNode({ nodeType: 'shape', id: 'b', x: 140, y: 100, width: 60, height: 70, parentId: 'F' });
      const block = store.getNode('a')!.textBlocks![0];
      store.updateNode('a', {
        textBlocks: [
          { ...block, style: { fontSize: 16, lineHeight: '20px', padding: 4 }, runs: [{ text: '缩放', fontSize: 20 }] }
        ]
      });
      if (mode !== 'free')
        setFrameAutoLayout(store, engine.entityStore, ['F'], {
          direction: mode,
          gap: 12,
          padding: { top: 10, right: 20, bottom: 30, left: 40 }
        });
      const id = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
      store.updateConnector(id, { controlPoints: [{ x: 150, y: 120 }] });
      engine.session.setSelection({ nodeIds: ['F'] });
      const before = structuredClone(store.getView().content);
      store.clearHistory();
      const f = before.nodes.F;
      drag(engine, { x: f.width, y: f.height }, { x: f.width * 2, y: f.height * 2 });
      expect(store.getNode('F')?.width).toBeCloseTo(f.width * 2, 3);
      expect(store.getNode('F')?.height).toBeCloseTo(f.height * 2, 3);
      for (const child of ['a', 'b']) {
        for (const key of ['x', 'y', 'width', 'height'] as const)
          expect(store.getNode(child)?.[key]).toBeCloseTo(before.nodes[child][key] * 2, 3);
      }
      expect(store.getNode('a')?.textBlocks?.[0].style).toMatchObject({
        fontSize: expect.closeTo(32),
        lineHeight: '40px',
        padding: expect.closeTo(8)
      });
      expect(store.getNode('a')?.textBlocks?.[0].runs[0].fontSize).toBeCloseTo(40);
      expect(store.getConnector(id)?.controlPoints?.[0].x).toBeCloseTo(300);
      expect(store.getConnector(id)?.controlPoints?.[0].y).toBeCloseTo(240);
      if (mode !== 'free')
        expect(store.getNode('F')?.layout?.options).toMatchObject({
          widthSizing: 'hug',
          heightSizing: 'hug',
          gap: expect.closeTo(24),
          padding: { top: 20, right: 40, bottom: 60, left: 80 }
        });
      const after = structuredClone(store.getView().content);
      store.undo();
      expect(store.getView().content).toEqual(before);
      expect(store.canUndo).toBe(false);
      store.redo();
      expect(store.getView().content).toEqual(after);
      engine.destroy();
    }
  );

  it('组合缩放时内部手动连线同步变换且嵌套画框内容一起缩放', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 100, height: 100, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'inner', x: 20, y: 20, width: 20, height: 20, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'b', x: 200, y: 0, width: 100, height: 100 });
    const group = store.groupNodes(['F', 'b'])!;
    const id = store.createConnector({ from: { nodeId: 'inner' }, to: { nodeId: 'b' } })!;
    store.updateConnector(id, { controlPoints: [{ x: 150, y: 150 }] });
    engine.session.setSelection({ nodeIds: [group] });
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    drag(engine, { x: 300, y: 100 }, { x: 600, y: 200 });
    expect(store.getNode('inner')).toMatchObject({ x: 40, y: 40, width: 40, height: 40 });
    expect(store.getConnector(id)?.controlPoints).toEqual([{ x: 300, y: 300 }]);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });

  it('关闭布局保留各框独立配置，保存重载后恢复，关闭与恢复均一步撤销', () => {
    const { engine, store } = setup();
    for (const id of ['F', 'G'])
      store.createNode({ nodeType: 'frame', id, x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      direction: 'vertical',
      gap: 37,
      padding: { top: 11, right: 23, bottom: 35, left: 47 },
      align: 'end',
      justify: 'center',
      widthSizing: 'fixed'
    });
    setFrameAutoLayout(store, engine.entityStore, ['G'], {
      direction: 'horizontal',
      gap: 19,
      padding: 17,
      align: 'center',
      heightSizing: 'fixed'
    });
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    setFrameAutoLayout(store, engine.entityStore, ['F', 'G'], null);
    const disabled = structuredClone(store.getView().content);
    expect(store.getNode('F')?.layout).toBeUndefined();
    expect(store.getNode('a')?.layoutItem).toBeUndefined();
    expect(store.getNode('F')?.frame?.inactiveLayout).toEqual(before.nodes.F.layout?.options);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    // 重载后仍从文档字段恢复，不依赖插件运行时缓存。
    const restored = setup();
    const parsed = parseCanvasDocument(JSON.parse(JSON.stringify(store.getView())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('布局参数文档无法重载');
    restored.store.replaceContent(parsed.value.content);
    restored.store.clearHistory();
    setFrameAutoLayout(restored.store, restored.engine.entityStore, ['F', 'G'], {});
    for (const id of ['F', 'G']) {
      expect(restored.store.getNode(id)?.layout).toEqual(before.nodes[id].layout);
      expect(restored.store.getNode(id)?.frame).toBeUndefined();
    }
    expect(restored.store.getNode('a')?.layoutItem).toEqual({});
    restored.store.undo();
    expect(restored.store.getView().content).toEqual(disabled);
    expect(restored.store.canUndo).toBe(false);
    restored.store.redo();
    expect(restored.store.getNode('F')?.layout).toEqual(before.nodes.F.layout);
    restored.engine.destroy();
    engine.destroy();
  });

  it.each(
    (['horizontal', 'vertical'] as const).flatMap((direction) =>
      (['start', 'center', 'end', 'space-between'] as const).map((justify) => ({ direction, justify }))
    )
  )('$direction 主轴 $justify 与交叉轴独立，hug 和溢出时不压缩间距，撤销完整恢复', ({ direction, justify }) => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'b', x: 200, y: 200, width: 60, height: 70, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      direction,
      widthSizing: 'fixed',
      heightSizing: 'fixed',
      gap: 10,
      padding: 20,
      align: 'end'
    });
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    setFrameAutoLayout(store, engine.entityStore, ['F'], { justify });
    const horizontal = direction === 'horizontal';
    const free = horizontal ? 210 : 130;
    const offset = justify === 'center' ? free / 2 : justify === 'end' ? free : 0;
    const a = 20 + offset;
    const b = a + (horizontal ? 90 : 60) + (justify === 'space-between' ? free : 0);
    expect(store.getNode('a')).toMatchObject(horizontal ? { x: a, y: 230 } : { x: 300, y: a });
    expect(store.getNode('b')).toMatchObject(horizontal ? { x: b, y: 210 } : { x: 320, y: b });
    if (justify !== 'start') {
      store.undo();
      expect(store.getView().content).toEqual(before);
      expect(store.canUndo).toBe(false);
      store.redo();
    }
    setFrameAutoLayout(store, engine.entityStore, ['F'], horizontal ? { widthSizing: 'hug' } : { heightSizing: 'hug' });
    expect(store.getNode('a')?.[horizontal ? 'x' : 'y']).toBe(20);
    expect(store.getNode('b')?.[horizontal ? 'x' : 'y']).toBe(horizontal ? 110 : 80);
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'fixed', heightSizing: 'fixed' });
    store.resizeNodes(['F'], horizontal ? { width: 100 } : { height: 100 });
    expect(store.getNode('a')?.[horizontal ? 'x' : 'y']).toBe(20);
    expect(store.getNode('b')?.[horizontal ? 'x' : 'y']).toBe(horizontal ? 110 : 80);
    if (justify === 'space-between') {
      store.removeEntities({ nodeIds: ['b'] });
      store.resizeNodes(['F'], horizontal ? { width: 400 } : { height: 300 });
      expect(store.getNode('a')?.[horizontal ? 'x' : 'y']).toBe(20);
    }
    engine.destroy();
  });

  it.each(
    (['horizontal', 'vertical'] as const).flatMap((direction) =>
      (['hug', 'fixed'] as const).flatMap((widthSizing) =>
        (['hug', 'fixed'] as const).map((heightSizing) => ({ direction, widthSizing, heightSizing }))
      )
    )
  )(
    '$direction 布局宽 $widthSizing / 高 $heightSizing 独立派生、对齐及空框尺寸，撤销完整恢复',
    ({ direction, widthSizing, heightSizing }) => {
      const { engine, store } = setup();
      store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
      store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'F' });
      store.createNode({ nodeType: 'shape', id: 'b', x: 200, y: 200, width: 60, height: 70, parentId: 'F' });
      setFrameAutoLayout(store, engine.entityStore, ['F'], {
        direction,
        widthSizing,
        heightSizing,
        gap: 10,
        padding: 20,
        align: 'center'
      });
      const horizontal = direction === 'horizontal';
      const width = widthSizing === 'fixed' ? 400 : horizontal ? 190 : 120;
      const height = heightSizing === 'fixed' ? 300 : horizontal ? 110 : 170;
      expect(store.getNode('F')).toMatchObject({ width, height });
      if (horizontal) {
        expect(store.getNode('a')).toMatchObject({ x: 20, y: 20 + (height - 40 - 50) / 2 });
        expect(store.getNode('b')).toMatchObject({ x: 110, y: 20 + (height - 40 - 70) / 2 });
      } else {
        expect(store.getNode('a')).toMatchObject({ x: 20 + (width - 40 - 80) / 2, y: 20 });
        expect(store.getNode('b')).toMatchObject({ x: 20 + (width - 40 - 60) / 2, y: 80 });
      }
      const before = structuredClone(store.getView().content);
      store.clearHistory();
      store.removeEntities({ nodeIds: ['a', 'b'] });
      expect(store.getNode('F')).toMatchObject({
        width: widthSizing === 'hug' ? 40 : 400,
        height: heightSizing === 'hug' ? 40 : 300
      });
      store.undo();
      expect(store.getView().content).toEqual(before);
      expect(store.canUndo).toBe(false);
      engine.destroy();
    }
  );

  it.each(['horizontal', 'vertical'] as const)('%s 布局始终可整体拖拽，尺寸输入仍只修改固定轴', (direction) => {
    const { engine, store, host } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 300, height: 200 });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { direction });
    engine.session.setSelection({ nodeIds: ['F'] });
    const handles = () => host.sessions.get('transform:handles')?.length ?? 0;
    expect(handles()).toBe(4);
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'fixed' });
    expect(handles()).toBe(4);
    store.updateNode('F', { aspectLocked: true });
    store.resizeNodes(['F'], { width: 300, height: 200 });
    expect(store.getNode('F')).toMatchObject({ width: 300, height: 98 });
    drag(engine, { x: 300, y: 49 }, { x: 600, y: 49 });
    expect(store.getNode('F')).toMatchObject({ width: 600, height: 196 });
    expect(store.getNode('a')).toMatchObject({ width: 160, height: 100 });
    store.undo();
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'hug', heightSizing: 'fixed' });
    expect(handles()).toBe(4);
    store.resizeNodes(['F'], { width: 500, height: 200 });
    expect(store.getNode('F')).toMatchObject({ width: 128, height: 200 });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'fixed' });
    expect(handles()).toBe(4);
    store.undo();
    expect(handles()).toBe(4);
    store.fitContent(['F']);
    expect(handles()).toBe(4);
    engine.destroy();
  });

  it('多选及组合包含 hug 画框时提供整体等比缩放', () => {
    const { engine, store, host } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 300, height: 200, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 400, y: 100, width: 80, height: 50 });
    setFrameAutoLayout(store, engine.entityStore, ['F'], {});
    engine.session.setSelection({ nodeIds: ['F', 'a'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(5);
    const id = store.groupNodes(['F', 'a']);
    engine.session.setSelection({ nodeIds: [id!] });
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'fixed', heightSizing: 'fixed' });
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    store.undo();
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    engine.destroy();
  });

  it('显式固定宽度后才能拉宽，高度仍随内容变化；单轴切换与适应内容可撤销重做', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300 });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 80, height: 50, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], {});
    store.clearHistory();
    expect(store.resizeNodes(['F'], { width: 300, height: 200 })).toBeNull();
    expect(store.canUndo).toBe(false);
    expect(store.getNode('F')).toMatchObject({ width: 128, height: 98 });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'fixed' });
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    store.resizeNodes(['F'], { width: 300 });
    expect(parseStackLayoutOptions(store.getNode('F')?.layout?.options)).toMatchObject({
      widthSizing: 'fixed',
      heightSizing: 'hug'
    });
    expect(store.getNode('F')).toMatchObject({ width: 300, height: 98 });
    store.updateNode('a', { height: 100 });
    expect(store.getNode('F')).toMatchObject({ width: 300, height: 148 });
    store.undo();
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    setFrameAutoLayout(store, engine.entityStore, ['F'], { heightSizing: 'fixed' });
    store.resizeNodes(['F'], { height: 200 });
    expect(parseStackLayoutOptions(store.getNode('F')?.layout?.options)).toMatchObject({
      widthSizing: 'fixed',
      heightSizing: 'fixed'
    });
    store.fitContent(['F']);
    expect(parseStackLayoutOptions(store.getNode('F')?.layout?.options)).toMatchObject({
      widthSizing: 'hug',
      heightSizing: 'hug'
    });
    expect(store.getNode('F')).toMatchObject({ width: 128, height: 98 });
    engine.destroy();
  });

  it('嵌套画框固定宽度、自适应高度按内层新高度级联，部分更新保留另一轴模式', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'outer', x: 0, y: 0, width: 500, height: 400, autoWrap: false });
    store.createNode({
      nodeType: 'frame',
      id: 'inner',
      x: 20,
      y: 20,
      width: 200,
      height: 100,
      parentId: 'outer',
      autoWrap: false
    });
    store.createNode({ nodeType: 'shape', id: 'a', x: 10, y: 10, width: 80, height: 50, parentId: 'inner' });
    setFrameAutoLayout(store, engine.entityStore, ['inner'], { widthSizing: 'fixed' });
    setFrameAutoLayout(store, engine.entityStore, ['outer'], { widthSizing: 'fixed' });
    store.updateNode('a', { height: 100 });
    expect(store.getNode('inner')).toMatchObject({ width: 200, height: 148 });
    expect(store.getNode('outer')).toMatchObject({ width: 500, height: 196 });
    setFrameAutoLayout(store, engine.entityStore, ['outer'], { heightSizing: 'fixed' });
    expect(parseStackLayoutOptions(store.getNode('outer')?.layout?.options)).toMatchObject({
      widthSizing: 'fixed',
      heightSizing: 'fixed'
    });
    engine.destroy();
  });

  it('Group 位于 stack 内：内部增删改尺寸按最新组外框重排，并保持单事务和一步撤销重做', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 800, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 10, y: 10, width: 50, height: 50, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'b', x: 70, y: 10, width: 50, height: 50, parentId: 'F' });
    const group = store.groupNodes(['a', 'b'])!;
    store.createNode({ nodeType: 'shape', id: 'c', x: 200, y: 10, width: 50, height: 50, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { gap: 10, padding: 20 });
    store.clearHistory();
    const before = structuredClone(store.getView());
    let commits = 0;
    const stop = store.subscribe(() => {
      commits++;
    });
    store.updateNode('b', { width: 150 });
    expect(commits).toBe(1);
    expect(store.getNode(group)?.width).toBe(210);
    expect(store.getNode('c')?.x).toBe(240);
    expect(store.getNode('F')?.width).toBe(310);
    const after = structuredClone(store.getView());
    store.undo();
    expect(store.getView().content).toEqual(before.content);
    store.redo();
    expect(store.getView().content).toEqual(after.content);
    store.removeEntities({ nodeIds: ['a', 'b'] });
    expect(store.getNode(group)).toBeUndefined();
    expect(store.getNode('c')?.x).toBe(20);
    expect(store.getNode('F')?.width).toBe(90);
    store.undo();
    expect(store.getView().content).toEqual(after.content);
    stop();
    engine.destroy();
  });

  it('stack → Group → stack → 文本交错嵌套在一个事务中由内向外派生，整体替换也保持一致', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'outer', x: 0, y: 0, width: 1200, height: 500, autoWrap: false });
    store.createNode({
      nodeType: 'frame',
      id: 'inner',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      parentId: 'outer',
      autoWrap: false
    });
    store.createNode({ nodeType: 'free-text', id: 'text', x: 0, y: 0, parentId: 'inner', options: { text: 'AB' } });
    store.createNode({ nodeType: 'shape', id: 'card', x: 100, y: 0, width: 50, height: 40, parentId: 'inner' });
    setFrameAutoLayout(store, engine.entityStore, ['inner'], { gap: 10, padding: 20 });
    store.createNode({ nodeType: 'shape', id: 'side', x: 400, y: 0, width: 30, height: 30, parentId: 'outer' });
    const group = store.groupNodes(['inner', 'side'])!;
    store.createNode({ nodeType: 'shape', id: 'last', x: 700, y: 0, width: 50, height: 50, parentId: 'outer' });
    setFrameAutoLayout(store, engine.entityStore, ['outer'], { gap: 10, padding: 20 });
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    store.updateNode('text', { textBlocks: [{ id: 'body', slot: 'body', runs: [{ text: '很长的文字'.repeat(12) }] }] });
    expect(store.getNode('inner')!.width).toBeCloseTo(40 + store.getNode('text')!.width + 10 + 50);
    expect(store.getNode('last')!.x).toBeCloseTo(20 + store.getNode(group)!.width + 10);
    expect(store.getNode('outer')!.width).toBeCloseTo(40 + store.getNode(group)!.width + 10 + 50);
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    expect(store.getView().content).toEqual(after);
    store.commit({ patches: [{ op: 'set', path: ['content'], value: after }] });
    expect(store.getView().content).toEqual(after);
    engine.destroy();
  });

  it('最后一个成员移出或删除后 hug 按四向边距收缩；空 fixed 保留尺寸，零边距保留最小尺寸', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 800, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0, width: 100, height: 50, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { padding: 20 });
    store.clearHistory();
    store.removeEntities({ nodeIds: ['a'] });
    expect(store.getNode('F')).toMatchObject({ width: 40, height: 40 });
    store.undo();
    expect(store.getNode('F')).toMatchObject({ width: 140, height: 90 });
    store.reparentNodes(['a'], undefined);
    expect(store.getNode('F')).toMatchObject({ width: 40, height: 40 });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { padding: [10, 20, 30, 40] });
    expect(store.getNode('F')).toMatchObject({ width: 60, height: 40 });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { padding: 0 });
    expect(store.getNode('F')).toMatchObject({ width: 1, height: 1 });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'fixed', heightSizing: 'fixed', padding: 50 });
    store.updateNode('F', { width: 300, height: 200 });
    expect(store.getNode('F')).toMatchObject({ width: 300, height: 200 });
    engine.destroy();
  });

  it.each(['readOnly', 'unmount'] as const)('拖动中 %s 打断会归位并释放托管，不阻断后续排版和撤销', (reason) => {
    const { engine, store, host } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 200, y: 100, width: 400, height: 200 });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 60, height: 40, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'b', x: 120, y: 20, width: 60, height: 40, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { gap: 20, padding: 20 });
    store.clearHistory();
    pointer(engine, 'down', { x: 250, y: 140 });
    pointer(engine, 'move', { x: 280, y: 155 });
    expect(store.getNode('a')?.y).toBe(35);
    if (reason === 'readOnly') engine.session.setReadOnly(true);
    else engine.plugins.remove('@skynote/plugins-basic/selection');
    expect(store.getNode('a')).toMatchObject({ x: 20, y: 20 });
    expect(host.sessions.has('selection:drop-target')).toBe(false);
    expect(host.sessions.has('selection:marquee')).toBe(false);
    engine.session.setReadOnly(false);
    store.updateNode('a', { x: 80, y: 80 });
    expect(store.getNode('a')).toMatchObject({ x: 20, y: 20 });
    store.undo();
    expect(store.getNode('a')).toMatchObject({ x: 20, y: 20 });
    engine.destroy();
  });

  it('开启水平与垂直自动布局：按子节点的视觉顺序初始化层叠顺序并自动计算成员位置与容器 hug 尺寸，关闭后保留位置', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 100, y: 100, width: 400, height: 300 });
    // 故意让 b 的视觉 x 在 a 左边，验证首次开启按视觉主轴排序
    store.createNode({ nodeType: 'shape', id: 'a', x: 180, y: 40, width: 80, height: 60, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'b', x: 20, y: 30, width: 100, height: 40, parentId: 'F' });
    store.clearHistory();

    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      direction: 'horizontal',
      gap: 16,
      padding: 24,
      align: 'center'
    });

    // b (100x40) 排在左，a (80x60) 排在右；最大高 60，b 垂直居中 y = 24 + (60 - 40)/2 = 34
    expect(store.getNode('b')).toMatchObject({ x: 24, y: 34, layoutItem: {} });
    expect(store.getNode('a')).toMatchObject({ x: 24 + 100 + 16, y: 24, layoutItem: {} });
    // 容器自适应宽高：width = 24*2 + 100 + 16 + 80 = 244, height = 24*2 + 60 = 108
    expect(store.getNode('F')).toMatchObject({ x: 100, y: 100, width: 244, height: 108 });

    // 切换为垂直堆叠、右对齐 (end)
    setFrameAutoLayout(store, engine.entityStore, ['F'], { direction: 'vertical', align: 'end' });
    // 最大宽 100：b (100x40) 在 (24, 24)，a (80x60) 在 (24 + 100 - 80 = 44, 24 + 40 + 16 = 80)
    expect(store.getNode('b')).toMatchObject({ x: 24, y: 24 });
    expect(store.getNode('a')).toMatchObject({ x: 44, y: 80 });
    expect(store.getNode('F')).toMatchObject({ width: 148, height: 164 });

    // 关闭自动布局：移除 layout 与 layoutItem，节点保留在当前排好的坐标
    setFrameAutoLayout(store, engine.entityStore, ['F'], null);
    expect(store.getNode('F')?.layout).toBeUndefined();
    expect(store.getNode('a')?.layoutItem).toBeUndefined();
    expect(store.getNode('b')?.layoutItem).toBeUndefined();
    expect(store.getNode('a')).toMatchObject({ x: 44, y: 80 });
  });

  it('支持四向独立内边距及 CSS 风格数组输入：数字 / [v, h] / [t, r, b, l] / 具名对象均可正确排版与紧凑存储', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 400, height: 300 });
    store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0, width: 100, height: 50, parentId: 'F' });

    // 1. CSS 风格 2 项数组 [vertical: 10, horizontal: 30]
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      direction: 'horizontal',
      padding: [10, 30]
    });
    // a 排在 left=30, top=10；F 尺寸为 100 + 30*2 = 160, 50 + 10*2 = 70
    expect(store.getNode('a')).toMatchObject({ x: 30, y: 10 });
    expect(store.getNode('F')).toMatchObject({ width: 160, height: 70 });
    // 存储规范化为对象
    expect(store.getNode('F')?.layout?.options).toMatchObject({
      padding: { top: 10, right: 30, bottom: 10, left: 30 }
    });

    // 2. CSS 风格 4 项数组 [top: 15, right: 25, bottom: 35, left: 45]
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      padding: [15, 25, 35, 45]
    });
    expect(store.getNode('a')).toMatchObject({ x: 45, y: 15 });
    expect(store.getNode('F')).toMatchObject({ width: 100 + 45 + 25, height: 50 + 15 + 35 });

    // 3. 四向相等时紧凑还原为纯数字
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      padding: { top: 20, right: 20, bottom: 20, left: 20 }
    });
    expect(store.getNode('F')?.layout?.options).toMatchObject({ padding: 20 });
    expect(store.getNode('a')).toMatchObject({ x: 20, y: 20 });

    // 4. 只传单边内边距时，其他三边正确保留现有值而不被重置为默认值
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      padding: { top: 20, right: 30, bottom: 40, left: 50 }
    });
    setFrameAutoLayout(store, engine.entityStore, ['F'], {
      padding: { top: 10 }
    });
    expect(store.getNode('F')?.layout?.options).toMatchObject({
      padding: { top: 10, right: 30, bottom: 40, left: 50 }
    });

    // 5. 连续调用 setFrameAutoLayout 传同一 groupId 时在撤销栈中合并为单一步骤
    store.clearHistory();
    setFrameAutoLayout(
      store,
      engine.entityStore,
      ['F'],
      { padding: { top: 22, right: 30, bottom: 40, left: 50 } },
      { groupId: 'g1' }
    );
    setFrameAutoLayout(
      store,
      engine.entityStore,
      ['F'],
      { padding: { top: 25, right: 30, bottom: 40, left: 50 } },
      { groupId: 'g1' }
    );
    setFrameAutoLayout(
      store,
      engine.entityStore,
      ['F'],
      { padding: { top: 30, right: 30, bottom: 40, left: 50 } },
      { groupId: 'g1' }
    );
    expect(store.getNode('a')).toMatchObject({ y: 30 });
    // 撤销一步直接回到组前状态 (padding.top 10, y 10)
    expect(store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
    expect(store.getNode('a')).toMatchObject({ y: 10 });
  });

  it('只有显式固定的轴可调整尺寸，调用 fitContent 恢复为 hug 自适应尺寸', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 0, y: 0, width: 300, height: 200 });
    store.createNode({ nodeType: 'shape', id: 'a', x: 10, y: 10, width: 80, height: 50, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { direction: 'horizontal' });
    expect(parseStackLayoutOptions(store.getNode('F')?.layout?.options).widthSizing).toBe('hug');
    expect(store.getNode('F')).toMatchObject({ width: 128, height: 98 });
    expect(store.canFitContent('F')).toBe(false);

    // 先显式选择固定，再允许调整尺寸。
    setFrameAutoLayout(store, engine.entityStore, ['F'], { widthSizing: 'fixed', heightSizing: 'fixed' });
    store.resizeNodes(['F'], { width: 300, height: 200 });
    expect(parseStackLayoutOptions(store.getNode('F')?.layout?.options).widthSizing).toBe('fixed');
    expect(store.getNode('F')).toMatchObject({ width: 300, height: 200 });
    expect(store.canFitContent('F')).toBe(true);

    // 适应内容：恢复两个轴为 hug，画框重新紧缩为 128x98
    store.fitContent(['F']);
    expect(parseStackLayoutOptions(store.getNode('F')?.layout?.options).widthSizing).toBe('hug');
    expect(store.getNode('F')).toMatchObject({ width: 128, height: 98 });
    expect(store.canFitContent('F')).toBe(false);
  });

  it('三阶段单事务级联派生：文字撑开 (Stage 1) → 自动堆叠画框重排撑大 (Stage 2) → 外层组合包络框紧缩 (Stage 3)，一步撤销全还原', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 100, y: 100, width: 200, height: 100 });
    const textId = store.createNode({
      nodeType: 'free-text',
      id: 'txt',
      x: 10,
      y: 10,
      parentId: 'F',
      options: { text: 'AB' }
    })!;
    store.createNode({ nodeType: 'shape', id: 'card', x: 100, y: 10, width: 60, height: 40, parentId: 'F' });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { direction: 'horizontal', gap: 10, padding: 20 });

    // 外层再放一个兄弟节点并与画框 F 编成组合 G
    store.createNode({ nodeType: 'shape', id: 'side', x: 50, y: 100, width: 30, height: 40 });
    const groupId = store.groupNodes(['side', 'F'])!;
    store.clearHistory();

    const beforeTxtWidth = store.getNode(textId)!.width;
    const beforeCardX = store.getNode('card')!.x;
    const beforeFrameWidth = store.getNode('F')!.width;
    const beforeGroupWidth = store.getNode(groupId)!.width;

    // 修改文字使其变长：单次提交内同时触发 Stage 1、Stage 2、Stage 3
    store.updateNode(textId, {
      textBlocks: [{ id: 'body', slot: 'body', runs: [{ text: '这是一段很长的自动撑开文字内容' }] }]
    });

    const afterTxtWidth = store.getNode(textId)!.width;
    const afterCardX = store.getNode('card')!.x;
    const afterFrameWidth = store.getNode('F')!.width;
    const afterGroupWidth = store.getNode(groupId)!.width;

    expect(afterTxtWidth).toBeGreaterThan(beforeTxtWidth);
    expect(afterCardX).toBeCloseTo(20 + afterTxtWidth + 10, 2);
    expect(afterCardX).toBeGreaterThan(beforeCardX);
    expect(afterFrameWidth).toBeCloseTo(20 * 2 + afterTxtWidth + 10 + 60, 2);
    expect(afterFrameWidth).toBeGreaterThan(beforeFrameWidth);
    expect(afterGroupWidth).toBeGreaterThan(beforeGroupWidth);

    // 一步撤销同时还原文字、卡片位置、画框尺寸与外层组合尺寸
    store.undo();
    expect(store.getNode(textId)!.width).toBeCloseTo(beforeTxtWidth, 2);
    expect(store.getNode('card')!.x).toBeCloseTo(beforeCardX, 2);
    expect(store.getNode('F')!.width).toBeCloseTo(beforeFrameWidth, 2);
    expect(store.getNode(groupId)!.width).toBeCloseTo(beforeGroupWidth, 2);
  });

  it('拖拽交互：画框内拖拽子成员跨过中线自动换序、外部节点按落点插入指定槽位、拖出画框自动移除 layoutItem 并收缩画框', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'F', x: 200, y: 100, width: 400, height: 200 });
    store.createNode({ nodeType: 'shape', id: 'a', x: 20, y: 20, width: 60, height: 40, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'b', x: 120, y: 20, width: 60, height: 40, parentId: 'F' });
    store.createNode({ nodeType: 'shape', id: 'ext', x: 0, y: 100, width: 60, height: 40 });
    setFrameAutoLayout(store, engine.entityStore, ['F'], { direction: 'horizontal', gap: 20, padding: 20 });
    store.clearHistory();

    // 初始：a 在 x=20 (世界 220..280)，b 在 x=100 (世界 300..360)
    expect(store.getNode('a')?.x).toBe(20);
    expect(store.getNode('b')?.x).toBe(100);

    // 1. 把 a (中心 250, 140) 拖到 b 右侧 (355, 140) -> 验证拖拽过程中 a 实时跟随指针，松手后精确吸附到槽位，换序为 [b, a]
    pointer(engine, 'down', { x: 250, y: 140 });
    // 拖动过程中：a 实时位移跟随指针 (偏移 +30, +15)，未被强制钉在原位
    pointer(engine, 'move', { x: 280, y: 155 });
    expect(store.getNode('a')?.x).toBeCloseTo(20 + 30, 1);
    expect(store.getNode('a')?.y).toBeCloseTo(20 + 15, 1);

    // 继续拖过中线到目标位置，松手
    pointer(engine, 'move', { x: 355, y: 140 });
    pointer(engine, 'up', { x: 355, y: 140 });
    expect(store.getNode('b')?.x).toBe(20);
    expect(store.getNode('a')?.x).toBe(100);
    expect(store.getNode('a')?.y).toBe(20);

    // 一步撤销换序
    store.undo();
    expect(store.getNode('a')?.x).toBe(20);
    expect(store.getNode('a')?.y).toBe(20);
    expect(store.getNode('b')?.x).toBe(100);

    // 2. 把外部节点 ext (中心 30, 120) 拖入 a 与 b 之间 (世界 290, 140，局部 x=90，位于 a 中心 50 与 b 中心 130 之间)
    drag(engine, { x: 30, y: 120 }, { x: 290, y: 140 });
    expect(store.getNode('ext')?.parentId).toBe('F');
    expect(store.getNode('ext')?.layoutItem).toEqual({});
    expect(store.getNode('a')?.x).toBe(20);
    expect(store.getNode('ext')?.x).toBe(100);
    expect(store.getNode('b')?.x).toBe(180);
    expect(store.getNode('F')?.width).toBe(20 * 2 + 60 * 3 + 20 * 2);

    // 3. 把中间的 ext (世界中心 330, 140) 拖出画框到空白处 (30, 400)
    drag(engine, { x: 330, y: 140 }, { x: 30, y: 400 });
    expect(store.getNode('ext')?.parentId).toBeUndefined();
    expect(store.getNode('ext')?.layoutItem).toBeUndefined();
    expect(store.getNode('b')?.x).toBe(100);
    expect(store.getNode('F')?.width).toBe(20 * 2 + 60 * 2 + 20);
    const extBounds = engine.getNodeWorldBounds('ext')!;
    expect((extBounds.left + extBounds.right) / 2).toBeCloseTo(30, 1);
    expect((extBounds.top + extBounds.bottom) / 2).toBeCloseTo(400, 1);

    // 一步撤销拖出：ext 重新回到画框中间槽位 x=100
    store.undo();
    expect(store.getNode('ext')?.parentId).toBe('F');
    expect(store.getNode('ext')?.layoutItem).toEqual({});
    expect(store.getNode('ext')?.x).toBe(100);
    expect(store.getNode('b')?.x).toBe(180);

    // 4. 拖拽过程中被系统打断 (pointerCancel / readOnly 切换)：托管成员安全归位到原有槽位，不产生悬空错位
    pointer(engine, 'down', { x: 250, y: 140 });
    pointer(engine, 'move', { x: 280, y: 155 });
    expect(store.getNode('a')?.x).toBeCloseTo(20 + 30, 1);
    engine.pointer.dispatchPointerCancel(
      new SyntheticPointerEvent({
        point: { x: 280, y: 155 },
        modifiers: { ctrl: true }
      })
    );
    expect(store.getNode('a')?.x).toBe(20);
    expect(store.getNode('a')?.y).toBe(20);
  });
});
