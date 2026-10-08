/**
 * @file interactions.test.ts
 * @description 基础交互：点选 / 加选 / 框选 / 拖拽移动、视口平移与缩放、编辑快捷键、选中框覆盖层
 */

import { describe, it, expect } from 'vitest';
import {
  SkyNoteEngine,
  applyMatrix,
  SyntheticPointerEvent,
  SyntheticWheelEvent,
  type CanvasKeyboardEvent,
  type CanvasHost,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type OverlayOptions,
  type Point,
  type CanvasCursor,
  type TextInputSession
} from '@skynote/core';
import {
  BasicNodesPlugin,
  EditingShortcutsPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  TransformPlugin,
  ViewportNavigationPlugin,
  SELECTION_PLUGIN_ID
} from '../src';

/** 记录覆盖层、光标与指针捕获的假宿主 */
class FakeHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, { primitives: readonly CanvasPrimitive[]; transient: boolean }>();
  readonly cursors: CanvasCursor[] = [];
  readonly captured = new Set<number>();

  get overlay(): OverlayChannel {
    return this;
  }

  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    if (primitives.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { primitives, transient: options?.transient ?? false });
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setCursor(cursor: CanvasCursor): void {
    this.cursors.push(cursor);
  }

  capturePointer(pointerId: number): void {
    this.captured.add(pointerId);
  }

  releasePointer(pointerId: number): void {
    this.captured.delete(pointerId);
  }

  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

/** 画布 (视口 1000 x 800)：a (0,0) 与 b (300,0) 两个 160x100 形状，c 在容器 frame (0,400) 内 */
function setup() {
  const engine = new SkyNoteEngine()
    .use(new BasicNodesPlugin())
    .use(new ViewportNavigationPlugin())
    .use(new SelectionPlugin())
    .use(new SelectionOutlinePlugin())
    .use(new EditingShortcutsPlugin())
    .use(new TransformPlugin());
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1000, height: 800 });
  const store = engine.documentStore;
  engine.documentStore.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0 });
  engine.documentStore.createNode({ nodeType: 'shape', id: 'b', x: 300, y: 0 });
  engine.documentStore.createNode({ nodeType: 'shape', id: 'frame', x: 0, y: 400, width: 400, height: 300 });
  engine.documentStore.createNode({ nodeType: 'shape', id: 'c', x: 20, y: 20, parentId: 'frame' });
  store.clearHistory();
  return { engine, store, overlay: host.sessions, cursors: host.cursors, captured: host.captured };
}

type Engine = SkyNoteEngine;

