/**
 * @file transform-lifecycle.test.ts
 * @description 注册表变化不一定产生事务；控制柄及活动手势须独立跟随公开定义生命周期。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasHost,
  type CanvasPrimitive,
  type OverlayChannel,
  type Point,
  type TextInputSession
} from '@skynote/core';
import { BasicNodesPlugin, SelectionPlugin, TransformPlugin, setFrameAutoLayout } from '../src';

class LifecycleHost implements CanvasHost, OverlayChannel {
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
  readonly clear = vi.fn((id: string) => {
    this.sessions.delete(id);
  });
  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

function setup() {
  const engine = new SkyNoteEngine().use(new BasicNodesPlugin()).use(new SelectionPlugin()).use(new TransformPlugin());
  const host = new LifecycleHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1600, height: 1000 });
  return { engine, host, store: engine.documentStore };
}

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point): void {
  const event = new SyntheticPointerEvent({ point, modifiers: { ctrl: true } });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

describe('Transform 注册表生命周期', () => {
  it.each([false, true])('最顶层过滤保持父子选择顺序与锁定语义，反序=%s', (reverse) => {
    const { engine, host, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'parent', x: 0, y: 0, width: 100, height: 100, autoWrap: false });
    store.createNode({ nodeType: 'frame', id: 'child', parentId: 'parent', x: 200, y: 0, width: 100, height: 100 });
    const ids = ['parent', 'child'];
    if (reverse) ids.reverse();
    engine.session.setSelection({ nodeIds: ids });
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    store.updateNode('parent', { locked: true });
    expect(host.sessions.has('transform:handles')).toBe(false);
    engine.session.setSelection({ nodeIds: ['child'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    engine.destroy();
  });

  it('改挂、撤销与删除后重算最顶层目标，不复用旧父链结论', () => {
    const { engine, host, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'parent', x: 0, y: 0, width: 100, height: 100, autoWrap: false });
    store.createNode({ nodeType: 'frame', id: 'child', parentId: 'parent', x: 200, y: 0, width: 100, height: 100 });
    engine.session.setSelection({ nodeIds: ['parent', 'child'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    store.reparentNodes(['child'], undefined);
    expect(host.sessions.get('transform:handles')).toHaveLength(5);
    store.undo();
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    store.redo();
    store.removeEntities({ nodeIds: ['parent'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    store.updateNode('child', { parentId: 'missing' });
    engine.session.setSelection({ nodeIds: ['child', 'missing'] });
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    engine.destroy();
  });

  it.each(['replace', 'unregister', 'late-register'] as const)('%s 类型刷新手柄且不产生文档历史', (mode) => {
    const { engine, host, store } = setup();
    if (mode !== 'late-register')
      engine.nodeTypes.register({
        type: 'lifecycle-node',
        label: '可插拔',
        defaultData: {},
        resize: 'none',
        compose: () => []
      });
    store.addNode({
      id: 'n',
      type: 'node',
      nodeType: 'lifecycle-node',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    });
    engine.session.setSelection({ nodeIds: ['n'] });
    const count = () => host.sessions.get('transform:handles')?.length ?? 0;
    expect(count()).toBe(mode === 'late-register' ? 4 : 0);
    store.clearHistory();
    const before = structuredClone(store.getView().content);
    if (mode === 'unregister') engine.nodeTypes.unregister('lifecycle-node');
    else
      engine.nodeTypes.register({
        type: 'lifecycle-node',
        label: '新定义',
        defaultData: {},
        resize: mode === 'late-register' ? 'none' : 'both',
        compose: () => []
      });
    expect(count()).toBe(mode === 'late-register' ? 0 : 4);
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });

  it.each(['replace', 'unregister'] as const)('活动容器类型 %s 后释放指针并保留已提交结果', (mode) => {
    const { engine, host, store } = setup();
    engine.nodeTypes.register({
      type: 'live-container',
      label: '容器',
      defaultData: {},
      supportsContentScale: true,
      getResizeBehavior: () => 'scale-contents',
      createContent: () => ({ width: 400, height: 300 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'live-container', id: 'n', x: 0, y: 0 });
    engine.session.setSelection({ nodeIds: ['n'] });
    store.clearHistory();
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    expect(store.getNode('n')!.width).toBe(800);
    const before = structuredClone(store.getView().content);
    if (mode === 'unregister') engine.nodeTypes.unregister('live-container');
    else
      engine.nodeTypes.register({
        type: 'live-container',
        label: '禁止缩放',
        defaultData: {},
        resize: 'none',
        compose: () => []
      });
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    pointer(engine, 'move', { x: 1200, y: 900 });
    pointer(engine, 'up', { x: 1200, y: 900 });
    expect(store.getView().content).toEqual(before);
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    store.undo();
    expect(store.getNode('n')!.width).toBe(400);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });

  it('后代类型变化结束整体缩放，组合成员类型变化刷新约束', () => {
    const { engine, host, store } = setup();
    engine.nodeTypes.register({
      type: 'dependent-child',
      label: '成员',
      defaultData: {},
      createContent: () => ({ width: 100, height: 40 }),
      compose: () => []
    });
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'dependent-child', id: 'child', parentId: 'f', x: 20, y: 20 });
    engine.session.setSelection({ nodeIds: ['f'] });
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    engine.nodeTypes.register({
      type: 'dependent-child',
      label: '新成员',
      defaultData: {},
      resize: 'width',
      compose: () => []
    });
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    pointer(engine, 'move', { x: 1200, y: 900 });
    expect(store.getNode('f')!.width).toBe(800);
    store.reparentNodes(['child'], undefined);
    store.createNode({ nodeType: 'shape', id: 'background', x: 0, y: 0, width: 1000, height: 800 });
    const group = store.groupNodes(['child', 'background'])!;
    engine.session.setSelection({ nodeIds: [group] });
    expect(host.sessions.get('transform:handles')).toHaveLength(2);
    engine.nodeTypes.unregister('dependent-child');
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    engine.destroy();
  });

  it.each(['unregister', 'late-register'] as const)('祖先布局 %s 即时更新成员旋转热区', (mode) => {
    const engine = new SkyNoteEngine().use(new BasicNodesPlugin()).use(new TransformPlugin());
    const host = new LifecycleHost();
    engine.attachHost(host);
    const store = engine.documentStore;
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'child', parentId: 'f', x: 24, y: 24, width: 100, height: 100 });
    setFrameAutoLayout(store, engine.entityStore, ['f'], { widthSizing: 'fixed', heightSizing: 'fixed' });
    const definition = engine.layouts.get('stack')!;
    if (mode === 'late-register') engine.layouts.unregister(definition);
    engine.session.setSelection({ nodeIds: ['child'] });
    const before = structuredClone(store.getView().content);
    if (mode === 'unregister') engine.layouts.unregister(definition);
    else engine.layouts.register(definition);
    expect(store.getView().content).toEqual(before);
    pointer(engine, 'down', { x: 136, y: 136 });
    expect(host.capturePointer).toHaveBeenCalledTimes(mode === 'unregister' ? 1 : 0);
    pointer(engine, 'up', { x: 136, y: 136 });
    engine.destroy();
  });

  it('布局定义替换即使没有排版补丁也结束相关缩放', () => {
    const { engine, host, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    store.createNode({ nodeType: 'shape', id: 'child', parentId: 'f', x: 24, y: 24, width: 100, height: 100 });
    setFrameAutoLayout(store, engine.entityStore, ['f'], { widthSizing: 'fixed', heightSizing: 'fixed' });
    engine.session.setSelection({ nodeIds: ['f'] });
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    const before = structuredClone(store.getView().content);
    const definition = engine.layouts.get('stack')!;
    engine.layouts.register({ id: 'stack', label: '替换布局', arrange: (tree) => definition.arrange(tree) });
    expect(store.getNode('f')!.width).toBe(800);
    expect(host.releasePointer).toHaveBeenCalledTimes(1);
    pointer(engine, 'move', { x: 1200, y: 900 });
    expect(store.getView().content).toEqual(before);
    engine.destroy();
  });

  it('无关类型及布局注册不结束手势或刷新控制柄', () => {
    const { engine, host, store } = setup();
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    engine.session.setSelection({ nodeIds: ['f'] });
    pointer(engine, 'down', { x: 400, y: 300 });
    pointer(engine, 'move', { x: 800, y: 600 });
    host.setPrimitives.mockClear();
    engine.nodeTypes.register({ type: 'unrelated', label: '无关', defaultData: {}, compose: () => [] });
    engine.layouts.register({ id: 'unrelated', label: '无关布局', arrange: () => new Map() });
    expect(host.releasePointer).not.toHaveBeenCalled();
    expect(host.setPrimitives).not.toHaveBeenCalled();
    pointer(engine, 'move', { x: 1200, y: 900 });
    expect(store.getNode('f')!.width).toBe(1200);
    pointer(engine, 'up', { x: 1200, y: 900 });
    engine.destroy();
  });

  it('插件卸载自动释放注册表订阅，后续变化不写宿主', () => {
    const engine = new SkyNoteEngine().use(new BasicNodesPlugin());
    const host = new LifecycleHost();
    engine.attachHost(host);
    const store = engine.documentStore;
    const subscribeTypes = engine.nodeTypes.onChange.bind(engine.nodeTypes);
    const subscribeLayouts = engine.layouts.onChange.bind(engine.layouts);
    const typeNotification = vi.fn();
    const layoutNotification = vi.fn();
    const unsubscribeTypes = vi.fn();
    const unsubscribeLayouts = vi.fn();
    vi.spyOn(engine.nodeTypes, 'onChange').mockImplementation((listener) => {
      const off = subscribeTypes((type) => {
        typeNotification(type);
        listener(type);
      });
      return () => {
        unsubscribeTypes();
        off();
      };
    });
    vi.spyOn(engine.layouts, 'onChange').mockImplementation((listener) => {
      const off = subscribeLayouts(() => {
        layoutNotification();
        listener();
      });
      return () => {
        unsubscribeLayouts();
        off();
      };
    });
    engine.use(new TransformPlugin());
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0, width: 400, height: 300, autoWrap: false });
    engine.session.setSelection({ nodeIds: ['f'] });
    engine.plugins.remove('@skynote/plugins-basic/transform');
    expect(unsubscribeTypes).toHaveBeenCalledTimes(1);
    expect(unsubscribeLayouts).toHaveBeenCalledTimes(1);
    host.clear.mockClear();
    host.setPrimitives.mockClear();
    host.setCursor.mockClear();
    engine.nodeTypes.unregister('frame');
    engine.layouts.unregister(engine.layouts.get('stack')!);
    expect(typeNotification).not.toHaveBeenCalled();
    expect(layoutNotification).not.toHaveBeenCalled();
    expect(host.clear).not.toHaveBeenCalled();
    expect(host.setPrimitives).not.toHaveBeenCalled();
    expect(host.setCursor).not.toHaveBeenCalled();
    engine.destroy();
  });

  it('Transform 晚安装时立即绘制已有选区', () => {
    const engine = new SkyNoteEngine().use(new BasicNodesPlugin());
    const host = new LifecycleHost();
    engine.attachHost(host);
    engine.documentStore.createNode({ nodeType: 'shape', id: 'n', x: 0, y: 0, width: 100, height: 100 });
    engine.session.setSelection({ nodeIds: ['n'] });
    engine.use(new TransformPlugin());
    expect(host.sessions.get('transform:handles')).toHaveLength(4);
    engine.destroy();
  });
});
