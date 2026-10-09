/**
 * @file basic-nodes.test.ts
 * @description 基础节点：尺寸策略 (ADR-111)、图元输出与主题取色
 */

import { describe, it, expect } from 'vitest';
import {
  SkyNoteEngine,
  applyThemeToPrimitives,
  isAspectLocked,
  CANVAS_PALETTE,
  type CanvasPrimitive,
  type FontMeasurer,
  type TextPrimitive
} from '@skynote/core';
import { BasicNodesPlugin, STICKY_DEFAULT_SIZE, SHAPE_DEFAULT_SIZE } from '../src';

/** 确定性字体测量器：每个码点宽 = 字号 × 0.5 (行高由排版按样式计算) */
const fakeMeasurer: FontMeasurer = {
  measureWidth: (text, font) => [...text].length * font.size * 0.5
};

function createEngine(): SkyNoteEngine {
  return new SkyNoteEngine({ fonts: fakeMeasurer }).use(new BasicNodesPlugin());
}

function compose(engine: SkyNoteEngine, id: string): CanvasPrimitive[] {
  const node = engine.documentStore.getNode(id)!;
  const theme = engine.session.theme;
  return applyThemeToPrimitives(engine.nodeTypes.get(node.nodeType)!.compose!(node, { theme }), theme);
}

function setText(engine: SkyNoteEngine, id: string, text: string): void {
  engine.documentStore.commit({
    patches: [{ op: 'set', path: ['content', 'nodes', id, 'textBlocks', 0, 'runs'], value: [{ text }] }]
  });
}

describe('基础节点插件', () => {
  it('一次注册便签、自由文本与形状三种节点类型', () => {
    const engine = createEngine();
    expect(['sticky', 'free-text', 'shape'].every((type) => engine.nodeTypes.get(type))).toBe(true);
  });
});

describe('便签', () => {
  it('外框由用户决定：文字再多也不撑大便签，放不下时显示省略号；默认锁定比例', () => {
    const engine = createEngine();
    engine.documentStore.createNode({ nodeType: 'sticky', id: 's', x: 0, y: 0, options: { text: '短' } });
    expect(engine.documentStore.getNode('s')).toMatchObject({
      width: STICKY_DEFAULT_SIZE,
      height: STICKY_DEFAULT_SIZE
    });

    setText(engine, 's', '字'.repeat(300));
    expect(engine.documentStore.getNode('s')).toMatchObject({
      width: STICKY_DEFAULT_SIZE,
      height: STICKY_DEFAULT_SIZE
    });
    const [, text] = compose(engine, 's') as [CanvasPrimitive, TextPrimitive];
    expect(text).toMatchObject({ height: 168, style: { textOverflow: 'ellipsis' } });

    const node = engine.documentStore.getNode('s')!;
    expect(isAspectLocked(node, engine.nodeTypes.get('sticky'))).toBe(true);
  });

  it('适应内容：保持宽度，高度一次性调整为刚好放下文字，锁定比例不变；一步撤销；空便签无可适应', () => {
    const engine = createEngine();
    const store = engine.documentStore;
    store.createNode({ nodeType: 'sticky', id: 's', x: 0, y: 0, options: { text: '字'.repeat(300) } });
    store.createNode({ nodeType: 'sticky', id: 'empty', x: 300, y: 0 });
    expect(store.canFitContent('s')).toBe(true);
    expect(store.canFitContent('empty')).toBe(false);

    // 每行 (200 - 32) / 8 = 21 字，300 字 15 行 × 22.4 + 上下内边距 32
    store.fitContent(['s', 'empty']);
    expect(store.getNode('s')).toMatchObject({ width: 200, height: Math.ceil(15 * 22.4 + 32) });
    expect(store.getNode('empty')!.height).toBe(STICKY_DEFAULT_SIZE);
    expect(store.canFitContent('s')).toBe(false);
    expect(isAspectLocked(store.getNode('s')!, engine.nodeTypes.get('sticky'))).toBe(true);

    store.undo();
    expect(store.getNode('s')!.height).toBe(STICKY_DEFAULT_SIZE);

    // 比内边距还窄的便签放不下文字
    store.updateNode('s', { width: 20 });
    expect(store.canFitContent('s')).toBe(false);
  });

  it('底色解析为调色板颜色，文字居中并占满内边距内的区域', () => {
    const engine = createEngine();
    engine.documentStore.createNode({
      nodeType: 'sticky',
      id: 's',
      x: 0,
      y: 0,
      options: { text: 'hi', color: 'blue' }
    });
    const [background, text] = compose(engine, 's') as [CanvasPrimitive, TextPrimitive];
    expect(background).toMatchObject({ kind: 'rect', fill: CANVAS_PALETTE.blue, width: 200, height: 200 });
    expect(text).toMatchObject({
      kind: 'text',
      runs: [{ text: 'hi' }],
      x: 16,
      y: 16,
      width: 168,
      height: 168,
      style: { color: CANVAS_PALETTE.ink, textAlign: 'center', verticalAlign: 'middle' }
    });
  });
});