/** 视口为单位矩阵时屏幕坐标 = 世界坐标，指针落点直接给世界坐标即可 */
function pointer(
  engine: Engine,
  phase: 'down' | 'move' | 'up',
  point: Point,
  init: Partial<{ shift: boolean; alt: boolean; button: number; client: Point }> = {}
) {
  const { x, y, zoom } = engine.session.viewport;
  const client = init.client ?? { x: point.x * zoom + x, y: point.y * zoom + y };
  const event = new SyntheticPointerEvent({
    point,
    clientPoint: client,
    target: engine.hitTestNode(point) as NodeEntity | undefined,
    button: init.button ?? 0,
    modifiers: { shift: init.shift ?? false, alt: init.alt ?? false }
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

function key(engine: Engine, code: string, init: Partial<CanvasKeyboardEvent> = {}, phase: 'down' | 'up' = 'down') {
  const event: CanvasKeyboardEvent = {
    key: init.key ?? code,
    code,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...init
  };
  return phase === 'down' ? engine.inputScopes.dispatchKeyDown(event) : engine.inputScopes.dispatchKeyUp(event);
}

const selection = (engine: Engine) => [...engine.session.selectedNodeIds].sort();

describe('点选与加选', () => {
  it('单击选中、Shift 加选与反选、单击空白清空', () => {
    const { engine } = setup();
    pointer(engine, 'down', { x: 10, y: 10 });
    pointer(engine, 'up', { x: 10, y: 10 });
    expect(selection(engine)).toEqual(['a']);

    pointer(engine, 'down', { x: 310, y: 10 }, { shift: true });
    pointer(engine, 'up', { x: 310, y: 10 }, { shift: true });
    expect(selection(engine)).toEqual(['a', 'b']);

    pointer(engine, 'down', { x: 10, y: 10 }, { shift: true });
    pointer(engine, 'up', { x: 10, y: 10 }, { shift: true });
    expect(selection(engine)).toEqual(['b']);

    pointer(engine, 'down', { x: 700, y: 300 });
    pointer(engine, 'up', { x: 700, y: 300 });
    expect(selection(engine)).toEqual([]);
  });

  it('多选中单击其中一个 (未拖拽) 抬起后只选它；按下时不收窄，便于拖动整组', () => {
    const { engine } = setup();
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    pointer(engine, 'down', { x: 10, y: 10 });
    expect(selection(engine)).toEqual(['a', 'b']);
    pointer(engine, 'up', { x: 10, y: 10 });
    expect(selection(engine)).toEqual(['a']);
  });

  it('点在容器内的子节点上直接选中子节点', () => {
    const { engine } = setup();
    pointer(engine, 'down', { x: 30, y: 430 });
    pointer(engine, 'up', { x: 30, y: 430 });
    expect(selection(engine)).toEqual(['c']);
  });
});

describe('拖拽移动', () => {
  it('超过阈值后移动整个选区 (容器带着子节点)，一次拖拽一步撤销', () => {
    const { engine, store, cursors } = setup();
    engine.session.setSelection({ nodeIds: ['a', 'frame'] });
    pointer(engine, 'down', { x: 10, y: 10 });
    for (let i = 1; i <= 10; i++) pointer(engine, 'move', { x: 10 + i * 5, y: 10 + i * 2 });
    pointer(engine, 'up', { x: 60, y: 30 });

    expect(store.getNode('a')).toMatchObject({ x: 50, y: 20 });
    expect(store.getNode('frame')).toMatchObject({ x: 50, y: 420 });
    // 子节点局部坐标不变，随容器移动
    expect(store.getNode('c')).toMatchObject({ x: 20, y: 20 });
    expect(cursors).toContain('move');
    expect(store.undoEntries).toHaveLength(1);

    store.undo();
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
    expect(store.getNode('frame')).toMatchObject({ x: 0, y: 400 });
  });

  it('阈值内的抖动不产生移动事务；锁定节点不随选区移动', () => {
    const { engine, store } = setup();
    pointer(engine, 'down', { x: 10, y: 10 });
    pointer(engine, 'move', { x: 11, y: 11 });
    pointer(engine, 'up', { x: 11, y: 11 });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
    expect(store.canUndo).toBe(false);

    store.updateNode('b', { locked: true }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    pointer(engine, 'down', { x: 10, y: 10 });
    pointer(engine, 'move', { x: 110, y: 10 });
    pointer(engine, 'up', { x: 110, y: 10 });
    expect(store.getNode('a')!.x).toBe(100);
    expect(store.getNode('b')!.x).toBe(300);
  });
});

describe('框选', () => {
  it('从空白处拖出选框：选中相交的根层级节点，命中子节点时选中其容器；选框为瞬态覆盖层，松手清除', () => {
    const { engine, overlay } = setup();
    pointer(engine, 'down', { x: -50, y: 50 });
    pointer(engine, 'move', { x: 350, y: 450 });
    expect(overlay.get('selection:marquee')?.transient).toBe(true);
    expect(selection(engine)).toEqual(['a', 'b', 'frame']);

    // 选框缩回时选区随之缩小
    pointer(engine, 'move', { x: 100, y: 90 });
    expect(selection(engine)).toEqual(['a']);
    pointer(engine, 'up', { x: 100, y: 90 });
    expect(overlay.has('selection:marquee')).toBe(false);
  });

  it('Shift 框选在原选区基础上追加', () => {
    const { engine } = setup();
    engine.session.setSelection({ nodeIds: ['b'] });
    pointer(engine, 'down', { x: -50, y: 50 }, { shift: true });
    pointer(engine, 'move', { x: 100, y: 90 }, { shift: true });
    pointer(engine, 'up', { x: 100, y: 90 }, { shift: true });
    expect(selection(engine)).toEqual(['a', 'b']);
  });
});

describe('视口导航', () => {
  it('按住空格拖拽平移画布 (按屏幕像素)，期间不触发框选；中键同样平移', () => {
    const { engine, cursors } = setup();
    key(engine, 'Space', { key: ' ' });
    expect(cursors.at(-1)).toBe('grab');
    pointer(engine, 'down', { x: 700, y: 300 });
    pointer(engine, 'move', { x: 700, y: 300 }, { client: { x: 760, y: 280 } });
    pointer(engine, 'up', { x: 700, y: 300 }, { client: { x: 760, y: 280 } });
    expect(engine.session.viewport).toMatchObject({ x: 60, y: -20 });
    key(engine, 'Space', { key: ' ' }, 'up');
    expect(cursors.at(-1)).toBe('default');

    engine.session.setSelection({ nodeIds: ['a'] });
    pointer(engine, 'down', { x: 10, y: 10 }, { button: 1, client: { x: 70, y: -10 } });
    pointer(engine, 'move', { x: 10, y: 10 }, { button: 1, client: { x: 90, y: -10 } });
    pointer(engine, 'up', { x: 10, y: 10 }, { button: 1, client: { x: 90, y: -10 } });
    expect(engine.session.viewport.x).toBe(80);
    // 中键落在节点上也只平移，不改变选区、不移动节点
    expect(selection(engine)).toEqual(['a']);
    expect(engine.documentStore.getNode('a')!.x).toBe(0);
  });

  it('Ctrl + = / - / 0 以视口中心缩放，Shift + 1 适配全部内容', () => {
    const { engine } = setup();
    key(engine, 'Equal', { key: '=', ctrlKey: true });
    const { x, y, zoom } = engine.session.viewport;
    expect(zoom).toBeCloseTo(1.2);
    // 视口中心 (500, 400) 的世界点保持不动
    expect(500 * zoom + x).toBeCloseTo(500);
    expect(400 * zoom + y).toBeCloseTo(400);

    key(engine, 'Digit0', { key: '0', ctrlKey: true });
    expect(engine.session.viewport.zoom).toBeCloseTo(1);

    key(engine, 'Digit1', { key: '!', shiftKey: true });
    // 内容 460 x 700 (含容器)，可用高度 800 - 160
    expect(engine.session.viewport.zoom).toBeCloseTo(640 / 700);
  });

  it('滚轮平移视口；捏合以指针为不动点缩放，快速滚动的巨大增量也不会越出缩放范围', () => {
    const { engine } = setup();
    engine.pointer.dispatchWheel(new SyntheticWheelEvent({ centerPoint: { x: 0, y: 0 }, deltaPan: { x: -30, y: 20 } }));
    expect(engine.session.viewport).toMatchObject({ x: -30, y: 20, zoom: 1 });

    engine.pointer.dispatchWheel(new SyntheticWheelEvent({ centerPoint: { x: 100, y: 100 }, deltaZoom: Math.log(2) }));
    const { x, y, zoom } = engine.session.viewport;
    expect(zoom).toBeCloseTo(2);
    // 世界点 (100, 100) 的屏幕位置不变：缩放前为 (70, 120)
    expect(100 * zoom + x).toBeCloseTo(70);
    expect(100 * zoom + y).toBeCloseTo(120);

    engine.pointer.dispatchWheel(new SyntheticWheelEvent({ centerPoint: { x: 0, y: 0 }, deltaZoom: -50 }));
    expect(engine.session.viewport.zoom).toBe(engine.session.zoomRange.min);
  });
});

describe('编辑快捷键', () => {
  it('删除选中 (跳过锁定节点)、撤销重做、全选、Esc 清空且不吞掉按键', () => {
    const { engine, store } = setup();
    store.updateNode('b', { locked: true }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    expect(key(engine, 'Delete', { key: 'Delete' })).toBe(true);
    expect(store.getNode('a')).toBeUndefined();
    expect(store.getNode('b')).toBeDefined();

    key(engine, 'KeyZ', { key: 'z', ctrlKey: true });
    expect(store.getNode('a')).toBeDefined();
    key(engine, 'KeyZ', { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(store.getNode('a')).toBeUndefined();
    key(engine, 'KeyY', { key: 'y', ctrlKey: true });
    key(engine, 'KeyZ', { key: 'z', metaKey: true });
    expect(store.getNode('a')).toBeDefined();

    key(engine, 'KeyA', { key: 'a', ctrlKey: true });
    expect(selection(engine)).toEqual(['a', 'b', 'frame']);
    expect(key(engine, 'Escape', { key: 'Escape' })).toBe(false);
    expect(selection(engine)).toEqual([]);
  });

  it('] [ 调整层级 (Shift 置顶置底)，方向键微移 (Shift 10)', () => {
    const { engine, store } = setup();
    engine.session.setSelection({ nodeIds: ['a'] });
    const order = () =>
      [...engine.entityStore.getChildIds(undefined)]
        .map((id) => store.getNode(id)!)
        .sort((l, r) => (l.zIndex < r.zIndex ? -1 : 1))
        .map((n) => n.id);
    key(engine, 'BracketRight', { key: ']' });
    expect(order()).toEqual(['b', 'a', 'frame']);
    key(engine, 'BracketRight', { key: '}', shiftKey: true });
    expect(order()).toEqual(['b', 'frame', 'a']);
    key(engine, 'BracketLeft', { key: '{', shiftKey: true });
    expect(order()).toEqual(['a', 'b', 'frame']);

    key(engine, 'ArrowRight', { key: 'ArrowRight' });
    key(engine, 'ArrowDown', { key: 'ArrowDown', shiftKey: true });
    expect(store.getNode('a')).toMatchObject({ x: 1, y: 10 });
  });

  it('Ctrl+D 创建副本 (跳过锁定节点) 并选中副本；Ctrl+Shift+L 锁定，全部已锁定时解锁', () => {
    const { engine, store } = setup();
    store.updateNode('b', { locked: true }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    expect(key(engine, 'KeyD', { key: 'd', ctrlKey: true })).toBe(true);
    const [copy] = selection(engine);
    expect(selection(engine)).toHaveLength(1);
    expect(store.getNode(copy)).toMatchObject({ x: 20, y: 20 });

    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    key(engine, 'KeyL', { key: 'L', ctrlKey: true, shiftKey: true });
    expect(store.getNode('a')!.locked).toBe(true);
    key(engine, 'KeyL', { key: 'L', ctrlKey: true, shiftKey: true });
    expect(store.getNode('a')!.locked).toBe(false);
    expect(store.getNode('b')!.locked).toBe(false);
  });

  it('没有选区时删除与方向键不消费按键 (交给页面或其他作用域)', () => {
    const { engine } = setup();
    expect(key(engine, 'Delete', { key: 'Delete' })).toBe(false);
    expect(key(engine, 'ArrowLeft', { key: 'ArrowLeft' })).toBe(false);
  });
});

describe('选中框', () => {
  it('沿每个选中节点的真实外框绘制，线宽按缩放换算；选中节点移动时跟随，清空选区即清除', () => {
    const { engine, store, overlay } = setup();
    store.updateNode('frame', { rotation: 90 }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'c'] });
    let outline = overlay.get('selection:outline')!;
    expect(outline.transient).toBe(false);
    expect(outline.primitives).toHaveLength(2);
    expect(outline.primitives[0]).toMatchObject({
      kind: 'polygon',
      points: [0, 0, 160, 0, 160, 100, 0, 100],
      strokeWidth: 1.5
    });
    // c 随旋转 90° 的容器旋转：局部 (0,0) 落在世界 (400 - 20 - ... ) 处，四角不再轴对齐
    const cPoints = (outline.primitives[1] as { points: number[] }).points;
    expect(cPoints[0]).not.toBe(cPoints[6]);

    engine.session.setViewport({ zoom: 2 });
    expect((overlay.get('selection:outline')!.primitives[0] as { strokeWidth: number }).strokeWidth).toBe(0.75);

    store.moveEntities({ nodeIds: ['a'] }, { x: 10 });
    outline = overlay.get('selection:outline')!;
    expect((outline.primitives[0] as { points: number[] }).points[0]).toBe(10);

    engine.session.setSelection({ nodeIds: [] });
    expect(overlay.has('selection:outline')).toBe(false);
  });

  it('卸载插件时清除它绘制的覆盖层', () => {
    const { engine, overlay } = setup();
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(overlay.has('selection:outline')).toBe(true);
    engine.plugins.remove('@skynote/plugins-basic/selection-outline');
    expect(overlay.has('selection:outline')).toBe(false);
    expect(engine.plugins.get(SELECTION_PLUGIN_ID)).toBeDefined();
  });

  it('编辑中的自适应文本在输入法组合态下，选中外框跟随组合排版尺寸动态伸缩 (防止内容溢出)', () => {
    const { engine, overlay } = setup();
    engine.documentStore.setFontMeasurer({ measureWidth: (text, font) => [...text].length * font.size * 0.5 });
    engine.documentStore.createNode({ nodeType: 'free-text', id: 't', x: 0, y: 0, options: { text: '文本' } });

    engine.session.setSelection({ nodeIds: ['t'] });
    let outline = overlay.get('selection:outline')!;
    const initialPoints = (outline.primitives[0] as { points: number[] }).points;
    const initialWidth = initialPoints[2] - initialPoints[0];

    // 模拟正在输入法中输入拼音：会话中设置 composition
    engine.session.setTextEditing({
      kind: 'node',
      id: 't',
      blockId: 'body',
      scrollY: 0,
      composition: { offset: 1, text: "s's'd'd's", style: {} }
    });

    outline = overlay.get('selection:outline')!;
    const composingPoints = (outline.primitives[0] as { points: number[] }).points;
    const composingWidth = composingPoints[2] - composingPoints[0];

    // 包含拼音后的外框宽度必须明显大于初始宽度，杜绝内容溢出
    expect(composingWidth).toBeGreaterThan(initialWidth);

    // 退出编辑后，外框重置回实体尺寸
    engine.session.setTextEditing(null);
    outline = overlay.get('selection:outline')!;
    const finalPoints = (outline.primitives[0] as { points: number[] }).points;
    expect(finalPoints[2] - finalPoints[0]).toBe(initialWidth);
  });

  it('画框外部标题保留交互可点选，但悬停高亮框仅贴合画框本体形状 (不包含外部标题)', () => {
    const { engine, overlay } = setup();
    // 创建一个位于 (100, 100)，尺寸 480x320 的画框
    engine.documentStore.createNode({
      nodeType: 'frame',
      id: 'f1',
      x: 100,
      y: 100,
      width: 480,
      height: 320,
      options: { title: '测试画框' }
    });

    // 1. 鼠标悬停在画框头顶外的标题区域 (y=90 在标题带 100 - TITLE_BAND 内)
    pointer(engine, 'move', { x: 150, y: 90 });
    expect(overlay.has('selection:hover')).toBe(true);

    const hoverPrimitives = overlay.get('selection:hover')!.primitives;
    expect(hoverPrimitives).toHaveLength(1);
    const hoverPoints = (hoverPrimitives[0] as { points: number[] }).points;
    // 悬停框的顶部世界坐标严格贴合画框顶部 y=100，绝不包含上方的标题带 (不突起到负值/上方)
    const minY = Math.min(hoverPoints[1], hoverPoints[3], hoverPoints[5], hoverPoints[7]);
    expect(minY).toBe(100);

    // 2. 点击外部标题区域，画框依然能够被成功选中并触发交互
    click(engine, { x: 150, y: 90 });
    expect(engine.session.selectedNodeIds.has('f1')).toBe(true);
  });
});

/** 单击选中 (视口为单位矩阵时屏幕坐标即世界坐标) */
function click(engine: Engine, point: Point, init: Partial<{ shift: boolean }> = {}) {
  pointer(engine, 'down', point, init);
  pointer(engine, 'up', point, init);
}

/** 从 from 拖到 to (逐帧提交，同一 groupId) */
function drag(engine: Engine, from: Point, to: Point, init: Partial<{ shift: boolean; alt: boolean }> = {}) {
  pointer(engine, 'down', from, init);
  pointer(engine, 'move', to, init);
  pointer(engine, 'up', to, init);
}

describe('缩放控制柄', () => {
  it('拖右下角缩放，对角固定；一次拖拽一步撤销', () => {
    const { engine, store } = setup();
    click(engine, { x: 10, y: 10 });
    drag(engine, { x: 160, y: 100 }, { x: 200, y: 120 });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0, width: 200, height: 120 });
    store.undo();
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0, width: 160, height: 100 });
  });

  it('resize 为 width 的节点类型：只在左右边中点画竖条控制柄 (没有角)，拖右边与 Shift 都只改宽度；height 反之', () => {
    const { engine, store, overlay } = setup();
    /** 各控制柄图形的外接框 (中心与宽高) */
    const handleBoxes = () =>
      overlay.get('transform:handles')!.primitives.map((primitive) => {
        const points = (primitive as { points: number[] }).points;
        const xs = points.filter((_, i) => i % 2 === 0);
        const ys = points.filter((_, i) => i % 2 === 1);
        const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        return { x: (left + right) / 2, y: (top + bottom) / 2, tall: bottom - top > right - left };
      });
    engine.nodeTypes.register({ type: 'test:bar', label: '条', defaultData: {}, resize: 'width' });
    store.updateNode('a', { nodeType: 'test:bar' });
    click(engine, { x: 10, y: 10 });
    expect(handleBoxes()).toEqual([
      { x: 160, y: 50, tall: true },
      { x: 0, y: 50, tall: true }
    ]);
    // 下边不是控制柄：按住下边拖动只是移动节点
    drag(engine, { x: 80, y: 100 }, { x: 80, y: 160 });
    expect(store.getNode('a')).toMatchObject({ y: 60, width: 160, height: 100 });
    store.undo();
    drag(engine, { x: 160, y: 100 }, { x: 200, y: 160 }, { shift: true });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });

    engine.nodeTypes.register({ type: 'test:column', label: '柱', defaultData: {}, resize: 'height' });
    store.updateNode('a', { nodeType: 'test:column' });
    click(engine, { x: 10, y: 10 });
    expect(handleBoxes().map(({ y, tall }) => ({ y, tall }))).toEqual([
      { y: 0, tall: false },
      { y: 100, tall: false }
    ]);
    drag(engine, { x: 100, y: 100 }, { x: 160, y: 140 });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0, width: 200, height: 140 });
  });

  it('Shift 等比 (取变化更大的一轴)，Alt 以中心为基准', () => {
    const { engine, store } = setup();
    click(engine, { x: 10, y: 10 });
    drag(engine, { x: 160, y: 100 }, { x: 240, y: 110 }, { shift: true });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0, width: 240, height: 150 });

    // 右边中点向右 20，Alt 时左边同步外扩 20
    drag(engine, { x: 240, y: 75 }, { x: 260, y: 75 }, { alt: true });
    expect(store.getNode('a')).toMatchObject({ x: -20, y: 0, width: 280, height: 150 });
  });

  it('悬停控制柄时的缩放光标精确对准控制柄方向，随节点旋转 (不再只有四个方向)', () => {
    const { engine, store, cursors } = setup();
    store.updateNode('a', { rotation: 30 }, { undoable: false });
    click(engine, { x: 80, y: 50 });
    // 本地右边中点 (160, 50) 绕中心 (80, 50) 转 30° 后位于世界 (80 + 80cos30°, 50 + 80sin30°)
    pointer(engine, 'move', { x: 80 + 80 * Math.cos(Math.PI / 6), y: 50 + 80 * Math.sin(Math.PI / 6) });
    expect(cursors.at(-1)).toEqual({ kind: 'resize', angle: expect.closeTo(30) });
  });

  it('旋转后的节点沿自身坐标轴缩放，对角在世界中保持不动', () => {
    const { engine, store } = setup();
    store.updateNode('a', { rotation: 90 }, { undoable: false });
    click(engine, { x: 80, y: 50 });
    // 旋转 90° 后本地右下角 (160, 100) 位于世界 (30, 130)，本地左上角位于世界 (130, -30)
    const fixedBefore = applyMatrix(engine.entityStore.getWorldTransform('a')!, 0, 0);
    drag(engine, { x: 30, y: 130 }, { x: 10, y: 170 });
    const node = store.getNode('a')!;
    expect(node.width).toBeCloseTo(200);
    expect(node.height).toBeCloseTo(120);
    const fixedAfter = applyMatrix(engine.entityStore.getWorldTransform('a')!, 0, 0);
    expect(fixedAfter.x).toBeCloseTo(fixedBefore.x);
    expect(fixedAfter.y).toBeCloseTo(fixedBefore.y);
  });

  it('多选含旋转节点时整体强制等比，各节点宽高比不变', () => {
    const { engine, store } = setup();
    store.updateNode('b', { rotation: 30 }, { undoable: false });
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    const before = engine.getNodeWorldBounds('b')!;
    // 整体外框右边中点向右拖：只拖一轴也按等比缩放
    const right = before.right;
    const midY = (Math.min(0, before.top) + Math.max(100, before.bottom)) / 2;
    drag(engine, { x: right, y: midY }, { x: right + 100, y: midY });
    const a = store.getNode('a')!;
    const b = store.getNode('b')!;
    expect(a.width / a.height).toBeCloseTo(1.6);
    expect(b.width / b.height).toBeCloseTo(1.6);
    expect(b.rotation).toBeCloseTo(30);
    expect(a.width).toBeGreaterThan(160);
  });

  it('锁定比例的节点 (便签默认锁定) 拖边也等比，另一轴以中心为基准；Shift+L 解锁后自由缩放，再按一次恢复锁定', () => {
    const { engine, store } = setup();
    store.createNode({ nodeType: 'sticky', id: 's', x: 600, y: 500 });
    click(engine, { x: 700, y: 600 });

    // 右边向右 50：宽高都变为 250，竖直方向以中心为基准 (上下各扩 25)
    drag(engine, { x: 800, y: 600 }, { x: 850, y: 600 });
    expect(store.getNode('s')).toMatchObject({ x: 600, y: 475, width: 250, height: 250 });

    key(engine, 'KeyL', { key: 'L', shiftKey: true });
    expect(store.getNode('s')!.aspectLocked).toBe(false);
    drag(engine, { x: 850, y: 600 }, { x: 900, y: 600 });
    expect(store.getNode('s')).toMatchObject({ x: 600, y: 475, width: 300, height: 250 });

    key(engine, 'KeyL', { key: 'L', shiftKey: true });
    expect(store.getNode('s')!.aspectLocked).toBe(true);
    // 锁定后按当前比例 (6:5) 等比
    drag(engine, { x: 900, y: 600 }, { x: 960, y: 600 });
    const node = store.getNode('s')!;
    expect(node.width).toBeCloseTo(360);
    expect(node.height).toBeCloseTo(300);
  });

  it('形状默认不锁定比例：锁定后同样只能等比', () => {
    const { engine, store } = setup();
    click(engine, { x: 10, y: 10 });
    key(engine, 'KeyL', { key: 'L', shiftKey: true });
    drag(engine, { x: 160, y: 50 }, { x: 240, y: 50 });
    expect(store.getNode('a')).toMatchObject({ width: 240, height: 150 });
    store.undo();
    store.undo();
    expect(store.getNode('a')).toMatchObject({ width: 160, height: 100 });
    expect(store.getNode('a')!.aspectLocked).toBeUndefined();
  });
});

