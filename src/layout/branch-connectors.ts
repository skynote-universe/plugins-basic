/**
 * @file branch-connectors.ts
 * @description 布局树分支线 (ADR-130)：每个非根成员一条父成员连向自己的派生连线，设置存在成员的 layoutItem.branch
 *
 * 设计考量 (Why):
 * 1. 单一事实源：文档里没有分支连线实体，线由成员关系推导；删除、改挂、复制、撤销、协同都无需同步。
 * 2. 设置与普通连线一致：本条设置的各项类型都复用连线 (样式、线型、连接点、线上文字)，呈现走普通连线的整套管线。
 * 3. 设置分两份：整枝设置 (branchStyle / branchRouter，颜色、粗细、虚实与线型) 作用于本条并沿子树继承，
 *    单线设置 (style / router) 只作用于本条。生效值：布局的 edge() 默认 < 祖先的整枝设置 (近者优先)
 *    < 本条整枝设置 < 本条单线设置；箭头、连接点与线上文字只作用于本条。后加入的子成员自动沿用祖先的整枝设置。
 * 4. 两份设置由两种操作写入：直接修改分支线 (选中连线时的工具栏) 只改这一条，写进单线设置；
 *    选中成员时经 setBranchStyle 修改整个分支，写进整枝设置。写进文档的都是普通补丁，撤销与协同不受影响。
 * 5. layoutItem 的各键是不可信输入 (内核只保证是纯数据)：这里逐项校验，非法项忽略，不写回文档。
 * 6. 分支线在布局根的坐标系中布线 (routeFrame)：布局按根的局部坐标排列成员，线也在同一坐标系中出线，
 *    根旋转或放进旋转的容器时线与主题一起旋转。
 * 7. 没有安装对应布局 (如商业导图插件) 时按浮动端直线绘制：内容完整可读，只是不能自动排版。
 */