describe('自由文本', () => {
  it('创建时即由内容派生尺寸，改文字后外框随之伸缩 (单行不折行)', () => {
    const engine = createEngine();
    engine.documentStore.createNode({ nodeType: 'free-text', id: 't', x: 0, y: 0, options: { text: 'abcd' } });
    // 18px × 0.5 × 4 字 = 36；行高 18 × 1.4 = 25.2 → 26
    expect(engine.documentStore.getNode('t')).toMatchObject({ width: 36, height: 26 });

    setText(engine, 't', 'abcdefgh');
    expect(engine.documentStore.getNode('t')).toMatchObject({ width: 72, height: 26 });
    const [text] = compose(engine, 't') as [TextPrimitive];
    expect(text.width).toBeUndefined();
  });

  it('固定宽度 (auto-height) 时外框宽度即设定宽度，文字折行、高度向下撑开，绘制与测量同一宽度', () => {
    const engine = createEngine();
    engine.documentStore.createNode({ nodeType: 'free-text', id: 't', x: 0, y: 0, options: { text: 'a'.repeat(20) } });
    engine.documentStore.commit({
      patches: [
        { op: 'set', path: ['content', 'nodes', 't', 'textBlocks', 0, 'sizing'], value: 'auto-height' },
        { op: 'set', path: ['content', 'nodes', 't', 'textBlocks', 0, 'explicitWidth'], value: 100 }
      ]
    });
    // 20 字 × 9 = 180，按 100 折成 2 行
    expect(engine.documentStore.getNode('t')).toMatchObject({ width: 100, height: Math.ceil(2 * 25.2) });
    const [text] = compose(engine, 't') as [TextPrimitive];
    expect(text.width).toBe(100);
  });

  it('是否折行只看 sizing：残留 explicitWidth 而未设 sizing 时仍按单行测量与绘制', () => {
    const engine = createEngine();
    engine.documentStore.createNode({ nodeType: 'free-text', id: 't', x: 0, y: 0, options: { text: 'a'.repeat(20) } });
    engine.documentStore.commit({
      patches: [{ op: 'set', path: ['content', 'nodes', 't', 'textBlocks', 0, 'explicitWidth'], value: 100 }]
    });
    expect(engine.documentStore.getNode('t')).toMatchObject({ width: 180, height: 26 });
    const [text] = compose(engine, 't') as [TextPrimitive];
    expect(text.width).toBeUndefined();
  });

  it('适应内容一步回到单行自适应 (清除固定宽高)；已适应内容时不可再适应', () => {
    const engine = createEngine();
    const store = engine.documentStore;
    store.createNode({ nodeType: 'free-text', id: 't', x: 0, y: 0, options: { text: 'hello' } });
    expect(store.canFitContent('t')).toBe(false);

    const [block] = store.getNode('t')!.textBlocks!;
    store.updateNode('t', { textBlocks: [{ ...block, sizing: 'fixed', explicitWidth: 30, explicitHeight: 80 }] });
    expect(store.getNode('t')).toMatchObject({ width: 30, height: 80 });
    expect(store.canFitContent('t')).toBe(true);

    store.fitContent(['t']);
    const [fitted] = store.getNode('t')!.textBlocks!;
    expect(fitted.sizing).toBe('auto-width');
    expect(fitted.explicitWidth).toBeUndefined();
    expect(fitted.explicitHeight).toBeUndefined();
    // 'hello' 18px：宽 5 × 9，单行高 18 × 1.4
    expect(store.canFitContent('t')).toBe(false);
  });

  it('自由文本缩放保留精度：字号只保留两位小数，宽度原样写入 (像素对齐交给渲染端)', () => {
    const engine = createEngine();
    const store = engine.documentStore;
    store.createNode({ nodeType: 'free-text', id: 't', x: 0, y: 0, options: { text: 'hello' } });
    const node = store.getNode('t')!;
    const def = engine.nodeTypes.get('free-text')!;

    // 拖角缩放 1.13 倍：18px → 20.34px，不跳档到整数，避免缩放过程中文字反复折行
    const resized = def.applyResize!(node, { handle: 'se', width: 50.85, height: 28.25, scale: 1.13 });
    expect(resized.textBlocks?.[0].style?.fontSize).toBe(20.34);

    const sideResized = def.applyResize!(node, { handle: 'e', width: 145.38, height: 26, scale: 1 });
    expect(sideResized.textBlocks?.[0].explicitWidth).toBe(145.38);
  });
});

