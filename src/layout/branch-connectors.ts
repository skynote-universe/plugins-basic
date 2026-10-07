/**
 * @file branch-connectors.ts
 * @description 布局树分支线 (ADR-130)：每个非根成员一条父成员连向自己的派生连线，设置存在成员的 layoutItem.branch
 *
 * 设计考量 (Why):
 * 1. 单一事实源：文档里没有分支连线实体，线由成员关系推导；删除、改挂、复制、撤销、协同都无需同步。
 * 2. 设置与普通连线一致：本条设置的各项类型都复用连线 (样式、线型、连接点、线上文字)，呈现走普通连线的整套管线。
 * 3. 生效值三层叠加：布局的 branch() 默认 < 祖先分支的可继承项 (颜色、粗细、虚实、线型，近者优先) < 本条设置；
 *    箭头、连接点与线上文字只作用于本条。后加入的子成员自动沿用祖先的设置。
 * 4. layoutItem 的各键是不可信输入 (内核只保证是纯数据)：这里逐项校验，非法项忽略，不写回文档。
 * 5. 没有安装对应布局 (如商业导图插件) 时按浮动端直线绘制：内容完整可读，只是不能自动排版。
 */

import {
  areStructuredValuesEqual,
  buildLayoutTree,
  findMemberRootId,
  sanitizeRichTextRuns,
  sortSiblingsByLayer,
  type BranchSpec,
  type CanvasPatch,
  type CanvasPluginContext,
  type ConnectorEntity,
  type ConnectorStyle,
  type ConnectorTextBlock,
  type DerivedConnector,
  type DerivedConnectorSource,
  type DerivedSourceChanges,
  type LayoutMember,
  type LayoutTree,
  type NodeEntity,
  type Point,
  type SkyNotePlugin
} from '@skynote/core';

/** 分支线的本条设置 (存于成员的 layoutItem.branch)，各项类型与普通连线一致 */
export interface BranchOverride {
  style?: ConnectorStyle;
  /** 路由器 id (线型) */
  router?: string;
  /** 父成员一端的连接点 (按宽高归一化) */
  fromAnchor?: Point;
  /** 本成员一端的连接点 (按宽高归一化) */
  toAnchor?: Point;
  textBlocks?: ConnectorTextBlock[];
}

export const BRANCH_SOURCE_ID = 'branch';

/** 这些字段变化会改变成员关系或分支设置 (沿子树继承)，需要重算该节点及其后代 */
const BRANCH_FIELDS: ReadonlySet<string> = new Set(['layout', 'layoutItem', 'parentId', 'zIndex']);
/** 沿子树向下继承的样式项 */
const INHERITED_STYLE_KEYS = ['stroke', 'strokeWidth', 'strokeDashArray'] as const;
/** 布局未注册或未给出规格时：浮动端直线 */
const FALLBACK_BRANCH: BranchSpec = { router: 'straight' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPoint = (value: unknown): value is Point =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);

function sanitizeTextBlock(value: unknown): ConnectorTextBlock | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isFiniteNumber(value.position)) return null;
  const runs = sanitizeRichTextRuns(value.runs);
  if (!runs) return null;
  return {
    id: value.id,
    runs,
    position: Math.min(1, Math.max(0, value.position)),
    ...(isFiniteNumber(value.offsetX) && { offsetX: value.offsetX }),
    ...(isFiniteNumber(value.offsetY) && { offsetY: value.offsetY }),
    ...(isRecord(value.style) && { style: value.style })
  };
}

/** 读取成员的本条设置：逐项校验，非法项忽略 */
export function readBranchOverride(item: Readonly<Record<string, unknown>>): BranchOverride | undefined {
  const raw = item.branch;
  if (!isRecord(raw)) return undefined;
  const textBlocks = Array.isArray(raw.textBlocks)
    ? raw.textBlocks.map(sanitizeTextBlock).filter((block): block is ConnectorTextBlock => block !== null)
    : undefined;
  return {
    ...(isRecord(raw.style) && { style: raw.style as ConnectorStyle }),
    ...(typeof raw.router === 'string' && raw.router.length > 0 && { router: raw.router }),
    ...(isPoint(raw.fromAnchor) && { fromAnchor: raw.fromAnchor }),
    ...(isPoint(raw.toAnchor) && { toAnchor: raw.toAnchor }),
    ...(textBlocks && { textBlocks })
  };
}

/** 成员通向父成员的分支线 (三层叠加后的生效值) */
export function deriveBranchConnector(member: LayoutMember, spec: BranchSpec | undefined): DerivedConnector {
  const parent = member.parent!;
  const base = spec ?? FALLBACK_BRANCH;
  const inherited: Record<string, unknown> = {};
  let inheritedRouter: string | undefined;
  for (let ancestor: LayoutMember | undefined = parent; ancestor?.parent; ancestor = ancestor.parent) {
    const branch = readBranchOverride(ancestor.item);
    if (!branch) continue;
    inheritedRouter ??= branch.router;
    for (const key of INHERITED_STYLE_KEYS) {
      if (!(key in inherited) && branch.style?.[key] !== undefined) inherited[key] = branch.style[key];
    }
  }
  const own = readBranchOverride(member.item);
  const fromAnchor = own?.fromAnchor ?? base.fromAnchor;
  const toAnchor = own?.toAnchor ?? base.toAnchor;
  return {
    connectorType: own?.router ?? inheritedRouter ?? base.router,
    from: fromAnchor ? { nodeId: parent.node.id, anchor: fromAnchor } : { nodeId: parent.node.id },
    to: toAnchor ? { nodeId: member.node.id, anchor: toAnchor } : { nodeId: member.node.id },
    zIndex: member.node.zIndex,
    locked: false,
    style: { ...base.style, ...(inherited as ConnectorStyle), ...own?.style },
    ...(own?.textBlocks && { textBlocks: own.textBlocks })
  };
}

