/**
 * @file branch-connectors.test.ts
 * @description ADR-130 布局树分支线：派生规则、三层生效值与继承、写入转写与改挂、成员关系变化、
 *              复制、读取校验、未安装布局时的降级与布局晚到时的刷新
 */

import { describe, it, expect } from 'vitest';
import {
  SkyNoteEngine,
  createEmptyCanvasDocument,
  type DocumentChangeSet,
  type LayoutDefinition,
  type LayoutMember,
  type NodeEntity,
  type Point,
  type SkyNotePlugin
} from '@skynote/core';
import {
  BRANCH_CONNECTORS_PLUGIN_ID,
  BranchConnectorsPlugin,
  branchMemberOf,
  readBranchOverride
} from '../src/layout/branch-connectors';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...patch
  };
}

/** 大纲式排版 (测试用)：深度缩进、逐行向下 */
const outline: LayoutDefinition = {
  id: 'test:outline',
  label: '大纲',
  arrange(tree) {
    const positions = new Map<string, Point>();
    let y = 0;
    const visit = (member: LayoutMember): void => {
      if (member.depth > 0) positions.set(member.node.id, { x: member.depth * 40, y });
      y += member.node.height + 10;
      member.children.forEach(visit);
    };
    visit(tree.root);
    return positions;
  },
  edge: () => ({
    router: 'orthogonal',
    fromAnchor: { x: 0, y: 1 },
    toAnchor: { x: 0, y: 0.5 },
    style: { stroke: 'gray' }
  })
};

const outlinePlugin: SkyNotePlugin = {
  id: 'test/outline',
  name: '大纲',
  version: '1.0.0',
  install: (ctx) => ctx.registerLayout(outline)
};

/** 根 root 下：a (含子 a1)、b */
function setup(withLayout = true) {
  const engine = new SkyNoteEngine().use(new BranchConnectorsPlugin());
  if (withLayout) engine.use(outlinePlugin);
  const store = engine.documentStore;
  store.batch(() => {
    store.addNode(makeNode('root', { layout: { type: 'test:outline' } }));
    store.addNode(makeNode('a', { parentId: 'root', zIndex: 'a0', layoutItem: {} }));
    store.addNode(makeNode('a1', { parentId: 'a', zIndex: 'a0', layoutItem: {} }));
    store.addNode(makeNode('b', { parentId: 'root', zIndex: 'a1', layoutItem: {} }));
  });
  const branch = (id: string) => engine.entityStore.getConnector(`@branch:${id}`)?.entity;
  return { engine, store, branch };
}