describe('形状', () => {
  it('矩形、椭圆、菱形输出对应轮廓，颜色缺省取主题，显式颜色原样保留', () => {
    const engine = createEngine();
    const theme = engine.session.theme;
    engine.documentStore.createNode({ nodeType: 'shape', id: 'r', x: 0, y: 0 });
    engine.documentStore.createNode({ nodeType: 'shape', id: 'e', x: 0, y: 0, options: { geometry: 'ellipse' } });
    engine.documentStore.createNode({ nodeType: 'shape', id: 'd', x: 0, y: 0, options: { geometry: 'diamond' } });
    engine.documentStore.updateNode('d', { style: { fill: '$green' } });

    expect(engine.documentStore.getNode('r')?.geometry).toBe('rectangle');
    expect(engine.documentStore.getNode('e')?.geometry).toBe('ellipse');
    expect(engine.documentStore.getNode('r')?.data).toBeUndefined();

    const [rect] = compose(engine, 'r');
    expect(rect).toMatchObject({ kind: 'rect', fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 2 });
    expect(compose(engine, 'e')[0]).toMatchObject({ kind: 'ellipse', cx: 80, cy: 50, rx: 80, ry: 50 });
    expect(compose(engine, 'd')[0]).toMatchObject({
      kind: 'polygon',
      points: [80, 0, 160, 50, 80, 100, 0, 50],
      fill: CANVAS_PALETTE.green
    });
  });

  it('三角形与星形：默认方形外框，顶点铺满外框，拾取轮廓与绘制一致；填充不透明度传给图元', () => {
    const engine = createEngine();
    const store = engine.documentStore;
    store.createNode({ nodeType: 'shape', id: 't', x: 0, y: 0, options: { geometry: 'triangle' } });
    store.createNode({ nodeType: 'shape', id: 's', x: 0, y: 0, options: { geometry: 'star' } });
    expect(store.getNode('t')).toMatchObject({ width: 120, height: 120 });

    expect(compose(engine, 't')[0]).toMatchObject({ kind: 'polygon', points: [60, 0, 120, 120, 0, 120] });
    const star = compose(engine, 's')[0] as CanvasPrimitive & { points: number[] };
    expect(star.points).toHaveLength(20);
    const xs = star.points.filter((_, i) => i % 2 === 0);
    const ys = star.points.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(120);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(120);
    const outline = engine.nodeTypes.get('shape')!.outline!(store.getNode('s')!);
    expect(outline.flatMap((p) => [p.x, p.y])).toEqual(star.points);

    store.updateNode('s', { style: { fillOpacity: 0.4 } });
    expect(compose(engine, 's')[0]).toMatchObject({ fillOpacity: 0.4 });
  });

  it('标签居中且超出省略，文字再长也不改变形状尺寸', () => {
    const engine = createEngine();
    engine.documentStore.createNode({ nodeType: 'shape', id: 'r', x: 0, y: 0, options: { label: '开始' } });
    setText(engine, 'r', '很长的标签'.repeat(40));
    expect(engine.documentStore.getNode('r')).toMatchObject(SHAPE_DEFAULT_SIZE);
    const [, label] = compose(engine, 'r') as [CanvasPrimitive, TextPrimitive];
    expect(label).toMatchObject({
      x: 12,
      y: 12,
      width: 136,
      height: 76,
      style: { textOverflow: 'ellipsis', verticalAlign: 'middle' }
    });
  });
});

describe('圆角', () => {
  it('矩形形状、便签与画框画圆角，椭圆、菱形与自由文本不提供圆角；便签默认圆角 4，可调整', () => {
    const engine = createEngine();
    const store = engine.documentStore;
    store.createNode({ nodeType: 'shape', id: 'r', x: 0, y: 0 });
    store.createNode({ nodeType: 'shape', id: 'e', x: 0, y: 0, options: { geometry: 'ellipse' } });
    store.createNode({ nodeType: 'sticky', id: 's', x: 0, y: 0 });
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 0 });
    store.createNode({ nodeType: 'free-text', id: 't', x: 0, y: 0, options: { text: '字' } });
    const supports = (id: string) => {
      const node = store.getNode(id)!;
      return engine.nodeTypes.get(node.nodeType)!.supportsCornerRadius?.(node) ?? false;
    };
    expect(['r', 'e', 's', 'f', 't'].map(supports)).toEqual([true, false, true, true, false]);

    expect(compose(engine, 's')[0]).toMatchObject({ kind: 'rect', radius: 4 });
    store.updateNode('s', { style: { radius: 12 } });
    expect(compose(engine, 's')[0]).toMatchObject({ kind: 'rect', radius: 12 });
  });
});

describe('画框', () => {
  it('标题固定为单行且宽度等于画框宽度，超长支持省略，底部距画框 4px', () => {
    const engine = createEngine();
    engine.documentStore.createNode({
      nodeType: 'frame',
      id: 'f1',
      x: 0,
      y: 0,
      width: 480,
      height: 320,
      options: { title: '画框标题' }
    });
    const [, t1] = compose(engine, 'f1') as [CanvasPrimitive, TextPrimitive];
    expect(t1.y).toBe(-24);
    expect(t1.width).toBe(480);
    expect(t1.height).toBe(20);
    expect(t1.style.textOverflow).toBe('ellipsis');
    const def = engine.nodeTypes.get('frame')!;
    expect(def.extent!(engine.documentStore.getNode('f1')!)).toMatchObject({ top: -24, right: 480 });
  });
});
