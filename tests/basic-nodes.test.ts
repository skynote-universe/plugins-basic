/**
 * @file basic-nodes.test.ts
 * @description 基础节点：尺寸策略 (ADR-111)、图元输出与主题取色
 */

import { describe, it, expect } from 'vitest';
import {
  SkyNoteEngine,
  applyThemeToPrimitives,
  CANVAS_PALETTE,
  type CanvasPrimitive,
  type TextMeasurer,
  type TextPrimitive
} from '@skynote/core';
import { BasicNodesPlugin, STICKY_DEFAULT_SIZE, SHAPE_DEFAULT_SIZE } from '../src';

/**
 * 确定性测量器：每个字符宽 fontSize × 0.5，行高 fontSize × lineHeight；
 * 给定 maxWidth 时按宽度折行，否则单行
 */
const fakeMeasurer: TextMeasurer = {
  measure({ block, style, maxWidth }) {
    const text = block.runs.map((run) => run.text).join('');
    const fontSize = style.fontSize ?? 14;
    const lineHeight = fontSize * (typeof style.lineHeight === 'number' ? style.lineHeight : 1.2);
    const textWidth = text.length * fontSize * 0.5;
    const lines = maxWidth === undefined || textWidth <= maxWidth ? 1 : Math.ceil(textWidth / maxWidth);
    return { width: maxWidth === undefined ? textWidth : Math.min(textWidth, maxWidth), height: lines * lineHeight };
  }
};

function createEngine(): SkyNoteEngine {
  return new SkyNoteEngine({ textMeasurer: fakeMeasurer }).use(new BasicNodesPlugin());
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
  it('短文本保持正方形，文字放不下时向下撑高，删减文字后回到正方形', () => {
    const engine = createEngine();
    engine.documentStore.createNode({ nodeType: 'sticky', id: 's', x: 0, y: 0, options: { text: '短' } });
    expect(engine.documentStore.getNode('s')).toMatchObject({
      width: STICKY_DEFAULT_SIZE,
      height: STICKY_DEFAULT_SIZE
    });

    // 每行可容纳 (200 - 32) / 8 = 21 个字，16px × 1.4 行高；300 字约 15 行
    setText(engine, 's', '字'.repeat(300));
    const grown = engine.documentStore.getNode('s')!;
    expect(grown.width).toBe(STICKY_DEFAULT_SIZE);
    expect(grown.height).toBeGreaterThan(STICKY_DEFAULT_SIZE);
    expect(grown.height).toBe(Math.ceil(Math.ceil(2400 / 168) * 16 * 1.4 + 32));

    setText(engine, 's', '短');
    expect(engine.documentStore.getNode('s')!.height).toBe(STICKY_DEFAULT_SIZE);
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
      text: 'hi',
      fill: CANVAS_PALETTE.ink,
      x: 16,
      y: 16,
      width: 168,
      height: 168,
      textAlign: 'center',
      verticalAlign: 'middle'
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
});

describe('形状', () => {
  it('矩形、椭圆、菱形输出对应轮廓，颜色缺省取主题，显式颜色原样保留', () => {
    const engine = createEngine();
    const theme = engine.session.theme;
    engine.documentStore.createNode({ nodeType: 'shape', id: 'r', x: 0, y: 0 });
    engine.documentStore.createNode({ nodeType: 'shape', id: 'e', x: 0, y: 0, options: { geometry: 'ellipse' } });
    engine.documentStore.createNode({ nodeType: 'shape', id: 'd', x: 0, y: 0, options: { geometry: 'diamond' } });
    engine.documentStore.updateNode('d', { style: { fill: '$green' } });

    const [rect] = compose(engine, 'r');
    expect(rect).toMatchObject({ kind: 'rect', fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 2 });
    expect(compose(engine, 'e')[0]).toMatchObject({ kind: 'ellipse', cx: 80, cy: 50, rx: 80, ry: 50 });
    expect(compose(engine, 'd')[0]).toMatchObject({
      kind: 'polygon',
      points: [80, 0, 160, 50, 80, 100, 0, 50],
      fill: CANVAS_PALETTE.green
    });
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
      textOverflow: 'ellipsis',
      verticalAlign: 'middle'
    });
  });
});
