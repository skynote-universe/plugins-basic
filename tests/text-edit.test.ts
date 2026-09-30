/**
 * @file text-edit.test.ts
 * @description 画布内文字编辑：双击进入、键入与删除、光标移动与选区、格式、输入法组合、剪贴板与一步撤销
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  SyntheticWheelEvent,
  type CanvasHost,
  type CanvasKeyboardEvent,
  type CanvasPrimitive,
  type FontMeasurer,
  type NodeEntity,
  type OverlayChannel,
  type Point,
  type TextInputHandler,
  type TextInputSession
} from '@skynote/core';
import {
  BasicNodesPlugin,
  EditingShortcutsPlugin,
  SelectionPlugin,
  TEXT_EDIT_PLUGIN_ID,
  TextEditPlugin,
  TransformPlugin,
  ViewportNavigationPlugin
} from '../src';

/** 每个码点宽 = 字号 × 0.5：自由文本 18px 每字宽 9，行高 25.2 */
const fonts: FontMeasurer = { measureWidth: (text, font) => [...text].length * font.size * 0.5 };

class FakeHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, readonly CanvasPrimitive[]>();
  handler: TextInputHandler | null = null;
  inputOpen = false;

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
  openTextInput(handler: TextInputHandler): TextInputSession {
    this.handler = handler;
    this.inputOpen = true;
    return {
      setCaretRect: () => {},
      focus: () => {},
      close: () => {
        this.inputOpen = false;
      }
    };
  }
}

function setup() {
  const engine = new SkyNoteEngine({ fonts })
    .use(new BasicNodesPlugin())
    .use(new ViewportNavigationPlugin())
    .use(new SelectionPlugin())
    .use(new EditingShortcutsPlugin())
    .use(new TransformPlugin())
    .use(new TextEditPlugin());
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1000, height: 800 });
  const store = engine.documentStore;
  store.createNode({ nodeType: 'free-text', id: 't', x: 100, y: 100, options: { text: 'hello world' } });
  store.clearHistory();
  const plugin = engine.plugins.get(TEXT_EDIT_PLUGIN_ID) as TextEditPlugin;
  const text = () =>
    store
      .getNode('t')!
      .textBlocks![0].runs.map((run) => run.text)
      .join('');
  const runs = () => store.getNode('t')!.textBlocks![0].runs;
  return { engine, host, store, plugin, text, runs };
}

type Context = ReturnType<typeof setup>;

function press(engine: SkyNoteEngine, point: Point, clickCount = 1, shift = false): void {
  const init = { point, clickCount, modifiers: { shift }, target: engine.hitTestNode(point) as NodeEntity | undefined };
  engine.pointer.dispatchPointerDown(new SyntheticPointerEvent(init));
  engine.pointer.dispatchPointerUp(new SyntheticPointerEvent(init));
}

/** 文字第 index 个字符前的世界坐标 (第一行) */
const at = (index: number): Point => ({ x: 100 + index * 9 + 1, y: 110 });

function key(engine: SkyNoteEngine, keyName: string, init: Partial<CanvasKeyboardEvent> = {}): boolean {
  let prevented = false;
  engine.inputScopes.dispatchKeyDown({
    key: keyName,
    code: keyName,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
    ...init
  });
  return prevented;
}

