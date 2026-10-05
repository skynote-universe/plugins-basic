/**
 * @file clipboard.test.ts
 * @description 画布剪贴板：多格式写入、粘贴位置 (原位偏移 / 视口中央)、剪切回原位、外部纯文本、非法数据
 */

import { describe, it, expect } from 'vitest';
import { NODE_CLIPBOARD_MIME, SkyNoteEngine, SyntheticPointerEvent, type Point } from '@skynote/core';
import { BasicNodesPlugin, ClipboardPlugin } from '../src';

const fonts = { measureWidth: (text: string, font: { size: number }) => [...text].length * font.size * 0.5 };

function setup() {
  const engine = new SkyNoteEngine({ fonts }).use(new BasicNodesPlugin()).use(new ClipboardPlugin());
  engine.session.setViewportSize({ width: 1000, height: 800 });
  const store = engine.documentStore;
  store.createNode({ nodeType: 'sticky', id: 's', x: 100, y: 100, options: { text: '便签文字' } });
  store.createNode({ nodeType: 'shape', id: 'r', x: 400, y: 100, options: { label: '矩形' } });
  return { engine, store };
}

const left = (engine: SkyNoteEngine, id: string) => engine.getNodeWorldBounds(id)!.left;
const selected = (engine: SkyNoteEngine) => [...engine.session.selectedNodeIds];

describe('画布剪贴板', () => {
  it('复制写入画布节点数据与文字；连续粘贴在原位依次偏移，并选中粘贴出的节点', () => {
    const { engine } = setup();
    engine.session.setSelection({ nodeIds: ['s', 'r'] });
    const data = engine.clipboard.copy()!;
    expect(data['text/plain']).toBe('便签文字\n矩形');
    expect(JSON.parse(data[NODE_CLIPBOARD_MIME]).nodes).toHaveLength(2);

    expect(engine.clipboard.paste(data)).toBe(true);
    const first = selected(engine);
    expect(first).toHaveLength(2);
    const firstSticky = first.find((id) => engine.documentStore.getNode(id)!.nodeType === 'sticky')!;
    expect(left(engine, firstSticky)).toBe(120);

    engine.clipboard.paste(data);
    const secondSticky = selected(engine).find((id) => engine.documentStore.getNode(id)!.nodeType === 'sticky')!;
    expect(left(engine, secondSticky)).toBe(140);
  });

  it('剪切删除节点，第一次粘贴回到原位；原内容不在视口内时粘贴到视口中央', () => {
    const { engine, store } = setup();
    engine.session.setSelection({ nodeIds: ['s'] });
    const data = engine.clipboard.cut()!;
    expect(store.getNode('s')).toBeUndefined();
    engine.clipboard.paste(data);
    expect(left(engine, selected(engine)[0])).toBe(100);

    // 平移视口，原位置移出可见范围
    engine.session.setViewport({ x: -5000, y: -5000 });
    engine.clipboard.paste(data);
    const bounds = engine.getNodeWorldBounds(selected(engine)[0])!;
    const center = engine.session.viewportCenter;
    expect((bounds.left + bounds.right) / 2).toBeCloseTo(center.x);
    expect((bounds.top + bounds.bottom) / 2).toBeCloseTo(center.y);
  });

  it('没有选中节点时不处理复制；外部纯文本粘贴为自由文本；不合法的节点数据按纯文本处理', () => {
    const { engine, store } = setup();
    engine.session.setSelection({ nodeIds: [] });
    expect(engine.clipboard.copy()).toBeNull();

    expect(engine.clipboard.paste({ 'text/plain': '  来自外部  ' })).toBe(true);
    const text = store.getNode(selected(engine)[0])!;
    expect(text.nodeType).toBe('free-text');
    expect(text.textBlocks![0].runs[0].text).toBe('来自外部');

    const forged = JSON.stringify({
      kind: 'skynote/nodes',
      version: 1,
      nodes: [{ id: 'x', type: 'node' }],
      connectors: []
    });
    expect(engine.clipboard.paste({ [NODE_CLIPBOARD_MIME]: forged, 'text/plain': '回退文字' })).toBe(true);
    expect(store.getNode(selected(engine)[0])!.textBlocks![0].runs[0].text).toBe('回退文字');
    expect(engine.clipboard.paste({})).toBe(false);
  });

  it('看鼠标有没有移动：没动时原位偏移，移到别处时以鼠标为中心，原地连续粘贴继续错开；离开画布后按原位规则', () => {
    const { engine } = setup();
    const move = (point: Point) => engine.pointer.dispatchPointerMove(new SyntheticPointerEvent({ point }));
    const centerOf = (id: string) => {
      const b = engine.getNodeWorldBounds(id)!;
      return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
    };
    // 便签默认 200 × 200，原位置中心 (200, 200)
    move({ x: 200, y: 200 });
    engine.session.setSelection({ nodeIds: ['s'] });
    const data = engine.clipboard.copy()!;
    move({ x: 202, y: 201 });
    engine.clipboard.paste(data);
    expect(centerOf(selected(engine)[0])).toEqual({ x: 220, y: 220 });

    move({ x: 600, y: 500 });
    engine.clipboard.paste(data);
    expect(centerOf(selected(engine)[0])).toEqual({ x: 600, y: 500 });
    engine.clipboard.paste(data);
    expect(centerOf(selected(engine)[0])).toEqual({ x: 620, y: 520 });

    // 鼠标移到工具栏上 (离开画布)：重新复制后按原位规则
    engine.pointer.dispatchPointerLeave(new SyntheticPointerEvent({ point: { x: 600, y: 500 } }));
    engine.session.setSelection({ nodeIds: ['s'] });
    const again = engine.clipboard.copy()!;
    engine.clipboard.paste(again);
    expect(centerOf(selected(engine)[0])).toEqual({ x: 220, y: 220 });
  });
});
