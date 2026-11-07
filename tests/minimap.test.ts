import { describe, expect, it, vi } from 'vitest';
import { DETACHED_CANVAS_HOST, SkyNoteEngine, type CanvasKeyboardEvent } from '@skynote/core';
import { BasicNodesPlugin, MinimapPlugin, fitMinimap } from '../src';

const size = { width: 224, height: 144 };
function setup() {
  const minimap = new MinimapPlugin();
  const engine = new SkyNoteEngine().use(new BasicNodesPlugin()).use(minimap);
  engine.session.setViewportSize({ width: 1000, height: 600 });
  const store = engine.documentStore;
  const node = (x = 0, y = 0, parentId?: string) =>
    store.createNode({ nodeType: 'shape', x, y, width: 100, height: 60, parentId })!;
  const snapshot = () => minimap.getSnapshot(size)!;
  const project = (x: number, y: number) => {
    const p = snapshot().projection;
    return { x: x * p.scale + p.x, y: y * p.scale + p.y };
  };
  return { minimap, engine, store, node, snapshot, project };
}

describe('平台中立小地图', () => {
  it('导航按键经InputScope分发，仅在获焦时消费，失焦与维护不会移动视口', () => {
    const { engine, minimap, store } = setup();
    const lower = vi.fn();
    engine.inputScopes.pushScope({ id: 'review-lower', priority: -1, onKeyDown: lower });
    const key = (overrides: Partial<CanvasKeyboardEvent> = {}): CanvasKeyboardEvent => ({
      key: 'ArrowRight',
      code: 'ArrowRight',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides
    });
    minimap.setEnabled(true);
    engine.inputScopes.dispatchKeyDown(key());
    expect(engine.session.viewport.x).toBe(0);
    lower.mockClear();
    minimap.setFocused(true);
    const arrow = key();
    expect(engine.inputScopes.dispatchKeyDown(arrow)).toBe(true);
    expect(arrow.preventDefault).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
    expect(engine.session.viewport.x).toBe(-40);
    engine.inputScopes.dispatchKeyDown(key({ shiftKey: true }));
    expect(engine.session.viewport.x).toBe(-200);
    const center = engine.session.viewportCenter;
    engine.inputScopes.dispatchKeyDown(key({ key: '+' }));
    expect(engine.session.viewport.zoom).toBeCloseTo(1.2);
    expect(engine.session.viewportCenter).toEqual(center);
    const before = engine.session.viewport;
    engine.inputScopes.dispatchKeyDown(key({ isComposing: true }));
    engine.inputScopes.dispatchKeyDown(key({ keyCode: 229 }));
    engine.inputScopes.dispatchKeyDown(key({ ctrlKey: true }));
    expect(engine.session.viewport).toEqual(before);
    const lease = engine.beginMaintenance();
    engine.inputScopes.dispatchKeyDown(key());
    expect(engine.session.viewport).toEqual(before);
    lease.resume();
    engine.inputScopes.dispatchBlur();
    engine.inputScopes.dispatchKeyDown(key());
    expect(engine.session.viewport).toEqual(before);
    expect(store.undoEntries).toHaveLength(0);
    engine.destroy();
  });
  it('缺省关闭不收集场景，开启读取最新文档，关闭释放缓存', () => {
    const { engine, minimap, node, snapshot } = setup();
    const read = vi.spyOn(engine.entityStore, 'getAllNodes');
    node();
    expect(minimap.getSnapshot(size)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    minimap.setEnabled(true);
    expect(snapshot().content.nodes).toHaveLength(1);
    minimap.setEnabled(false);
    node(300);
    expect(minimap.getSnapshot(size)).toBeNull();
    minimap.setEnabled(true);
    expect(snapshot().content.nodes).toHaveLength(2);
    engine.destroy();
  });

  it('投影容纳负坐标和视口，空画布与极小画板仍使用有限比例', () => {
    const p = fitMinimap(
      { left: -1000, top: -200, right: 500, bottom: 400 },
      { left: 0, top: 0, right: 1000, bottom: 600 },
      size
    );
    expect(-1000 * p.scale + p.x).toBeGreaterThanOrEqual(8);
    expect(1000 * p.scale + p.x).toBeLessThanOrEqual(size.width - 8);
    expect(
      Number.isFinite(fitMinimap(null, { left: 0, right: 0, top: 0, bottom: 0 }, { width: 1, height: 1 }).scale)
    ).toBe(true);
    const { engine, minimap, snapshot } = setup();
    minimap.setEnabled(true);
    expect(snapshot().content.bounds).toBeNull();
    expect(snapshot().viewport.left).toBeCloseTo(0);
    expect(snapshot().viewport.top).toBeCloseTo(0);
    expect(snapshot().viewport.right).toBe(1000);
    expect(snapshot().viewport.bottom).toBe(600);
    engine.destroy();
  });

  it('独立连线参与内容范围，节点移动增量更新；平移与选区不读取节点几何', () => {
    const { engine, minimap, store, node, snapshot } = setup();
    const a = node();
    node(500);
    const line = store.createConnector({
      connectorType: 'straight',
      from: { position: { x: -600, y: -400 } },
      to: { position: { x: -300, y: -200 } }
    })!;
    minimap.setEnabled(true);
    const initial = snapshot();
    expect(initial.content.connectors.map((c) => c.id)).toContain(line);
    expect(initial.content.bounds?.left).toBe(-600);
    const read = vi.spyOn(engine.spatialIndex, 'getBounds');
    engine.session.setViewport({ x: -100, y: 50 });
    engine.session.setSelection({ nodeIds: [a] });
    expect(snapshot().content).toBe(initial.content);
    expect(snapshot().selectedNodes.has(a)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    store.updateNode(a, { x: 120 });
    expect(snapshot().content.nodes.find((n) => n.id === a)?.bounds.left).toBe(120);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    const added = node(900);
    expect(snapshot().content.nodes.some((n) => n.id === added)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    store.removeEntities({ connectorIds: [line] });
    expect(snapshot().content.connectors).toHaveLength(0);
    engine.destroy();
  });

  it('折叠、撤销和布局卸载同步隐藏成员及绑定连线，普通内容保持可见', () => {
    const { engine, minimap, store, node, snapshot } = setup();
    const root = node();
    const child = node(300, 0, root);
    const regular = node(0, 100, root);
    engine.layouts.register({ id: 'tree', label: '树', collapsible: true, arrange: () => new Map() });
    store.updateNode(root, { layout: { type: 'tree' } });
    store.updateNode(child, { layoutItem: {} });
    const line = store.createConnector({ connectorType: 'straight', from: { nodeId: root }, to: { nodeId: child } })!;
    minimap.setEnabled(true);
    expect(snapshot().content.nodes).toHaveLength(3);
    store.updateNode(root, { layoutState: { collapsed: true } });
    expect(snapshot().content.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([root, regular]));
    expect(snapshot().content.nodes.some((n) => n.id === child)).toBe(false);
    expect(snapshot().content.connectors.some((c) => c.id === line)).toBe(false);
    store.undo();
    expect(snapshot().content.nodes.some((n) => n.id === child)).toBe(true);
    store.redo();
    engine.layouts.unregister(engine.layouts.get('tree')!);
    expect(snapshot().content.nodes.some((n) => n.id === child)).toBe(true);
    engine.destroy();
  });

  it('嵌套与旋转使用世界占据范围，零透明度节点不显示', () => {
    const { engine, minimap, store, node, snapshot } = setup();
    const root = node(400, 300);
    const child = node(200, 100, root);
    store.updateNode(root, { rotation: 90 });
    minimap.setEnabled(true);
    expect(snapshot().content.nodes.find((n) => n.id === child)?.bounds).toEqual(engine.spatialIndex.getBounds(child));
    store.updateNode(child, { style: { opacity: 0 } });
    expect(snapshot().content.nodes.some((n) => n.id === child)).toBe(false);
    engine.destroy();
  });

  it('点击定位和拖动冻结投影，保留选区与历史，非所属指针不起作用', () => {
    const { engine, minimap, store, node, snapshot, project } = setup();
    const id = node(2000);
    engine.session.setSelection({ nodeIds: [id] });
    minimap.setEnabled(true);
    const target = project(2050, 30);
    store.clearHistory();
    expect(minimap.beginNavigation(7, target, size)).toBe(true);
    expect(engine.session.viewportCenter.x).toBeCloseTo(2050);
    const projection = snapshot().projection;
    const viewport = engine.session.viewport;
    minimap.moveNavigation(8, { x: 0, y: 0 });
    minimap.endNavigation(8);
    expect(engine.session.viewport).toEqual(viewport);
    minimap.moveNavigation(7, { x: target.x + 20, y: target.y });
    expect(snapshot().projection).toBe(projection);
    expect(engine.session.viewportCenter.x).toBeCloseTo(2050 + 20 / projection.scale);
    minimap.endNavigation(7);
    expect(minimap.isNavigating).toBe(false);
    expect([...engine.session.selectedNodeIds]).toEqual([id]);
    expect(store.undoEntries).toHaveLength(0);
    engine.destroy();
  });

  it('按下视口框不跳动，拖动保留抓取偏移；只读也可导航', () => {
    const { engine, minimap, snapshot, project, store } = setup();
    minimap.setEnabled(true);
    engine.session.setReadOnly(true);
    const p = project(100, 200);
    minimap.beginNavigation(1, p, size);
    expect(engine.session.viewportCenter).toEqual({ x: 500, y: 300 });
    minimap.moveNavigation(1, { x: p.x + 10, y: p.y });
    expect(snapshot().navigating).toBe(true);
    expect(engine.session.viewportCenter.x).toBeGreaterThan(500);
    expect(store.undoEntries).toHaveLength(0);
    minimap.endNavigation(1);
    engine.destroy();
  });

  it('极小视口的最小示意框整个区域都可抓取，按下不跳动', () => {
    const { engine, minimap, node, project, snapshot } = setup();
    node(1000000);
    minimap.setEnabled(true);
    const center = engine.session.viewportCenter;
    const p = project(center.x, center.y);
    const scale = snapshot().projection.scale;
    expect(1000 * scale).toBe(50);
    expect(minimap.beginNavigation(1, { x: p.x + 24, y: p.y + 14 }, size)).toBe(true);
    expect(engine.session.viewportCenter.x).toBeCloseTo(center.x);
    expect(engine.session.viewportCenter.y).toBeCloseTo(center.y);
    minimap.moveNavigation(1, { x: p.x + 26, y: p.y + 14 });
    expect(engine.session.viewportCenter.x).toBeCloseTo(center.x + 2 / scale);
    engine.destroy();
  });

  it.each([
    'blur',
    'Escape',
    'maintenance',
    'tool',
    'zoom',
    'resize',
    'replace',
    'host',
    'disable',
    'unmount'
  ] as const)('%s取消导航，后续移动不改变视口', (reason) => {
    const { engine, minimap, store, project } = setup();
    engine.attachHost({ ...DETACHED_CANVAS_HOST });
    minimap.setEnabled(true);
    minimap.beginNavigation(3, project(500, 300), size);
    if (reason === 'blur') engine.inputScopes.dispatchBlur();
    else if (reason === 'Escape')
      engine.inputScopes.dispatchKeyDown({ key: 'Escape', preventDefault() {} } as CanvasKeyboardEvent);
    else if (reason === 'maintenance') engine.beginMaintenance();
    else if (reason === 'tool') engine.session.setTool('brush');
    else if (reason === 'zoom') engine.session.setViewport({ zoom: 2 });
    else if (reason === 'resize') engine.session.setViewportSize({ width: 700, height: 500 });
    else if (reason === 'replace')
      store.commit({
        label: '替换',
        patches: [{ op: 'set', path: ['content'], value: { nodes: {}, connectors: {} } }]
      });
    else if (reason === 'host') engine.attachHost({ ...DETACHED_CANVAS_HOST });
    else if (reason === 'disable') minimap.setEnabled(false);
    else engine.plugins.remove(minimap.id);
    const view = engine.session.viewport;
    minimap.moveNavigation(3, { x: 5, y: 5 });
    expect(minimap.isNavigating).toBe(false);
    expect(engine.session.viewport).toEqual(view);
    engine.destroy();
  });

  it('缩放保持锚点并遵守范围，维护状态拒绝新导航', () => {
    const { engine, minimap, snapshot, project } = setup();
    minimap.setEnabled(true);
    minimap.zoomAt(project(500, 300), size, 2);
    expect(engine.session.viewport.zoom).toBe(2);
    expect(engine.session.viewportCenter).toEqual({ x: 500, y: 300 });
    minimap.zoomAt(project(500, 300), size, 1e9);
    expect(engine.session.viewport.zoom).toBe(engine.session.zoomRange.max);
    const lease = engine.beginMaintenance();
    expect(snapshot().disabled).toBe(true);
    expect(minimap.beginNavigation(1, { x: 10, y: 10 }, size)).toBe(false);
    lease.resume();
    expect(minimap.beginNavigation(1, project(500, 300), size)).toBe(true);
    engine.destroy();
  });
});