describe('自由文本缩放', () => {
  function setupText() {
    const context = setup();
    context.store.createNode({ nodeType: 'free-text', id: 't', x: 600, y: 300, options: { text: 'hello' } });
    context.store.updateNode('t', { width: 100, height: 30 }, { undoable: false });
    click(context.engine, { x: 650, y: 315 });
    const body = () => context.store.getNode('t')!.textBlocks![0];
    return { ...context, body };
  }

  it('拖左右边变为固定宽度，拖上下边变为固定尺寸；双击边不改变尺寸状态 (适应内容只经工具栏)', () => {
    const { engine, body } = setupText();
    drag(engine, { x: 700, y: 315 }, { x: 740, y: 315 });
    expect(body()).toMatchObject({ sizing: 'auto-height', explicitWidth: 140 });

    drag(engine, { x: 670, y: 330 }, { x: 670, y: 360 });
    expect(body()).toMatchObject({ sizing: 'fixed', explicitWidth: 140, explicitHeight: 60 });

    click(engine, { x: 670, y: 360 });
    click(engine, { x: 670, y: 360 });
    expect(body()).toMatchObject({ sizing: 'fixed', explicitWidth: 140, explicitHeight: 60 });
  });

  it('拖四角等比缩放字号，尺寸状态不变；多帧拖动以开始时为基准，不逐帧叠加', () => {
    const { engine, body } = setupText();
    pointer(engine, 'down', { x: 700, y: 330 });
    pointer(engine, 'move', { x: 720, y: 336 });
    pointer(engine, 'move', { x: 740, y: 342 });
    pointer(engine, 'move', { x: 750, y: 345 });
    pointer(engine, 'up', { x: 750, y: 345 });
    expect(body().style?.fontSize).toBeCloseTo(27);
    expect(body().sizing).toBeUndefined();
  });
});