describe('分支线来源', () => {
  it('每个非根成员一条：父成员连向自己，规格取布局默认；参与路由，但不在文档中', () => {
    const { engine, store, branch } = setup();
    expect(branch('a1')).toMatchObject({
      connectorType: 'orthogonal',
      from: { nodeId: 'a', anchor: { x: 0, y: 1 } },
      to: { nodeId: 'a1', anchor: { x: 0, y: 0.5 } },
      style: { stroke: 'gray' }
    });
    expect(branch('root')).toBeUndefined();
    expect([...engine.entityStore.getConnectorIdsOfNode('a')].sort()).toEqual(['@branch:a', '@branch:a1']);
    expect(engine.getConnectorRoute('@branch:a1')!.points.length).toBeGreaterThanOrEqual(2);
    expect(store.getView().content.connectors).toEqual({});
  });

  it('生效值叠加：整枝设置 (颜色、粗细、虚实、线型) 沿子树继承 (近者优先)，单线设置、箭头与连接点只作用于本条', () => {
    const { store, branch } = setup();
    store.updateNode('a', {
      layoutItem: {
        branch: {
          branchStyle: { stroke: 'red', strokeWidth: 4 },
          branchRouter: 'curved',
          style: { strokeWidth: 1, endArrow: 'arrow' },
          toAnchor: { x: 1, y: 1 }
        }
      }
    });
    // 本条：单线设置优先于整枝设置
    expect(branch('a')).toMatchObject({
      connectorType: 'curved',
      style: { stroke: 'red', strokeWidth: 1, endArrow: 'arrow' }
    });
    const child = branch('a1')!;
    expect(child).toMatchObject({
      connectorType: 'curved',
      style: { stroke: 'red', strokeWidth: 4 },
      to: { anchor: { x: 0, y: 0.5 } }
    });
    expect(child.style!.endArrow).toBeUndefined();

    store.updateNode('a1', { layoutItem: { branch: { branchStyle: { stroke: 'blue' } } } });
    expect(branch('a1')!.style!.stroke).toBe('blue');
    // 单线设置不向下继承
    store.updateNode('a', { layoutItem: { branch: { style: { stroke: 'green' }, router: 'straight' } } });
    expect(branch('a')).toMatchObject({ connectorType: 'straight', style: { stroke: 'green' } });
    expect(branch('a1')).toMatchObject({ connectorType: 'orthogonal', style: { stroke: 'blue' } });
  });

  it('对分支线的修改转写到成员 (与普通连线同样的合并语义)，一步撤销；没有实际变化不产生撤销；不能单独删除', () => {
    const { store, branch } = setup();
    const changes: DocumentChangeSet[] = [];
    store.subscribe((_view, _record, change) => changes.push(change));

    // 直接修改分支线只作用于这一条：写进单线设置
    store.updateConnectors(['@branch:a1'], { style: { endArrow: 'arrow', strokeWidth: 3 } });
    // 端点等几何字段归布局，随同写入也被忽略
    store.updateConnector('@branch:a1', { connectorType: 'straight', to: { nodeId: 'a1', anchor: { x: 1, y: 0 } } });
    expect(store.getNode('a1')!.layoutItem!.branch).toEqual({
      style: { endArrow: 'arrow', strokeWidth: 3 },
      router: 'straight'
    });
    expect(branch('a1')!.to.anchor).toEqual({ x: 0, y: 0.5 });
    expect(branch('a1')).toMatchObject({ connectorType: 'straight', style: { endArrow: 'arrow', strokeWidth: 3 } });
    expect(changes.at(-1)!.connectors.geometry.has('@branch:a1')).toBe(true);

    expect(store.updateConnector('@branch:a1', { style: { strokeWidth: 3 } })).toBeNull();
    store.updateConnector('@branch:a1', { style: { endArrow: undefined } });
    expect(store.getNode('a1')!.layoutItem!.branch).toEqual({ style: { strokeWidth: 3 }, router: 'straight' });
    store.undo();
    store.undo();
    expect(store.getNode('a1')!.layoutItem!.branch).toEqual({ style: { endArrow: 'arrow', strokeWidth: 3 } });

    expect(store.removeEntities({ connectorIds: ['@branch:a1'] })).toBeNull();
    expect(branch('a1')).toBeDefined();
  });

  it('选中成员修改整个分支：写进整枝设置并沿子树继承，去掉本条同名的单线设置；直接改线只影响这一条；一步撤销', () => {
    const { engine, store, branch } = setup();
    const plugin = engine.plugins.get(BRANCH_CONNECTORS_PLUGIN_ID) as BranchConnectorsPlugin;
    // 先单独把 a 的线改成蓝色、a1 的线改成绿色
    store.updateConnector('@branch:a', { style: { stroke: 'blue', endArrow: 'arrow' } });
    store.updateConnector('@branch:a1', { style: { stroke: 'green' } });
    expect(branch('a1')!.style!.stroke).toBe('green');

    plugin.setBranchStyle(['a'], { stroke: 'red', strokeWidth: 4, router: 'curved' });
    expect(store.getNode('a')!.layoutItem!.branch).toEqual({
      style: { endArrow: 'arrow' },
      branchStyle: { stroke: 'red', strokeWidth: 4 },
      branchRouter: 'curved'
    });
    expect(branch('a')).toMatchObject({ connectorType: 'curved', style: { stroke: 'red', strokeWidth: 4 } });
    // 子树中单独设置过的颜色保留，其余沿用整枝设置
    expect(branch('a1')).toMatchObject({ connectorType: 'curved', style: { stroke: 'green', strokeWidth: 4 } });

    // 恢复这条线：清除单线设置，整枝设置保留
    plugin.clearLineStyle(['a']);
    expect(store.getNode('a')!.layoutItem!.branch).toEqual({
      branchStyle: { stroke: 'red', strokeWidth: 4 },
      branchRouter: 'curved'
    });
    expect(branchMemberOf('@branch:a')).toBe('a');
    expect(branchMemberOf('@other:a')).toBeUndefined();
    store.undo();
    store.undo();
    expect(store.getNode('a')!.layoutItem!.branch).toEqual({ style: { stroke: 'blue', endArrow: 'arrow' } });
    // 清除整枝设置中的某项
    plugin.setBranchStyle(['a'], { stroke: 'red' });
    plugin.setBranchStyle(['a'], { stroke: undefined });
    expect(store.getNode('a')!.layoutItem!.branch).toEqual({ style: { endArrow: 'arrow' } });
  });

  it('分支线的端点不能改接 (写入被忽略)；去掉 layoutItem 或删除成员时分支线随之消失', () => {
    const { store, branch } = setup();
    expect(store.updateConnector('@branch:a1', { from: { nodeId: 'b' } })).toBeNull();
    expect(store.getNode('a1')!.parentId).toBe('a');
    expect(branch('a1')!.from.nodeId).toBe('a');

    store.updateNode('a1', { layoutItem: undefined });
    expect(branch('a1')).toBeUndefined();
    store.removeEntities({ nodeIds: ['a'] });
    expect(branch('a')).toBeUndefined();
    store.undo();
    expect(branch('a')).toBeDefined();
  });

  it('复制成员子树带上 layoutItem，不复制分支线；同容器创建副本即成为新成员并有自己的分支线', () => {
    const { store, branch } = setup();
    const payload = store.copyEntities({ nodeIds: ['a'], connectorIds: ['@branch:a1'] })!;
    expect(payload.connectors).toEqual([]);
    expect(payload.nodes.find((n) => n.id === 'a1')!.layoutItem).toEqual({});

    const { nodeIds } = store.duplicateEntities({ nodeIds: ['b'] }, { x: 0, y: 0 });
    expect(branch(nodeIds[0])!.from.nodeId).toBe('root');
  });

  it('读取校验：非法的设置项忽略，合法项照常生效', () => {
    expect(
      readBranchOverride({
        branch: {
          style: 'red',
          router: '',
          toAnchor: { x: 'left' },
          fromAnchor: { x: 1, y: 0 },
          textBlocks: [{ id: 't', runs: 'x', position: 0.5 }]
        }
      })
    ).toEqual({ fromAnchor: { x: 1, y: 0 }, textBlocks: [] });
    expect(readBranchOverride({ branch: [] })).toBeUndefined();
  });

  it('未安装布局时按浮动端直线绘制 (降级可读)；布局晚到时刷新为布局的规格，卸载后回落', () => {
    const doc = createEmptyCanvasDocument();
    doc.content.nodes.root = makeNode('root', { layout: { type: 'test:outline' } });
    doc.content.nodes.a = makeNode('a', { parentId: 'root', layoutItem: {} });
    const engine = new SkyNoteEngine({ initialDoc: doc }).use(new BranchConnectorsPlugin());
    const branch = () => engine.entityStore.getConnector('@branch:a')!.entity;
    expect(branch()).toMatchObject({ connectorType: 'straight', from: { nodeId: 'root' }, to: { nodeId: 'a' } });

    engine.use(outlinePlugin);
    expect(branch()).toMatchObject({ connectorType: 'orthogonal', style: { stroke: 'gray' } });
    engine.plugins.remove('test/outline');
    expect(branch().connectorType).toBe('straight');
  });

  it('根节点设置分支样式：写进根节点的整枝设置，整树现有及新建成员继承，清除后整树恢复默认', () => {
    const { engine, store, branch } = setup();
    const plugin = engine.plugins.get(BRANCH_CONNECTORS_PLUGIN_ID) as BranchConnectorsPlugin;

    // 初始状态：a, a1, b 均取大纲布局默认 (orthogonal, gray)
    expect(branch('a')).toMatchObject({ connectorType: 'orthogonal', style: { stroke: 'gray' } });
    expect(branch('a1')).toMatchObject({ connectorType: 'orthogonal', style: { stroke: 'gray' } });
    expect(branch('b')).toMatchObject({ connectorType: 'orthogonal', style: { stroke: 'gray' } });

    // 选中根节点修改分支样式：写进 root.layoutItem.branch
    plugin.setBranchStyle(['root'], { stroke: 'purple', strokeWidth: 5, router: 'curved' });
    expect(store.getNode('root')!.layoutItem?.branch).toEqual({
      branchStyle: { stroke: 'purple', strokeWidth: 5 },
      branchRouter: 'curved'
    });

    // 现有节点全部继承
    expect(branch('a')).toMatchObject({ connectorType: 'curved', style: { stroke: 'purple', strokeWidth: 5 } });
    expect(branch('a1')).toMatchObject({ connectorType: 'curved', style: { stroke: 'purple', strokeWidth: 5 } });
    expect(branch('b')).toMatchObject({ connectorType: 'curved', style: { stroke: 'purple', strokeWidth: 5 } });

    // 随后新建子节点 c，同样直接继承根节点分支样式，绝不会退回到默认灰色
    store.addNode(makeNode('c', { parentId: 'root', zIndex: 'a2', layoutItem: {} }));
    expect(branch('c')).toMatchObject({ connectorType: 'curved', style: { stroke: 'purple', strokeWidth: 5 } });

    // 某个子分支 a 单独覆盖自己的分支颜色，优先于根节点继承值
    plugin.setBranchStyle(['a'], { stroke: 'orange' });
    expect(branch('a')!.style!.stroke).toBe('orange');
    expect(branch('a1')!.style!.stroke).toBe('orange');
    expect(branch('b')!.style!.stroke).toBe('purple');

    // 根节点清除分支样式：整树（除了单独覆盖的 a）恢复布局默认
    plugin.clearBranchStyle(['root']);
    expect(store.getNode('root')!.layoutItem).toBeUndefined();
    expect(branch('b')).toMatchObject({ connectorType: 'orthogonal', style: { stroke: 'gray' } });
    expect(branch('a')!.style!.stroke).toBe('orange');
  });
});

