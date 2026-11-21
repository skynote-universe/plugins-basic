/**
 * @file connectors.test.ts
 * @description 连线交互：连线工具画线 (吸附、单击不创建、Esc)、点选与框选连线、拖端点重连、删除与创建副本
 */

import { describe, it, expect } from 'vitest';
import {
  SELECT_TOOL,
  SkyNoteEngine,
  SyntheticPointerEvent,
  type CanvasCursor,
  type CanvasHost,
  type CanvasKeyboardEvent,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type Point,
  type TextInputHandler,
  type TextInputSession
} from '@skynote/core';
import {
  BasicNodesPlugin,
  BranchConnectorsPlugin,
  CONNECTOR_TOOL,
  ConnectorEditPlugin,
  ConnectorToolPlugin,
  EditingShortcutsPlugin,
  SelectionPlugin,
  ClipboardPlugin,
  TextEditPlugin,
  TransformPlugin
} from '../src';

class FakeHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, readonly CanvasPrimitive[]>();
  cursor: CanvasCursor = 'default';
  /** 当前文字输入通道 (测试据此模拟键入) */
  input: TextInputHandler | null = null;

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
  setCursor(cursor: CanvasCursor): void {
    this.cursor = cursor;
  }
  capturePointer(): void {}
  releasePointer(): void {}
  openTextInput(handler: TextInputHandler): TextInputSession {
    this.input = handler;
    return { setCaretRect: () => {}, focus: () => {}, close: () => (this.input = null) };
  }
}

const fonts = { measureWidth: (text: string, font: { size: number }) => [...text].length * font.size * 0.5 };