describe('旋转', () => {
  it('布局成员没有旋转热区 (朝向由布局决定)；布局的根照常可旋转', () => {
    const { engine, store, cursors } = setup();
    engine.layouts.register({ id: 'test:keep', label: '保持', arrange: () => new Map() });
    // frame (0,400 400×300) 为布局根，c (世界 20,420 160×100) 为成员
    store.updateNode('frame', { layout: { type: 'test:keep' } });
    store.updateNode('c', { layoutItem: {} });
    const isRotateCursor = () =>
      typeof cursors.at(-1) === 'object' && (cursors.at(-1) as { kind: string }).kind === 'rotate';

    click(engine, { x: 100, y: 470 });
    expect([...engine.session.selectedNodeIds]).toEqual(['c']);
    pointer(engine, 'move', { x: 192, y: 532 });
    expect(isRotateCursor()).toBe(false);

    click(engine, { x: 300, y: 650 });
    expect([...engine.session.selectedNodeIds]).toEqual(['frame']);
    pointer(engine, 'move', { x: 412, y: 712 });
    expect(isRotateCursor()).toBe(true);
  });

  it('从角外热区拖动绕中心旋转，Shift 按 15° 吸附', () => {
    const { engine, store } = setup();
    click(engine, { x: 10, y: 10 });
    // 中心 (80, 50)；角外 (170, 110) 绕中心转 90° 到 (20, 140)
    drag(engine, { x: 170, y: 110 }, { x: 20, y: 140 });
    expect(store.getNode('a')!.rotation).toBeCloseTo(90);
    expect(engine.getNodeWorldBounds('a')!.left).toBeCloseTo(30);

    store.undo();
    // 转约 47° 时吸附到 45°
    const target = {
      x: 80 + Math.cos(Math.atan2(60, 90) + (47 * Math.PI) / 180) * Math.hypot(90, 60),
      y: 50 + Math.sin(Math.atan2(60, 90) + (47 * Math.PI) / 180) * Math.hypot(90, 60)
    };
    drag(engine, { x: 170, y: 110 }, target, { shift: true });
    expect(store.getNode('a')!.rotation).toBeCloseTo(45);
  });
});