/** 双击第 index 个字符前进入编辑 */
function enterAt({ engine }: Context, index: number): void {
  press(engine, at(index));
  press(engine, at(index), 2);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('进入与退出', () => {
  it('双击进入编辑：光标落在点击处，控制柄隐藏；Esc 退出后保留选中，整个编辑过程一步撤销', () => {
    const context = setup();
    const { engine, host, store, text } = context;
    enterAt(context, 2);
    expect(engine.session.textEditing).toMatchObject({ nodeId: 't', blockId: 'body', scrollY: 0, composition: null });
    expect(host.inputOpen).toBe(true);
    expect(host.sessions.has('transform:handles')).toBe(false);
    expect(host.sessions.get('text-edit')?.some((p) => p.kind === 'line')).toBe(true);

    host.handler!.insertText('X');
    host.handler!.insertText('Y');
    expect(text()).toBe('heXYllo world');
    // 外框随文字伸缩 (同一事务内派生)
    expect(store.getNode('t')!.width).toBe(13 * 9);

    key(engine, 'Escape');
    expect(engine.session.textEditing).toBeNull();
    expect([...engine.session.selectedNodeIds]).toEqual(['t']);
    expect(host.inputOpen).toBe(false);
    expect(host.sessions.has('text-edit')).toBe(false);
    expect(host.sessions.has('transform:handles')).toBe(true);

    store.undo();
    expect(text()).toBe('hello world');
  });

  it('编辑中按 Ctrl+Z 先退出编辑再整体撤销；点在节点外退出编辑', () => {
    const context = setup();
    const { engine, host, text } = context;
    enterAt(context, 0);
    host.handler!.insertText('A');
    key(engine, 'z', { ctrlKey: true });
    expect(engine.session.textEditing).toBeNull();
    expect(text()).toBe('hello world');

    enterAt(context, 0);
    press(engine, { x: 600, y: 600 });
    expect(engine.session.textEditing).toBeNull();
  });
});

describe('删空即删除', () => {
  it('自由文本删空后退出编辑即删除节点，撤销一步恢复节点与原文字；便签删空保留', () => {
    const context = setup();
    const { engine, host, store } = context;
    enterAt(context, 0);
    key(engine, 'a', { ctrlKey: true });
    host.handler!.insertText('');
    key(engine, 'Escape');
    expect(store.getNode('t')).toBeUndefined();
    expect(engine.session.selectedNodeIds.size).toBe(0);
    store.undo();
    expect(context.text()).toBe('hello world');

    store.createNode({ nodeType: 'sticky', id: 's', x: 400, y: 100, options: { text: 'x' } });
    press(engine, { x: 500, y: 200 });
    press(engine, { x: 500, y: 200 }, 2);
    key(engine, 'a', { ctrlKey: true });
    host.handler!.insertText('');
    key(engine, 'Escape');
    expect(store.getNode('s')).toBeDefined();
  });
});

describe('键盘编辑', () => {
  it('编辑时 Delete / 退格只删文字不删节点；方向键移动，Shift 扩展选区，Ctrl 按词', () => {
    const context = setup();
    const { engine, host, store, text } = context;
    enterAt(context, 5);
    expect(key(engine, 'Backspace')).toBe(true);
    expect(text()).toBe('hell world');
    key(engine, 'Delete');
    expect(text()).toBe('hellworld');
    expect(store.getNode('t')).toBeDefined();

    key(engine, 'ArrowLeft');
    key(engine, 'ArrowLeft', { shiftKey: true });
    key(engine, 'ArrowLeft', { shiftKey: true });
    expect(host.handler!.copySelection()!.text).toBe('el');
    // 有选区时方向键先折叠到选区一端，再按词跳到词尾
    key(engine, 'ArrowRight', { ctrlKey: true });
    key(engine, 'ArrowRight', { ctrlKey: true });
    key(engine, 'Backspace', { ctrlKey: true });
    expect(text()).toBe('');

    // 字符键不阻止默认行为 (交给输入通道产生文字)，但不下传给画布快捷键
    expect(key(engine, 'a')).toBe(false);
  });

  it('Ctrl+A 全选后键入替换全部；剪切返回选中文字并删除', () => {
    const context = setup();
    const { engine, host, text } = context;
    enterAt(context, 0);
    key(engine, 'a', { ctrlKey: true });
    expect(host.handler!.cutSelection()!.text).toBe('hello world');
    expect(text()).toBe('');
    host.handler!.insertText('new\ntext');
    expect(text()).toBe('new\ntext');
    // 上下移动保持水平位置
    key(engine, 'ArrowUp');
    key(engine, 'ArrowRight', { shiftKey: true });
    expect(host.handler!.copySelection()!.text).toBe('\n');
  });
});

describe('选区与格式', () => {
  it('编辑中双击选词、三击选段落；Ctrl+B 为选区加粗，再按取消', () => {
    const context = setup();
    const { engine, plugin, runs } = context;
    enterAt(context, 0);
    press(engine, at(7), 2);
    expect(plugin.snapshot).toMatchObject({ start: 6, end: 11 });
    key(engine, 'b', { ctrlKey: true });
    expect(runs()).toEqual([{ text: 'hello ' }, { text: 'world', fontWeight: 'bold' }]);
    expect(plugin.formatState!.style.fontWeight).toBe('bold');
    key(engine, 'b', { ctrlKey: true });
    // 块样式不加粗：取消加粗即回到块样式，分段合并
    expect(runs()).toEqual([{ text: 'hello world' }]);

    press(engine, at(1), 3);
    expect(plugin.snapshot).toMatchObject({ start: 0, end: 11 });
  });

  it('空选区切换格式作用于接下来输入的文字；下划线与删除线互不影响', () => {
    const context = setup();
    const { engine, host, runs } = context;
    enterAt(context, 5);
    key(engine, 'i', { ctrlKey: true });
    host.handler!.insertText('!');
    expect(runs()).toEqual([{ text: 'hello' }, { text: '!', fontStyle: 'italic' }, { text: ' world' }]);

    key(engine, 'a', { ctrlKey: true });
    key(engine, 'u', { ctrlKey: true });
    key(engine, 'x', { ctrlKey: true, shiftKey: true });
    expect(runs().every((run) => JSON.stringify(run.textDecoration) === '["underline","line-through"]')).toBe(true);
  });
});

describe('输入法组合', () => {
  it('组合文字只在本地显示 (会话中带下划线插入排版)，确认后才写入文档；替换选区；整个过程一步撤销', () => {
    const context = setup();
    const { engine, host, store, text } = context;
    enterAt(context, 0);
    key(engine, 'ArrowRight', { shiftKey: true });
    const handler = host.handler!;
    handler.compositionStart();
    expect(text()).toBe('ello world');
    handler.compositionUpdate('n');
    handler.compositionUpdate('ni');
    // 文档不含拼音，组合文字在会话的编辑视图里
    expect(text()).toBe('ello world');
    expect(engine.session.textEditing!.composition).toMatchObject({ offset: 0, text: 'ni' });
    handler.compositionEnd('你');
    expect(text()).toBe('你ello world');
    expect(engine.session.textEditing!.composition).toBeNull();

    // 取消组合：什么也不写
    handler.compositionStart();
    handler.compositionUpdate('x');
    handler.compositionEnd('');
    expect(text()).toBe('你ello world');

    key(engine, 'Escape');
    store.undo();
    expect(text()).toBe('hello world');
  });
});

describe('溢出滚动', () => {
  /** 便签 200 × 200、内边距 16：文本框 168 × 168，16px × 1.4 行高 22.4，每行 (168 / 8) = 21 字 */
  function setupSticky(lines: number) {
    const context = setup();
    context.store.createNode({
      nodeType: 'sticky',
      id: 's',
      x: 400,
      y: 100,
      options: { text: Array.from({ length: lines }, (_, i) => `line${i}`).join('\n') }
    });
    press(context.engine, { x: 500, y: 200 });
    press(context.engine, { x: 500, y: 200 }, 2);
    return context;
  }

  it('光标移到文本框外时自动滚动到可见；滚轮在文本框内滚动文字且不平移画布，滚动有上下限', () => {
    const { engine } = setupSticky(20);
    const scroll = () => engine.session.textEditing!.scrollY;
    // 20 行 × 22.4 = 448，超出 168 的部分可滚动
    key(engine, 'End', { ctrlKey: true });
    expect(scroll()).toBeCloseTo(448 - 168);
    key(engine, 'Home', { ctrlKey: true });
    expect(scroll()).toBe(0);

    const viewport = { ...engine.session.viewport };
    engine.pointer.dispatchWheel(
      new SyntheticWheelEvent({ centerPoint: { x: 500, y: 200 }, deltaPan: { x: 0, y: -50 }, deltaZoom: 0 })
    );
    expect(scroll()).toBe(50);
    expect(engine.session.viewport).toEqual(viewport);
    engine.pointer.dispatchWheel(
      new SyntheticWheelEvent({ centerPoint: { x: 500, y: 200 }, deltaPan: { x: 0, y: -9999 }, deltaZoom: 0 })
    );
    expect(scroll()).toBeCloseTo(448 - 168);
  });

  it('文字放得下时不滚动，滚轮照常平移画布', () => {
    const { engine } = setupSticky(2);
    const before = engine.session.viewport.y;
    engine.pointer.dispatchWheel(
      new SyntheticWheelEvent({ centerPoint: { x: 500, y: 200 }, deltaPan: { x: 0, y: -50 }, deltaZoom: 0 })
    );
    expect(engine.session.textEditing!.scrollY).toBe(0);
    expect(engine.session.viewport.y).not.toBe(before);
  });
});

describe('剪贴板', () => {
  it('复制带出富文本分段，粘贴保留样式；外部纯文本按光标处样式插入；非法分段退回纯文本', () => {
    const context = setup();
    const { engine, host, runs } = context;
    enterAt(context, 0);
    key(engine, 'ArrowRight', { shiftKey: true });
    key(engine, 'b', { ctrlKey: true });
    const copied = host.handler!.copySelection()!;
    expect(copied.text).toBe('h');
    key(engine, 'End');
    host.handler!.paste(copied);
    expect(runs().at(-1)).toEqual({ text: 'h', fontWeight: 'bold' });

    // 富文本分段按白名单校验：非法取值 (fontSize) 与原型链键丢弃，粘贴的文字保留其自身样式 (无样式)
    host.handler!.paste({ text: '!', richText: '[{"text":"x","__proto__":{"polluted":true},"fontSize":"big"}]' });
    expect(runs().slice(-2)).toEqual([{ text: 'h', fontWeight: 'bold' }, { text: 'x' }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    host.handler!.paste({ text: '!', richText: 'not json' });
    expect(context.text()).toBe('hello worldhx!');
    expect(host.handler!.copySelection()).toBeNull();
  });
});

describe('段落对齐与格式目标', () => {
  it('段落对齐作用于选区覆盖的段落；清除格式保留对齐', () => {
    const context = setup();
    const { engine, host, plugin, runs } = context;
    enterAt(context, 0);
    key(engine, 'a', { ctrlKey: true });
    host.handler!.insertText('ab\ncd');
    key(engine, 'ArrowUp');
    plugin.setAlign('center');
    expect(runs()).toEqual([{ text: 'ab\n', textAlign: 'center' }, { text: 'cd' }]);
    expect(plugin.formatState!.align).toBe('center');

    key(engine, 'a', { ctrlKey: true });
    key(engine, 'b', { ctrlKey: true });
    plugin.clearFormat();
    expect(runs()).toEqual([{ text: 'ab\n', textAlign: 'center' }, { text: 'cd' }]);
  });

  it('垂直对齐写入文字块样式，只作用于有固定高度的文字块 (自由文本高度随内容，不受影响)', () => {
    const context = setup();
    const { engine, plugin, store } = context;
    store.createNode({ nodeType: 'sticky', id: 's', x: 400, y: 100, options: { text: 'x' } });
    engine.session.setSelection({ nodeIds: ['t'] });
    expect(plugin.formatState).toMatchObject({ verticalAlignable: false, verticalAlign: undefined });

    engine.session.setSelection({ nodeIds: ['t', 's'] });
    // 便签插槽缺省垂直居中
    expect(plugin.formatState).toMatchObject({ verticalAlignable: true, verticalAlign: 'middle' });
    plugin.setVerticalAlign('bottom');
    expect(store.getNode('s')!.textBlocks![0].style).toEqual({ verticalAlign: 'bottom' });
    expect(store.getNode('t')!.textBlocks![0].style).toBeUndefined();
    expect(plugin.formatState!.verticalAlign).toBe('bottom');
    store.undo();
    expect(store.getNode('s')!.textBlocks![0].style).toBeUndefined();
  });

  it('未编辑时格式作用于选中节点的整块文字，撤销一步', () => {
    const context = setup();
    const { engine, plugin, store, runs } = context;
    store.createNode({ nodeType: 'sticky', id: 's', x: 400, y: 100, options: { text: 'x' } });
    engine.session.setSelection({ nodeIds: ['t', 's'] });
    expect(plugin.formatState).toMatchObject({ editing: false });
    plugin.toggleFormat('bold');
    expect(runs()).toEqual([{ text: 'hello world', fontWeight: 'bold' }]);
    expect(store.getNode('s')!.textBlocks![0].runs).toEqual([{ text: 'x', fontWeight: 'bold' }]);
    expect(plugin.formatState!.style.fontWeight).toBe('bold');
    plugin.setAlign('right');
    expect(plugin.formatState!.align).toBe('right');
    store.undo();
    store.undo();
    expect(runs()).toEqual([{ text: 'hello world' }]);
  });
});