/** a (0,0) 与 b (300,0) 两个 160×100 形状 */
function setup(toolOptions?: ConstructorParameters<typeof ConnectorToolPlugin>[0]) {
  const tool = new ConnectorToolPlugin(toolOptions);
  const engine = new SkyNoteEngine({ fonts })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin())
    .use(new EditingShortcutsPlugin())
    .use(new TextEditPlugin())
    .use(new ClipboardPlugin())
    .use(tool)
    .use(new ConnectorEditPlugin());
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1000, height: 800 });
  const store = engine.documentStore;
  store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0 });
  store.createNode({ nodeType: 'shape', id: 'b', x: 300, y: 0 });
  store.clearHistory();
  return { engine, store, host, tool };
}

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point) {
  const event = new SyntheticPointerEvent({ point, target: engine.hitTestNode(point) as NodeEntity | undefined });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

function drag(engine: SkyNoteEngine, from: Point, to: Point) {
  pointer(engine, 'down', from);
  pointer(engine, 'move', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  pointer(engine, 'move', to);
  pointer(engine, 'up', to);
}

function key(engine: SkyNoteEngine, code: string, init: Partial<CanvasKeyboardEvent> = {}) {
  return engine.inputScopes.dispatchKeyDown({
    key: code,
    code,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...init
  });
}

const connectors = (engine: SkyNoteEngine) => Object.values(engine.documentStore.getView().content.connectors);

describe('连线工具', () => {
  it('按 X 进入；从 a 的右侧吸附点拖到 b 内部：固定端 + 浮动端，画完回到选择工具并选中新连线', () => {
    const { engine, host } = setup();
    key(engine, 'KeyX', { key: 'x' });
    expect(engine.session.tool).toBe(CONNECTOR_TOOL);

    // 悬停时显示 a 的吸附点
    pointer(engine, 'move', { x: 80, y: 50 });
    expect(host.sessions.get('connector-tool:hint')?.filter((p) => p.kind === 'circle')).toHaveLength(4);
    expect(host.cursor).toBe('crosshair');

    drag(engine, { x: 162, y: 50 }, { x: 380, y: 60 });
    const [connector] = connectors(engine);
    expect(connector.connectorType).toBe('orthogonal');
    expect(connector.from).toEqual({ nodeId: 'a', anchor: { x: 1, y: 0.5 } });
    expect(connector.to).toEqual({ nodeId: 'b' });
    expect(connector.style?.endArrow).toBe(true);
    expect(engine.session.tool).toBe(SELECT_TOOL);
    expect([...engine.session.selectedConnectorIds]).toEqual([connector.id]);
    expect(host.sessions.has('connector-tool:hint')).toBe(false);
  });

  it('按界面选择的线型创建；落在空白处留下自由端；单击不创建；Esc 退出工具', () => {
    const { engine, tool } = setup();
    tool.connectorType = 'straight';
    engine.session.setTool(CONNECTOR_TOOL);
    pointer(engine, 'down', { x: 80, y: 50 });
    pointer(engine, 'up', { x: 80, y: 50 });
    expect(connectors(engine)).toHaveLength(0);
    expect(engine.session.tool).toBe(CONNECTOR_TOOL);

    drag(engine, { x: 80, y: 50 }, { x: 200, y: 400 });
    const [connector] = connectors(engine);
    expect(connector.connectorType).toBe('straight');
    expect(connector.to).toEqual({ position: { x: 200, y: 400 } });

    engine.session.setTool(CONNECTOR_TOOL);
    expect(key(engine, 'Escape', { key: 'Escape' })).toBe(true);
    expect(engine.session.tool).toBe(SELECT_TOOL);
  });

  it('终点不吸附到起点所在的节点', () => {
    const { engine } = setup();
    engine.session.setTool(CONNECTOR_TOOL);
    drag(engine, { x: 80, y: 50 }, { x: 100, y: 60 });
    expect(connectors(engine)[0].to).toEqual({ position: { x: 100, y: 60 } });
  });

  it('连线工具激活时按在节点上不会选中或拖动节点', () => {
    const { engine, store } = setup();
    engine.session.setTool(CONNECTOR_TOOL);
    drag(engine, { x: 80, y: 50 }, { x: 80, y: 300 });
    expect(store.getNode('a')!.y).toBe(0);
    expect(engine.session.selectedNodeIds.size).toBe(0);
  });
});

describe('选中与编辑连线', () => {
  function withConnector() {
    const ctx = setup();
    const id = ctx.store.createConnector({
      connectorType: 'straight',
      from: { nodeId: 'a', anchor: { x: 1, y: 0.5 } },
      to: { nodeId: 'b', anchor: { x: 0, y: 0.5 } }
    })!;
    ctx.store.clearHistory();
    return { ...ctx, id };
  }

  it('点在线上选中连线 (取消节点选择)；框选只选整条落在框内的连线', () => {
    const { engine, id } = withConnector();
    engine.session.setSelection({ nodeIds: ['a'] });
    pointer(engine, 'down', { x: 230, y: 52 });
    pointer(engine, 'up', { x: 230, y: 52 });
    expect([...engine.session.selectedConnectorIds]).toEqual([id]);
    expect(engine.session.selectedNodeIds.size).toBe(0);

    drag(engine, { x: 200, y: -50 }, { x: 600, y: 200 });
    expect(engine.session.selectedConnectorIds.size).toBe(0);
    drag(engine, { x: -50, y: -50 }, { x: 600, y: 200 });
    expect([...engine.session.selectedConnectorIds]).toEqual([id]);
  });

  it('拖动终点手柄改接到空白处，再拖回 b 的吸附点；一次拖动一步撤销', () => {
    const { engine, store, id } = withConnector();
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    drag(engine, { x: 300, y: 50 }, { x: 300, y: 400 });
    expect(store.getConnector(id)!.to).toEqual({ position: { x: 300, y: 400 } });
    expect(store.getConnector(id)!.from).toEqual({ nodeId: 'a', anchor: { x: 1, y: 0.5 } });

    drag(engine, { x: 300, y: 400 }, { x: 382, y: 102 });
    expect(store.getConnector(id)!.to).toEqual({ nodeId: 'b', anchor: { x: 0.5, y: 1 } });
    store.undo();
    expect(store.getConnector(id)!.to).toEqual({ position: { x: 300, y: 400 } });
  });

  it('Delete 删除选中连线；Ctrl+D 复制选中连线 (两端节点没有一起复制时改为自由端)', () => {
    const { engine, store, id } = withConnector();
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    key(engine, 'KeyD', { key: 'd', ctrlKey: true });
    const [copyId] = engine.session.selectedConnectorIds;
    expect(copyId).not.toBe(id);
    // 形状描边 2：线端在边框外 1 处 (161, 50)，副本偏移 (20, 20)
    expect(store.getConnector(copyId)!.from).toEqual({ position: { x: 181, y: 70 } });

    key(engine, 'Delete', { key: 'Delete' });
    expect(store.getConnector(copyId)).toBeUndefined();
    expect(store.getConnector(id)).toBeDefined();
  });

  it('Ctrl+Shift+L 锁定与解锁选中的节点和连线，一步撤销；锁定的连线不能删除', () => {
    const { engine, store, id } = withConnector();
    engine.session.setSelection({ nodeIds: ['a'], connectorIds: [id] });
    key(engine, 'KeyL', { key: 'L', ctrlKey: true, shiftKey: true });
    expect(store.getConnector(id)!.locked).toBe(true);
    expect(store.getNode('a')!.locked).toBe(true);
    key(engine, 'Delete', { key: 'Delete' });
    expect(store.getConnector(id)).toBeDefined();

    store.undo();
    expect(store.getConnector(id)!.locked).toBe(false);
    expect(store.getNode('a')!.locked).toBe(false);

    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    key(engine, 'KeyL', { key: 'L', ctrlKey: true, shiftKey: true });
    key(engine, 'KeyL', { key: 'L', ctrlKey: true, shiftKey: true });
    expect(store.getConnector(id)!.locked).toBe(false);
  });

  it('拖动选中的自由连线整体平移', () => {
    const { engine, store } = setup();
    const id = store.createConnector({
      connectorType: 'straight',
      from: { position: { x: 0, y: 300 } },
      to: { position: { x: 200, y: 300 } }
    })!;
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    // 中点是加拐点的手柄，按在线上其他位置才是整体拖动
    drag(engine, { x: 50, y: 300 }, { x: 50, y: 350 });
    expect(store.getConnector(id)!.from).toEqual({ position: { x: 0, y: 350 } });
    expect(store.getConnector(id)!.to).toEqual({ position: { x: 200, y: 350 } });
  });

  it('折线拖中间段平移：自动路由固化为手动拐点，之后移动节点只调整首尾两段；切换线型清除手动拐点', () => {
    const { engine, store } = setup();
    store.updateNode('b', { y: 200 });
    const id = store.createConnector({
      from: { nodeId: 'a', anchor: { x: 1, y: 0.5 } },
      to: { nodeId: 'b', anchor: { x: 0, y: 0.5 } }
    })!;
    // a 右侧 → b 左侧 (线端在描边外沿，各外移 1)：竖段在两节点正中 x = 230
    expect(engine.getConnectorRoute(id)!.points).toEqual([
      { x: 161, y: 50 },
      { x: 230, y: 50 },
      { x: 230, y: 250 },
      { x: 299, y: 250 }
    ]);
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    drag(engine, { x: 230, y: 150 }, { x: 260, y: 170 });
    expect(engine.getConnectorRoute(id)!.points[1]).toEqual({ x: 260, y: 50 });

    store.moveEntities({ nodeIds: ['a'] }, { x: 0, y: 30 });
    expect(engine.getConnectorRoute(id)!.points).toEqual([
      { x: 161, y: 80 },
      { x: 260, y: 80 },
      { x: 260, y: 250 },
      { x: 299, y: 250 }
    ]);
    store.undo();
    store.undo();
    expect(store.getConnector(id)!.controlPoints).toBeUndefined();
  });

  it('直线拖中点加拐点、双击拐点删除；曲线拖中点改弯度', () => {
    const { engine, store } = setup();
    const id = store.createConnector({
      connectorType: 'straight',
      from: { position: { x: 0, y: 300 } },
      to: { position: { x: 200, y: 300 } }
    })!;
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    drag(engine, { x: 100, y: 300 }, { x: 100, y: 400 });
    expect(store.getConnector(id)!.controlPoints).toEqual([{ x: 100, y: 400 }]);

    const down = new SyntheticPointerEvent({ point: { x: 100, y: 400 }, clickCount: 2 });
    engine.pointer.dispatchPointerDown(down);
    engine.pointer.dispatchPointerUp(down);
    expect(store.getConnector(id)!.controlPoints).toBeUndefined();

    store.updateConnector(id, { connectorType: 'curved' });
    const curve = engine.getConnectorRoute(id)!.points;
    const mid = curve[Math.floor(curve.length / 2)];
    drag(engine, mid, { x: mid.x, y: mid.y + 80 });
    const through = store.getConnector(id)!.controlPoints![0];
    expect(through.y).toBeCloseTo(mid.y + 80);
    // 曲线确实经过手动点
    expect(engine.getConnectorRoute(id)!.points.some((p) => Math.hypot(p.x - through.x, p.y - through.y) < 0.01)).toBe(
      true
    );
  });
});

describe('快速连接', () => {
  it('组合不支持同类节点新建，不显示四边连接点或悬停预览，点击原连接点位置不创建内容', () => {
    const { engine, store, host } = setup();
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(true);
    const groupId = store.groupNodes(['a', 'b'])!;
    engine.session.setSelection({ nodeIds: [groupId] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);
    const bounds = engine.getNodeWorldBounds(groupId)!;
    const point = { x: bounds.right + 22, y: (bounds.top + bounds.bottom) / 2 };
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    pointer(engine, 'move', point);
    expect(host.sessions.has('connector-tool:plus')).toBe(false);
    expect(() => {
      pointer(engine, 'down', point);
      pointer(engine, 'up', point);
    }).not.toThrow();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });

  it('默认采用白名单机制：未声明 quickConnect: true 的节点类型不显示四边快捷连接「+」', () => {
    const { engine, store, host } = setup();
    engine.use({
      id: 'test-whitelist-default',
      name: '测试插件',
      version: '0.1.0',
      install(ctx) {
        ctx.registerNodeType({
          type: 'plain-custom',
          label: '未声明快捷连接',
          defaultData: {},
          createContent: () => ({ width: 100, height: 100 })
        });
        ctx.registerNodeType({
          type: 'opt-in-custom',
          label: '显式启用快捷连接',
          defaultData: {},
          quickConnect: true,
          createContent: () => ({ width: 100, height: 100 })
        });
      }
    });
    store.createNode({ id: 'plain1', nodeType: 'plain-custom', x: 200, y: 200, width: 100, height: 100 });
    store.createNode({ id: 'opt1', nodeType: 'opt-in-custom', x: 400, y: 200, width: 100, height: 100 });
    const webLinkId = store.createNode({
      nodeType: 'web-link',
      x: 600,
      y: 200,
      options: { url: 'https://example.com' }
    })!;

    engine.session.setSelection({ nodeIds: ['plain1'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);

    engine.session.setSelection({ nodeIds: [webLinkId] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);

    engine.session.setSelection({ nodeIds: ['opt1'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(true);
    engine.destroy();
  });

  it('开发者可通过 quickConnectTypes 显式指定支持快捷添加的节点白名单', () => {
    const { engine, store, host } = setup({ quickConnectTypes: ['custom-card'] });
    engine.use({
      id: 'test-explicit-whitelist',
      name: '测试插件',
      version: '0.1.0',
      install(ctx) {
        ctx.registerNodeType({
          type: 'custom-card',
          label: '自定义卡片',
          defaultData: {},
          createContent: () => ({ width: 120, height: 80 })
        });
      }
    });
    store.createNode({ id: 'card1', nodeType: 'custom-card', x: 200, y: 200, width: 120, height: 80 });

    // shape 虽声明 quickConnect: true，但不在开发者指定的白名单内，不显示「+」
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);

    // custom-card 未声明 quickConnect，但在开发者指定的白名单内，显示「+」
    engine.session.setSelection({ nodeIds: ['card1'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(true);
    engine.destroy();

    // 传入空数组可完全关闭所有节点的快捷添加
    const disabled = setup({ quickConnectTypes: [] });
    disabled.engine.session.setSelection({ nodeIds: ['a'] });
    expect(disabled.host.sessions.has('connector-tool:plus')).toBe(false);
    disabled.engine.destroy();
  });

  it('选中单个节点时四边出现「+」；单击右侧「+」在右边新建同类节点并连线，一步撤销', () => {
    const { engine, store, host } = setup();
    store.updateNode('a', { style: { fill: '$red' } });
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(host.sessions.get('connector-tool:plus')?.filter((p) => p.kind === 'circle')).toHaveLength(4);
    // 悬停右侧连接点：放大成「+」，并用虚线预览将要新建的节点 (b 占着右侧，往下错开) 与连线
    pointer(engine, 'move', { x: 182, y: 50 });
    const preview = host.sessions.get('connector-tool:plus')!;
    // 预览轮廓与预览线在最下层，其后是四个连接点 (悬停的那个带十字)
    expect(preview.slice(0, 2).map((p) => p.kind)).toEqual(['polygon', 'line']);
    expect(preview.filter((p) => p.kind === 'circle')).toHaveLength(4);
    expect(preview.filter((p) => p.kind === 'line')).toHaveLength(3);
    const ghost = preview[0];
    expect(ghost.kind === 'polygon' && ghost.points[0]).toBe(260);

    // a 右侧吸附点 (160, 50) 向外 28 像素；b 占着右侧，新节点继续往下错开
    pointer(engine, 'down', { x: 188, y: 50 });
    pointer(engine, 'up', { x: 188, y: 50 });
    const [created] = engine.session.selectedNodeIds;
    // 新节点的连接点不带上一个节点的悬停预览 (鼠标并不在它上面)
    expect(host.sessions.get('connector-tool:plus')!.some((p) => p.kind === 'polygon')).toBe(false);
    const node = store.getNode(created)!;
    expect(node).toMatchObject({ nodeType: 'shape', width: 160, height: 100, style: { fill: '$red' } });
    expect(node.x).toBe(260);
    expect(node.y).toBeGreaterThan(100);
    expect(connectors(engine)[0]).toMatchObject({ from: { nodeId: 'a' }, to: { nodeId: created } });
    store.undo();
    expect(store.getNode(created)).toBeUndefined();
    expect(connectors(engine)).toHaveLength(0);
  });

  it('星形的吸附点是五个尖角，三角形是顶点与各边中点；「+」排在外框四边，连线从最朝向该方向的吸附点出发', () => {
    const { engine, store, host } = setup();
    store.createNode({ nodeType: 'shape', id: 's', x: 0, y: 300, options: { geometry: 'star' } });
    store.createNode({ nodeType: 'shape', id: 't', x: 300, y: 300, options: { geometry: 'triangle' } });
    const round = (points: Point[]) => points.map((p) => ({ x: Math.round(p.x) + 0, y: Math.round(p.y) + 0 }));
    // 120×120 的星形：顶尖、右上、右下、左下、左上
    expect(round(engine.getConnectorAnchors('s'))).toEqual([
      { x: 60, y: 300 },
      { x: 120, y: 346 },
      { x: 97, y: 420 },
      { x: 23, y: 420 },
      { x: 0, y: 346 }
    ]);
    expect(round(engine.getConnectorAnchors('t'))).toEqual([
      { x: 360, y: 300 },
      { x: 390, y: 360 },
      { x: 360, y: 420 },
      { x: 330, y: 360 }
    ]);

    // 「+」在外框四边中点外侧
    engine.session.setSelection({ nodeIds: ['s'] });
    const dots = host.sessions.get('connector-tool:plus')!.filter((p) => p.kind === 'circle');
    expect(dots.map((p) => p.kind === 'circle' && [Math.round(p.cx), Math.round(p.cy)])).toEqual([
      [60, 278],
      [142, 360],
      [60, 442],
      [-22, 360]
    ]);
    // 单击下方「+」：两端浮动，从星形朝下的尖角出发 (而不是两腿之间的凹处)
    pointer(engine, 'down', { x: 60, y: 442 });
    pointer(engine, 'up', { x: 60, y: 442 });
    const [line] = connectors(engine);
    const start = engine.getConnectorRoute(line.id)!.points[0];
    expect(Math.round(start.y)).toBeGreaterThanOrEqual(420);
  });

  it('拖动「+」从这条边画线；松手在空白处通知界面，界面选择后在自由端新建节点并连上', () => {
    const { engine, store, tool } = setup();
    const drops: { connectorId: string; point: { x: number; y: number } }[] = [];
    tool.onDropOnBlank((e) => drops.push(e));
    engine.session.setSelection({ nodeIds: ['a'] });
    drag(engine, { x: 80, y: 128 }, { x: 80, y: 400 });
    const [connector] = connectors(engine);
    expect(connector.from).toEqual({ nodeId: 'a', anchor: { x: 0.5, y: 1 } });
    expect(drops).toEqual([{ connectorId: connector.id, point: { x: 80, y: 400 } }]);

    const id = tool.connectNewNode(connector.id, { nodeType: 'sticky' })!;
    const sticky = store.getNode(id)!;
    // 自由端在节点上方边的中点：线从下往上连进来
    expect(sticky.x + sticky.width / 2).toBe(80);
    expect(sticky.y).toBe(400);
    expect(store.getConnector(connector.id)!.to).toEqual({ nodeId: id });
    expect([...engine.session.selectedNodeIds]).toEqual([id]);
  });

  it('只在连线工具被切走时复位光标，切换其他工具不覆盖新工具设好的光标', () => {
    const { engine, host } = setup();
    engine.session.setTool(CONNECTOR_TOOL);
    expect(host.cursor).toBe('crosshair');
    engine.session.setTool('select');
    expect(host.cursor).toBe('default');
    // 另一个工具 (如画笔) 激活时设了十字光标：连线工具的监听不再把它改回默认
    engine.session.setTool('brush');
    host.setCursor('crosshair');
    engine.session.setTool('pen');
    expect(host.cursor).toBe('crosshair');
  });

  it('选中节点后切换到连线工具：「+」随之消失', () => {
    const { engine, host } = setup();
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(true);
    engine.session.setTool(CONNECTOR_TOOL);
    expect(host.sessions.has('connector-tool:plus')).toBe(false);
  });

  it('编辑文字、多选或选中画框时不显示「+」', () => {
    const { engine, store, host } = setup();
    engine.session.setSelection({ nodeIds: ['a', 'b'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);
    store.createNode({ nodeType: 'frame', id: 'f', x: 0, y: 500 });
    engine.session.setSelection({ nodeIds: ['f'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);
  });
});

describe('布局树中的节点', () => {
  it('选中派生连线 (如布局分支线) 只有选中描边，没有端点与拐点手柄', () => {
    const { engine, store, host } = setup();
    engine.use(new BranchConnectorsPlugin());
    store.updateNode('a', { layout: { type: 'test:none' } });
    store.updateNode('b', { parentId: 'a', layoutItem: {} });
    engine.session.setSelection({ nodeIds: [], connectorIds: ['@branch:b'] });
    const selected = host.sessions.get('connector-edit:selected') ?? [];
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.some((p) => p.kind === 'circle' || p.kind === 'rect')).toBe(false);
  });

  it('处在已安装布局的布局树中 (根或成员) 时不显示「+」；布局未安装时照常显示', () => {
    const { engine, store, host } = setup();
    store.updateNode('a', { layout: { type: 'test:stack' } });
    store.updateNode('b', { parentId: 'a', layoutItem: {} });
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(true);

    engine.use({
      id: 'test/stack',
      name: '堆叠',
      version: '1.0.0',
      install: (ctx) => ctx.registerLayout({ id: 'test:stack', label: '堆叠', arrange: () => new Map() })
    });
    engine.session.setSelection({ nodeIds: [] });
    engine.session.setSelection({ nodeIds: ['a'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);
    engine.session.setSelection({ nodeIds: ['b'] });
    expect(host.sessions.has('connector-tool:plus')).toBe(false);
  });
});

describe('连线文字', () => {
  function withLine() {
    const ctx = setup();
    const id = ctx.store.createConnector({
      connectorType: 'straight',
      from: { position: { x: 0, y: 300 } },
      to: { position: { x: 400, y: 300 } }
    })!;
    ctx.store.clearHistory();
    return { ...ctx, id };
  }

  function doubleClick(engine: SkyNoteEngine, point: Point) {
    for (const clickCount of [1, 2]) {
      const event = new SyntheticPointerEvent({
        point,
        clickCount,
        target: engine.hitTestNode(point) as NodeEntity | undefined
      });
      engine.pointer.dispatchPointerDown(event);
      engine.pointer.dispatchPointerUp(event);
    }
  }

  it('双击连线在双击处新建文字并进入编辑；输入后文字参与拾取；删空退出时移除', () => {
    const { engine, store, host, id } = withLine();
    doubleClick(engine, { x: 100, y: 300 });
    expect(engine.session.textEditing).toMatchObject({ kind: 'connector', id });
    expect(store.getConnector(id)!.textBlocks![0].position).toBeCloseTo(0.25);

    host.input!.insertText('同意');
    expect(store.getConnector(id)!.textBlocks![0].runs).toEqual([{ text: '同意' }]);
    // 编辑中不显示连线手柄，点在文字上是定位光标
    expect(host.sessions.get('connector-edit:selected')?.some((p) => p.kind === 'circle')).toBeFalsy();
    const [label] = engine.getConnectorRoute(id)!.labels;
    expect((label.bounds.left + label.bounds.right) / 2).toBeCloseTo(100);
    // 点在文字上 (离线较远处) 也命中连线
    expect(engine.hitTestConnector({ x: 100, y: label.bounds.top + 1 })?.id).toBe(id);

    key(engine, 'Escape', { key: 'Escape' });
    expect(engine.session.textEditing).toBeNull();
    doubleClick(engine, { x: 100, y: 300 });
    key(engine, 'KeyA', { key: 'a', ctrlKey: true });
    key(engine, 'Backspace', { key: 'Backspace' });
    key(engine, 'Escape', { key: 'Escape' });
    expect(store.getConnector(id)!.textBlocks).toBeUndefined();
  });

  it('复制连线时线上的文字进入纯文本', () => {
    const { engine, store, id } = withLine();
    store.updateConnector(id, { textBlocks: [{ id: 'l', runs: [{ text: '同意' }], position: 0.5 }] });
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    expect(engine.clipboard.copy()!['text/plain']).toBe('同意');
  });

  it('一条线多段文字：双击线上别处新加一段，双击已有文字编辑它；各段独立拖动与删除', () => {
    const { engine, store, host, id } = withLine();
    doubleClick(engine, { x: 100, y: 300 });
    host.input!.insertText('是');
    key(engine, 'Escape', { key: 'Escape' });
    doubleClick(engine, { x: 300, y: 300 });
    host.input!.insertText('否');
    key(engine, 'Escape', { key: 'Escape' });
    const blocks = store.getConnector(id)!.textBlocks!;
    expect(blocks.map((b) => b.runs[0].text)).toEqual(['是', '否']);
    expect(engine.getConnectorRoute(id)!.labels).toHaveLength(2);

    // 双击第一段文字：编辑它而不是再加一段
    doubleClick(engine, { x: 100, y: 300 });
    expect(engine.session.textEditing).toMatchObject({ blockId: blocks[0].id });
    key(engine, 'KeyA', { key: 'a', ctrlKey: true });
    key(engine, 'Backspace', { key: 'Backspace' });
    key(engine, 'Escape', { key: 'Escape' });
    expect(store.getConnector(id)!.textBlocks!.map((b) => b.runs[0].text)).toEqual(['否']);
  });

  it('双击加文字后什么都没输入就退出：连线不变，也不留下撤销步骤', () => {
    const { engine, store, id } = withLine();
    doubleClick(engine, { x: 100, y: 300 });
    key(engine, 'Escape', { key: 'Escape' });
    expect(store.getConnector(id)!.textBlocks).toBeUndefined();
    expect(store.canUndo).toBe(false);
  });

  it('选中连线后拖动文字沿线移动；按在文字上不会被段中点手柄抢走', () => {
    const { engine, store, host, id } = withLine();
    doubleClick(engine, { x: 200, y: 300 });
    host.input!.insertText('是');
    key(engine, 'Escape', { key: 'Escape' });
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    drag(engine, { x: 200, y: 300 }, { x: 300, y: 330 });
    expect(store.getConnector(id)!.textBlocks![0].position).toBeCloseTo(0.75);
    expect(store.getConnector(id)!.controlPoints).toBeUndefined();
  });

  it('Shift 点击单独选中的连线的文字：从选区移除该连线，而不是开始拖动文字', () => {
    const { engine, store, host, id } = withLine();
    doubleClick(engine, { x: 200, y: 300 });
    host.input!.insertText('是');
    key(engine, 'Escape', { key: 'Escape' });
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    const point = { x: 200, y: 300 };
    const event = { point, modifiers: { shift: true } };
    engine.pointer.dispatchPointerDown(new SyntheticPointerEvent(event));
    engine.pointer.dispatchPointerUp(new SyntheticPointerEvent(event));
    expect([...engine.session.selectedConnectorIds]).toEqual([]);
    expect(store.getConnector(id)!.textBlocks![0].position).toBe(0.5);
  });
});

describe('拐点与文字的细调', () => {
  it('折线首段也能拖：节点边上保留一段出线短线再拐过去', () => {
    const { engine, store } = setup();
    store.updateNode('b', { y: 200 });
    const id = store.createConnector({
      from: { nodeId: 'a', anchor: { x: 1, y: 0.5 } },
      to: { nodeId: 'b', anchor: { x: 0, y: 0.5 } }
    })!;
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    // 首段 (161,50)→(230,50) 的中点向上拖 40
    drag(engine, { x: 195, y: 50 }, { x: 195, y: 10 });
    expect(engine.getConnectorRoute(id)!.points.slice(0, 4)).toEqual([
      { x: 161, y: 50 },
      { x: 181, y: 50 },
      { x: 181, y: 10 },
      { x: 230, y: 10 }
    ]);
  });

  it('太短的段、只剩出线短线的首尾段与端点附近不放拐点类手柄', () => {
    const { engine, store, host } = setup();
    const id = store.createConnector({
      from: { nodeId: 'a', anchor: { x: 1, y: 0.5 } },
      to: { position: { x: 400, y: 300 } }
    })!;
    // 首段只剩 20 的出线短线，随后一段只有 10
    store.updateConnector(id, {
      controlPoints: [
        { x: 180, y: 50 },
        { x: 180, y: 60 },
        { x: 300, y: 60 },
        { x: 300, y: 300 }
      ]
    });
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    const capsules = host.sessions.get('connector-edit:selected')!.filter((p) => p.kind === 'rect');
    // 首段 (短线) 与 10 长的小段不可拖；其余三段可拖 (末段 100 长于出线短线)
    expect(capsules).toHaveLength(3);
  });

  it('曲线每段中点都能拖出新的经过点，曲线依次经过它们', () => {
    const { engine, store } = setup();
    const id = store.createConnector({
      connectorType: 'curved',
      from: { position: { x: 0, y: 300 } },
      to: { position: { x: 400, y: 300 } }
    })!;
    store.updateConnector(id, { controlPoints: [{ x: 200, y: 360 }] });
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    // 第二段 (经过点 → 终点) 的中点
    const second = engine.getConnectorRoute(id)!.points[24 + 12];
    drag(engine, second, { x: second.x, y: second.y - 80 });
    const points = store.getConnector(id)!.controlPoints!;
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ x: 200, y: 360 });
    const route = engine.getConnectorRoute(id)!.points;
    for (const p of points) expect(route.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.01)).toBe(true);
  });

  it('文字可以拖离线条 (存为偏移)；靠近线条时贴回线上', () => {
    const { engine, store, host } = setup();
    const id = store.createConnector({
      connectorType: 'straight',
      from: { position: { x: 0, y: 300 } },
      to: { position: { x: 400, y: 300 } }
    })!;
    store.updateConnector(id, { textBlocks: [{ id: 'l', runs: [{ text: '是' }], position: 0.5 }] });
    engine.session.setSelection({ nodeIds: [], connectorIds: [id] });
    // 选中时画出文字范围
    expect(host.sessions.get('connector-edit:selected')?.some((p) => p.kind === 'rect')).toBe(true);
    // 拖动中：线上锚点加一条指向文字的虚线
    pointer(engine, 'down', { x: 200, y: 300 });
    pointer(engine, 'move', { x: 250, y: 260 });
    expect(host.sessions.get('connector-edit:drag')?.map((p) => p.kind)).toEqual(['line', 'circle']);
    pointer(engine, 'up', { x: 250, y: 260 });
    expect(host.sessions.has('connector-edit:drag')).toBe(false);
    expect(store.getConnector(id)!.textBlocks![0]).toMatchObject({ position: 0.625, offsetX: 0, offsetY: -40 });
    drag(engine, { x: 250, y: 260 }, { x: 250, y: 297 });
    const block = store.getConnector(id)!.textBlocks![0];
    expect(block.offsetY).toBeUndefined();
  });

  it('输入法拼音输入中，文字范围框随组合文字同步伸展', () => {
    const { engine, store, host } = setup();
    const id = store.createConnector({
      connectorType: 'straight',
      from: { position: { x: 0, y: 300 } },
      to: { position: { x: 400, y: 300 } }
    })!;
    store.updateConnector(id, { textBlocks: [{ id: 'l', runs: [{ text: '是' }], position: 0.5 }] });
    const rectWidth = () => {
      const rect = host.sessions.get('connector-edit:selected')!.find((p) => p.kind === 'rect');
      return rect && rect.kind === 'rect' ? rect.width : 0;
    };
    for (const clickCount of [1, 2]) {
      const event = new SyntheticPointerEvent({ point: { x: 200, y: 300 }, clickCount });
      engine.pointer.dispatchPointerDown(event);
      engine.pointer.dispatchPointerUp(event);
    }
    const before = rectWidth();
    host.input!.compositionStart();
    host.input!.compositionUpdate('fou');
    expect(rectWidth()).toBeGreaterThan(before);
    host.input!.compositionEnd('否');
  });
});