describe('精确拾取与悬停高亮', () => {
  it('椭圆外框的空角不会选中；悬停时沿真实轮廓高亮，已选中的节点不高亮', () => {
    const { engine, store, overlay } = setup();
    store.createNode({ nodeType: 'shape', id: 'e', x: 600, y: 0, options: { geometry: 'ellipse' } });
    expect(engine.hitTestNode({ x: 603, y: 3 })).toBeUndefined();
    expect(engine.hitTestNode({ x: 680, y: 50 })?.id).toBe('e');

    pointer(engine, 'move', { x: 680, y: 50 });
    const hover = overlay.get('selection:hover')!.primitives[0] as { points: number[] };
    expect(hover.points.length).toBe(64 * 2);

    click(engine, { x: 680, y: 50 });
    pointer(engine, 'move', { x: 681, y: 50 });
    expect(overlay.has('selection:hover')).toBe(false);
  });
});

describe('失焦复位', () => {
  it('按住空格时窗口失焦，回来后左键不再平移画布', () => {
    const { engine } = setup();
    key(engine, 'Space', { key: ' ' });
    engine.inputScopes.dispatchBlur();
    const before = { ...engine.session.viewport };
    drag(engine, { x: 700, y: 300 }, { x: 750, y: 350 });
    expect(engine.session.viewport).toEqual(before);
  });
});