import {
  areStructuredValuesEqual,
  buildLayoutTree,
  derivedConnectorId,
  findMemberRootId,
  sanitizeRichTextRuns,
  sortSiblingsByLayer,
  type LayoutEdgeSpec,
  type CanvasPatch,
  type CommandOptions,
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

/** 分支线设置 (存于成员的 layoutItem.branch)，各项类型与普通连线一致 */
export interface BranchOverride {
  /** 只作用于本条线的样式 (优先于整枝设置) */
  style?: ConnectorStyle;
  /** 只作用于本条线的路由器 id (线型) */
  router?: string;
  /** 整个分支：本条线与子树中的分支线沿用的可继承样式 (颜色、粗细、虚实) */
  branchStyle?: ConnectorStyle;
  /** 整个分支沿用的路由器 id */
  branchRouter?: string;
  /** 父成员一端的连接点 (按宽高归一化) */
  fromAnchor?: Point;
  /** 本成员一端的连接点 (按宽高归一化) */
  toAnchor?: Point;
  textBlocks?: ConnectorTextBlock[];
}

export const BRANCH_SOURCE_ID = 'branch';
export const BRANCH_CONNECTORS_PLUGIN_ID = '@skynote/plugins-basic/branch-connectors';

/** 分支线对应的成员 id (线由父成员连向它)；不是分支线时为 undefined */
export function branchMemberOf(connectorId: string): string | undefined {
  const prefix = derivedConnectorId(BRANCH_SOURCE_ID, '');
  return connectorId.startsWith(prefix) ? connectorId.slice(prefix.length) : undefined;
}

/** 修改分支线样式的作用范围：整个分支 (可继承项沿子树生效) 或仅此线 */
export type BranchWriteScope = 'branch' | 'line';

/** 这些字段变化会改变成员关系或分支设置 (沿子树继承)，需要重算该节点及其后代 */
const BRANCH_FIELDS: ReadonlySet<string> = new Set(['layout', 'layoutItem', 'parentId', 'zIndex']);
/** 沿子树向下继承的样式项 */
const INHERITED_STYLE_KEYS = ['stroke', 'strokeWidth', 'strokeDashArray'] as const;
/** 布局未注册或未给出规格时：浮动端直线 */
const FALLBACK_BRANCH: LayoutEdgeSpec = { router: 'straight' };

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

/** 读取成员的分支线设置：逐项校验，非法项忽略 */
export function readBranchOverride(item: Readonly<Record<string, unknown>>): BranchOverride | undefined {
  const raw = item.branch;
  if (!isRecord(raw)) return undefined;
  const textBlocks = Array.isArray(raw.textBlocks)
    ? raw.textBlocks.map(sanitizeTextBlock).filter((block): block is ConnectorTextBlock => block !== null)
    : undefined;
  return {
    ...(isRecord(raw.style) && { style: raw.style as ConnectorStyle }),
    ...(typeof raw.router === 'string' && raw.router.length > 0 && { router: raw.router }),
    ...(isRecord(raw.branchStyle) && { branchStyle: pickInherited(raw.branchStyle as ConnectorStyle) }),
    ...(typeof raw.branchRouter === 'string' && raw.branchRouter.length > 0 && { branchRouter: raw.branchRouter }),
    ...(isPoint(raw.fromAnchor) && { fromAnchor: raw.fromAnchor }),
    ...(isPoint(raw.toAnchor) && { toAnchor: raw.toAnchor }),
    ...(textBlocks && { textBlocks })
  };
}

/** 只保留可继承的样式项 */
function pickInherited(style: ConnectorStyle): ConnectorStyle {
  return Object.fromEntries(INHERITED_STYLE_KEYS.filter((key) => key in style).map((key) => [key, style[key]]));
}

/** 成员通向父成员的分支线 (布局默认 < 祖先整枝 < 本条整枝 < 本条单线) */
export function deriveBranchConnector(member: LayoutMember, spec: LayoutEdgeSpec | undefined): DerivedConnector {
  const parent = member.parent!;
  const base = spec ?? FALLBACK_BRANCH;
  const inherited: Record<string, unknown> = {};
  let inheritedRouter: string | undefined;
  for (let ancestor: LayoutMember | undefined = parent; ancestor; ancestor = ancestor.parent) {
    const branch = readBranchOverride(ancestor.item);
    if (!branch) continue;
    inheritedRouter ??= branch.branchRouter;
    for (const key of INHERITED_STYLE_KEYS) {
      if (!(key in inherited) && branch.branchStyle?.[key] !== undefined) inherited[key] = branch.branchStyle[key];
    }
  }
  const own = readBranchOverride(member.item);
  let root = parent;
  while (root.parent) root = root.parent;
  const fromAnchor = own?.fromAnchor ?? base.fromAnchor;
  const toAnchor = own?.toAnchor ?? base.toAnchor;
  return {
    connectorType: own?.router ?? own?.branchRouter ?? inheritedRouter ?? base.router,
    from: fromAnchor ? { nodeId: parent.node.id, anchor: fromAnchor } : { nodeId: parent.node.id },
    to: toAnchor ? { nodeId: member.node.id, anchor: toAnchor } : { nodeId: member.node.id },
    zIndex: member.node.zIndex,
    locked: false,
    // 在布局根的坐标系中布线：整张图旋转或放进旋转的容器时，线随之旋转
    routeFrame: root.node.id,
    style: { ...base.style, ...(inherited as ConnectorStyle), ...own?.branchStyle, ...own?.style },
    ...(own?.textBlocks && { textBlocks: own.textBlocks })
  };
}

/** 去掉值为 undefined 的键 (与普通连线一样，显式传 undefined 表示清除该项) */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * 把对分支线的修改 (与普通连线同样的字段与合并语义) 映射为分支线设置：样式、线型 (router) 与线上文字
 * 整个分支：可继承项与线型写进整枝设置，并去掉单线设置中的同名项 (让新值在本条生效)，其余样式项 (箭头等) 只作用于本条；
 * 仅此线：全部写进单线设置。端点、拐点、锁定与层级等几何与结构字段归布局，忽略
 * @returns 新的分支线设置；undefined 表示清空
 */
export function mapBranchWrite(
  current: BranchOverride | undefined,
  partial: Partial<ConnectorEntity>,
  merge: boolean,
  scope: BranchWriteScope
): BranchOverride | undefined {
  const next: BranchOverride = { ...current };
  if ('style' in partial && partial.style === undefined) {
    // 清空样式：仅此线只清单线设置，整个分支连整枝设置一并清除
    delete next.style;
    if (scope === 'branch') delete next.branchStyle;
  } else if ('style' in partial) {
    const requested = partial.style!;
    const shared = scope === 'branch' ? pickInherited(requested) : {};
    const lineOnly = Object.fromEntries(Object.entries(requested).filter(([key]) => !(key in shared)));
    const kept = Object.fromEntries(
      Object.entries((merge && current?.style) || {}).filter(([key]) => !(key in shared))
    );
    next.style = withoutUndefined({ ...kept, ...lineOnly });
    if (scope === 'branch') {
      next.branchStyle = withoutUndefined(merge ? { ...current?.branchStyle, ...shared } : shared);
    }
  }
  if ('connectorType' in partial) {
    if (scope === 'branch') {
      next.branchRouter = partial.connectorType;
      delete next.router;
    } else {
      next.router = partial.connectorType;
    }
  }
  if ('textBlocks' in partial) next.textBlocks = partial.textBlocks;
  const branch = withoutUndefined(next);
  if (branch.style && Object.keys(branch.style).length === 0) delete branch.style;
  if (branch.branchStyle && Object.keys(branch.branchStyle).length === 0) delete branch.branchStyle;
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
      const definition = this.ctx.layouts.get(tree.root.node.layout!.type);
      // 已安装的容器布局 (如 stack) 未声明树边 edge() 时不派生分支连线；未安装的布局仍按浮动端直线降级绘制
      if (definition && !definition.edge) {
        result.set(id, undefined);
        continue;
      }
      const spec = definition?.edge?.(member, tree);
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
    // 直接修改分支线只作用于这一条；整个分支经 BranchConnectorsPlugin.setBranchStyle 修改
    const branch = mapBranchWrite(previous, partial, merge, 'line');
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
  readonly id = BRANCH_CONNECTORS_PLUGIN_ID;
  readonly name = '布局分支线';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerConnectorSource(new BranchConnectorSource(ctx));
    ctx.layouts.onChange(() => ctx.refreshConnectorSource(BRANCH_SOURCE_ID));
  }

  /**
   * 修改整个分支的样式 (界面选中成员时用)：颜色、粗细、虚实与线型写进成员的整枝设置，作用于它通向父成员的线
   * 并沿子树继承；同时去掉这条线上的同名单线设置，让新值生效 (子树中单独设置过的线保留)。一步撤销
   * @param patch 显式传 undefined 的项表示清除
   */
  setBranchStyle(
    memberIds: Iterable<string>,
    patch: ConnectorStyle & { router?: string },
    options?: CommandOptions
  ): void {
    const { router, ...style } = patch;
    const partial: Partial<ConnectorEntity> = { style, ...('router' in patch && { connectorType: router }) };
    this.updateBranches(memberIds, (previous) => mapBranchWrite(previous, partial, true, 'branch'), {
      label: '设置分支样式',
      ...options
    });
  }

  /**
   * 清除分支线的样式设置，回到布局默认 (如导图主题的线色)：keys 缺省时清除整枝与单线的全部样式和线型，
   * 给出时只清除这些样式项 (如切换导图主题时只清颜色与粗细)；线上文字与连接点保留。一步撤销
   */
  clearBranchStyle(
    memberIds: Iterable<string>,
    keys?: readonly (keyof ConnectorStyle)[],
    options?: CommandOptions
  ): void {
    const strip = (style: ConnectorStyle | undefined): ConnectorStyle | undefined => {
      if (!style || !keys) return undefined;
      const rest = Object.fromEntries(
        Object.entries(style).filter(([key]) => !keys.includes(key as keyof ConnectorStyle))
      );
      return Object.keys(rest).length > 0 ? rest : undefined;
    };
    this.updateBranches(
      memberIds,
      (previous) => {
        if (!previous) return undefined;
        const { style, branchStyle, router, branchRouter, ...kept } = previous;
        return withoutUndefined({
          ...kept,
          style: strip(style),
          branchStyle: strip(branchStyle),
          ...(keys && { router, branchRouter })
        });
      },
      { label: '清除分支样式', ...options }
    );
  }

  /**
   * 清除这些线单独的设置 (单线样式与线型)，回到所在分支与布局的样式 (界面选中分支线时的「恢复默认」)；
   * 整枝设置 (影响下级分支)、线上文字与连接点保留。一步撤销
   */
  clearLineStyle(memberIds: Iterable<string>, options?: CommandOptions): void {
    this.updateBranches(
      memberIds,
      (previous) => {
        if (!previous) return undefined;
        const { style: _style, router: _router, ...kept } = previous;
        return kept;
      },
      { label: '恢复默认样式', ...options }
    );
  }

  /** 按 next 改写各成员的分支线设置 (空设置即去掉)；没有实际变化的成员不产生补丁 */
  private updateBranches(
    memberIds: Iterable<string>,
    next: (previous: BranchOverride | undefined) => BranchOverride | undefined,
    options: CommandOptions
  ): void {
    this.ctx.document.updateNodes(
      memberIds,
      (node) => {
        const layoutItem = node.layoutItem ?? {};
        const previous = readBranchOverride(layoutItem);
        const result = next(previous);
        const branch = result && Object.keys(result).length > 0 ? result : undefined;
        if (areStructuredValuesEqual(branch, previous)) return {};
        const { branch: _previous, ...item } = layoutItem;
        // 布局成员必须保留 layoutItem；树根节点若 item 为空且 branch 也清空则恢复为 undefined
        const nextLayoutItem = branch
          ? { ...item, branch }
          : node.parentId !== undefined || Object.keys(item).length > 0
            ? item
            : undefined;
        return { layoutItem: nextLayoutItem };
      },
      options
    );
  }
}
