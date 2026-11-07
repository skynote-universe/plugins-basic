import { describe, expect, it } from 'vitest';
import {
  DETACHED_CANVAS_HOST,
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasPrimitive,
  type Point
} from '@skynote/core';
import {
  BasicNodesPlugin,
  ConnectorEditPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  TransformPlugin
} from '../src';

function setup() {
  const layers = new Map<string, readonly CanvasPrimitive[]>();
  let cursor: unknown;
  const engine = new SkyNoteEngine()
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin())
    .use(new ConnectorEditPlugin())
    .use(new SelectionOutlinePlugin());
  engine.attachHost({
    ...DETACHED_CANVAS_HOST,
    overlay: {
      setPrimitives(id, primitives) {
        layers.set(id, primitives);
      },
      clear(id) {
        layers.delete(id);
      }
    },
    setCursor(value) {
      cursor = value;
    }
  });
  const store = engine.documentStore;
  const a = store.createNode({ nodeType: 'shape', x: 100, y: 100, width: 100, height: 60 })!;
  const b = store.createNode({ nodeType: 'shape', x: 400, y: 100, width: 100, height: 60 })!;
  const connector = store.createConnector({ connectorType: 'straight', from: { nodeId: a }, to: { nodeId: b } })!;
  let blocked = false;
  engine.use({
    id: 'hover-control',
    name: '通用高优先级控件',
    version: 'test',
    install(ctx) {
      ctx.registerPointerHooks(
        {
          onPointerMove(event) {
            if (!blocked) return;
            event.claimPointer('hover-control');
            ctx.host.setCursor('pointer');
          }
        },
        100
      );
    }
  });
  const pointer = (phase: 'down' | 'move' | 'up', point: Point) => {
    const event = new SyntheticPointerEvent({ point, target: engine.hitTestNode(point) });
    if (phase === 'down') engine.pointer.dispatchPointerDown(event);
    if (phase === 'move') engine.pointer.dispatchPointerMove(event);
    if (phase === 'up') engine.pointer.dispatchPointerUp(event);
  };
  return {
    engine,
    store,
    a,
    connector,
    layers,
    pointer,
    block: (value: boolean) => {
      blocked = value;
    },
    cursor: () => cursor
  };
}

describe('高优先级控件的悬停认领', () => {
  it('清除此前节点悬停，后续视口刷新不重现旧高亮；解除认领后恢复', () => {
    const { engine, layers, pointer, block } = setup();
    const point = { x: 150, y: 130 };
    try {
      pointer('move', point);
      expect(layers.has('selection:hover')).toBe(true);
      block(true);
      pointer('move', point);
      expect(layers.has('selection:hover')).toBe(false);
      engine.session.setViewport({ x: 5 });
      expect(layers.has('selection:hover')).toBe(false);
      block(false);
      pointer('move', point);
      expect(layers.has('selection:hover')).toBe(true);
    } finally {
      engine.destroy();
    }
  });

  it('清除此前连线悬停，保持控件光标且不改动选区', () => {
    const { engine, layers, pointer, block, cursor } = setup();
    const point = { x: 300, y: 130 };
    try {
      pointer('move', point);
      expect(layers.has('connector-edit:hover')).toBe(true);
      block(true);
      pointer('move', point);
      expect(layers.has('connector-edit:hover')).toBe(false);
      expect(cursor()).toBe('pointer');
      expect(engine.session.selectedConnectorIds.size).toBe(0);
      block(false);
      pointer('move', point);
      expect(layers.has('connector-edit:hover')).toBe(true);
    } finally {
      engine.destroy();
    }
  });

  it('从缩放手柄进入已认领区域时，不复位上层控件设置的光标', () => {
    const { engine, a, pointer, block, cursor } = setup();
    try {
      engine.session.setSelection({ nodeIds: [a] });
      const bounds = engine.getNodeWorldBounds(a)!;
      const point = { x: bounds.right, y: bounds.bottom };
      pointer('move', point);
      expect(cursor()).toMatchObject({ kind: 'resize' });
      block(true);
      pointer('move', point);
      expect(cursor()).toBe('pointer');
    } finally {
      engine.destroy();
    }
  });

  it('已开始的连线端点拖拽不被悬停认领打断', () => {
    const { engine, store, connector, pointer, block } = setup();
    try {
      engine.session.setSelection({ nodeIds: [], connectorIds: [connector] });
      const start = engine.getConnectorRoute(connector)!.points[0];
      const destination = { x: 300, y: 260 };
      pointer('down', start);
      block(true);
      pointer('move', destination);
      pointer('up', destination);
      expect(store.getConnector(connector)!.from.position).toEqual(destination);
    } finally {
      engine.destroy();
    }
  });
});