/** 去掉值为 undefined 的键 (与普通连线一样，显式传 undefined 表示清除该项) */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * 把对分支线的修改 (与普通连线同样的字段与合并语义) 映射为本条设置：样式、线型 (router) 与线上文字
 * 端点、拐点、锁定与层级等几何与结构字段归布局，忽略 (界面也不提供分支线的端点与拐点拖拽)
 * @returns 新的本条设置；undefined 表示清空
 */
export function mapBranchWrite(
  current: BranchOverride | undefined,
  partial: Partial<ConnectorEntity>,
  merge: boolean
): BranchOverride | undefined {
  const next: BranchOverride = { ...current };
  if ('style' in partial) {
    next.style = partial.style && withoutUndefined(merge ? { ...current?.style, ...partial.style } : partial.style);
  }
  if ('connectorType' in partial) next.router = partial.connectorType;
  if ('textBlocks' in partial) next.textBlocks = partial.textBlocks;
  const branch = withoutUndefined(next);
  if (branch.style && Object.keys(branch.style).length === 0) delete branch.style;
  return Object.keys(branch).length > 0 ? branch : undefined;
}

/** 分支线来源：键为成员节点 id */
class BranchConnectorSource implements DerivedConnectorSource {
  readonly id = BRANCH_SOURCE_ID;

  constructor(private readonly ctx: CanvasPluginContext) {}

  /** 成员关系与分支设置沿子树传递：相关字段变化或节点增删时重算该节点及其后代；拖动等提交返回空 */
  collect(changes: DerivedSourceChanges): Set<string> {
    const keys = new Set<string>();
    for (const [id, change] of changes.nodes) {
      if (change !== 'entity' && ![...change].some((field) => BRANCH_FIELDS.has(field))) continue;
      keys.add(id);
      for (const descendantId of this.ctx.entities.collectDescendantIds(id)) keys.add(descendantId);
    }
    return keys;
  }

  derive(keys: Iterable<string> | null): Map<string, DerivedConnector | undefined> {
    const ids = keys ?? this.ctx.entities.getAllNodes().map((runtime) => runtime.entity.id);
    const trees = new Map<string, LayoutTree>();
    const result = new Map<string, DerivedConnector | undefined>();
    for (const id of ids) {
      const member = this.memberOf(id, trees);
      if (!member) {
        result.set(id, undefined);
        continue;
      }
      const tree = trees.get(findMemberRootId(id, this.getNode)!)!;
      const spec = this.ctx.layouts.get(tree.root.node.layout!.type)?.branch?.(member, tree);
      result.set(id, deriveBranchConnector(member, spec));
    }
    return result;
  }

  write(
    key: string,
    _current: Readonly<ConnectorEntity>,
    partial: Partial<ConnectorEntity>,
    merge: boolean
  ): CanvasPatch[] {
    const node = this.getNode(key);
    if (!node?.layoutItem) return [];
    const previous = readBranchOverride(node.layoutItem);
    const branch = mapBranchWrite(previous, partial, merge);
    // 没有实际变化时不写补丁，避免多出一步空的撤销
    if (areStructuredValuesEqual(branch, previous)) return [];
    const path = ['content', 'nodes', key, 'layoutItem', 'branch'];
    return [branch ? { op: 'set', path, value: branch } : { op: 'unset', path }];
  }

  private readonly getNode = (id: string): Readonly<NodeEntity> | undefined => this.ctx.document.getNode(id);

  private readonly childrenOf = (parentId: string): Readonly<NodeEntity>[] =>
    sortSiblingsByLayer([...this.ctx.entities.getChildIds(parentId)].map((id) => this.getNode(id)!));

  /** 节点作为非根成员时的视图 (同一批推导共用建好的树) */
  private memberOf(id: string, trees: Map<string, LayoutTree>): LayoutMember | undefined {
    const rootId = findMemberRootId(id, this.getNode);
    if (rootId === undefined) return undefined;
    let tree = trees.get(rootId);
    if (!tree) {
      const root = this.getNode(rootId)!;
      tree = buildLayoutTree(root, this.childrenOf, this.ctx.layouts.get(root.layout!.type));
      trees.set(rootId, tree);
    }
    return tree.get(id);
  }
}

/** 分支线插件：注册分支线来源，布局注册表变化 (如导图插件晚到或卸载) 时全量刷新 */
export class BranchConnectorsPlugin implements SkyNotePlugin {
  readonly id = '@skynote/plugins-basic/branch-connectors';
  readonly name = '布局分支线';
  readonly version = '0.1.0';

  install(ctx: CanvasPluginContext): void {
    ctx.registerConnectorSource(new BranchConnectorSource(ctx));
    ctx.layouts.onChange(() => ctx.refreshConnectorSource(BRANCH_SOURCE_ID));
  }
}
