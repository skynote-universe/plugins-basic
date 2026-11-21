import {
  AssetAdapterError,
  createTextBlockPrimitive,
  getPlainText,
  measureSingleLineHeight,
  parseWebUrl,
  resolveNodeStyle,
  resolveTextBlockStyle,
  resolveTextPadding,
  type AssetTaskResult,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeTypeDefinition,
  type RectBounds,
  type TextBlock,
  type TextPrimitive,
  type UpdateNodesAssetTaskOptions
} from '@skynote/core';

const TITLE_SLOT = 'title';
const TITLE_STYLE = { fontSize: 14, lineHeight: 1.4, textWrap: 'none', textOverflow: 'ellipsis' } as const;
const TITLE_GAP = 4;
const TITLE_HEIGHT = Math.ceil(TITLE_STYLE.fontSize * TITLE_STYLE.lineHeight);

export interface WebLinkFields {
  readonly url: string;
  readonly displayMode?: 'card' | 'preview';
  readonly coverAssetId?: string;
}

export interface WebLinkCreateOptions extends WebLinkFields {
  readonly title?: string;
}

export function getWebLinkTitleBlock(node: Readonly<NodeEntity>): TextBlock | undefined {
  return node.textBlocks?.find((block) => block.slot === TITLE_SLOT);
}

export function getWebLinkTitle(node: Readonly<NodeEntity>): string {
  const block = getWebLinkTitleBlock(node);
  return block ? getPlainText(block) : '';
}

export function createWebLinkTitleBlock(title: string): TextBlock {
  return { id: TITLE_SLOT, slot: TITLE_SLOT, runs: [{ text: title }] };
}

declare module '@skynote/core' {
  interface CustomNodeFields {
    webLink?: WebLinkFields;
  }
  interface NodeCreateOptionsMap {
    'web-link': WebLinkCreateOptions;
  }
}

export class WebLinkNodeType implements NodeTypeDefinition {
  readonly type = 'web-link';
  readonly label = '网页链接';
  readonly defaultData = {};
  readonly defaultStyle = { strokeWidth: 1, radius: 12 };
  readonly slots = [{ slot: TITLE_SLOT, label: '标题', singleLine: true, defaultStyle: TITLE_STYLE }];

  supportsCornerRadius(): boolean {
    return true;
  }

  extent(node: NodeEntity): RectBounds {
    return { left: 0, top: -(this.titleHeight(node) + TITLE_GAP), right: node.width, bottom: node.height };
  }

  private titleHeight(node: NodeEntity): number {
    const title = getWebLinkTitleBlock(node);
    if (!title) return TITLE_HEIGHT;
    const style = resolveTextBlockStyle(node, title, this);
    const padding = resolveTextPadding(style.padding);
    return Math.ceil(measureSingleLineHeight(title.runs, style) + padding.top + padding.bottom);
  }

  composeTextBlock(node: NodeEntity, _context: NodeComposeContext, blockId: string): TextPrimitive | undefined {
    const title = getWebLinkTitleBlock(node);
    if (!title || title.id !== blockId) return undefined;
    return this.titlePrimitive(node, title);
  }

  private titlePrimitive(node: NodeEntity, block: TextBlock): TextPrimitive {
    const height = this.titleHeight(node);
    return createTextBlockPrimitive(block, resolveTextBlockStyle(node, block, this), {
      x: 0,
      y: -(height + TITLE_GAP),
      width: node.width,
      height
    });
  }

  readonly assets = {
    collect(node: Readonly<NodeEntity>): readonly string[] {
      return node.webLink?.coverAssetId ? [node.webLink.coverAssetId] : [];
    },
    remap(node: Readonly<NodeEntity>, ids: ReadonlyMap<string, string>): { webLink?: WebLinkFields } {
      const webLink = node.webLink;
      if (!webLink?.coverAssetId) return {};
      const coverAssetId = ids.get(webLink.coverAssetId);
      if (!coverAssetId) throw new AssetAdapterError('invalid-reference', '缺少网页封面资产映射');
      return { webLink: { ...webLink, coverAssetId } };
    }
  };

  createContent({ url, title, displayMode, coverAssetId }: WebLinkCreateOptions): NodeCreateContent {
    const address = parseWebUrl(url);
    if (!address) throw new Error('请输入有效的 HTTP 或 HTTPS 网页链接');
    const label = title?.trim().slice(0, 120);
    return {
      width: 420,
      height: 260,
      textBlocks: [createWebLinkTitleBlock(label ?? '')],
      webLink: {
        url: address.href,
        ...(displayMode === 'preview' && { displayMode }),
        ...(coverAssetId && { coverAssetId })
      }
    };
  }

  validate({ webLink }: Readonly<NodeEntity>): string | null {
    if (!webLink || !parseWebUrl(webLink.url)) return '网页链接无效';
    if (webLink.displayMode !== undefined && webLink.displayMode !== 'card' && webLink.displayMode !== 'preview')
      return '网页链接展示方式无效';
    if (webLink.coverAssetId !== undefined && (typeof webLink.coverAssetId !== 'string' || !webLink.coverAssetId))
      return '网页封面资产引用无效';
    return null;
  }

  compose(node: NodeEntity, { theme }: NodeComposeContext): CanvasPrimitive[] {
    const { width, height, webLink } = node;
    const style = resolveNodeStyle(node, this);
    const url = parseWebUrl(webLink?.url);
    const cover = webLink?.coverAssetId;
    const fill = typeof style.fill === 'string' ? style.fill : cover ? theme.nodeFill : theme.placeholderFill;
    const background: CanvasPrimitive = {
      kind: 'rect',
      x: 0,
      y: 0,
      width,
      height,
      fill,
      stroke: style.stroke ?? theme.nodeStroke,
      strokeWidth: style.strokeWidth,
      radius: style.radius,
      fillOpacity: style.fillOpacity,
      strokeOpacity: style.strokeOpacity,
      strokeDashArray: style.strokeDashArray
    };
    const primitives: CanvasPrimitive[] = [background];
    if (cover) {
      primitives.push({
        kind: 'image',
        x: 0,
        y: 0,
        width,
        height,
        assetId: cover,
        fit: 'cover',
        radius: style.radius
      });
    } else {
      const unit = Math.min(width / 48, height / 48, 2.5);
      const left = width / 2 - 12 * unit;
      const top = height / 2 - 9 * unit;
      const stroke = {
        stroke: theme.textColor,
        strokeOpacity: 0.48,
        strokeWidth: 1.4 * unit
      };
      // 浏览器窗口与风景图标共用画布主题，随节点缩小并保持居中。
      const mountain = `l ${5 * unit} ${-5 * unit} ${3 * unit} ${3 * unit} ${3 * unit} ${-2 * unit} ${5 * unit} ${4 * unit}`;
      primitives.push(
        { kind: 'rect', x: left, y: top, width: 24 * unit, height: 18 * unit, radius: 2 * unit, ...stroke },
        {
          kind: 'path',
          d: `M ${left} ${top + 5 * unit} h ${24 * unit} M ${left + 4 * unit} ${top + 14 * unit} ${mountain}`,
          ...stroke,
          strokeCap: 'round',
          strokeJoin: 'round'
        }
      );
    }
    const block = getWebLinkTitleBlock(node);
    const title = getWebLinkTitle(node).trim();
    const fallback = title || url?.href || '无效的网页链接';
    const visibleBlock =
      block && title ? block : { ...(block ?? createWebLinkTitleBlock('')), runs: [{ text: fallback }] };
    primitives.push(this.titlePrimitive(node, visibleBlock));
    return primitives;
  }
}

export interface WebLinkAssetTaskHost {
  updateNodesWithAssetTask(options: UpdateNodesAssetTaskOptions): Promise<AssetTaskResult<readonly string[]>>;
}

/** 准备并上传网页链接节点的封面资产，在同一次可撤销事务中登记并切换封面引用 */
export async function setWebLinkCoverAsset(
  host: WebLinkAssetTaskHost,
  nodeId: string,
  prepare: (signal: AbortSignal) => unknown | Promise<unknown>,
  signal?: AbortSignal
): Promise<AssetTaskResult<string>> {
  const result = await host.updateNodesWithAssetTask({
    nodeIds: [nodeId],
    label: '设置网页封面',
    signal,
    getTargetSignature: (node) =>
      node.nodeType === 'web-link' && node.webLink
        ? JSON.stringify([node.webLink.url, node.webLink.coverAssetId])
        : undefined,
    prepare: async (upload, taskSignal) => {
      const file = await prepare(taskSignal);
      const cover = await upload({ file, mimePrefix: 'image/' });
      return {
        assets: [cover],
        update: (node) => (node.webLink ? { webLink: { ...node.webLink, coverAssetId: cover.id } } : {})
      };
    }
  });
  return result.status === 'succeeded' ? { status: 'succeeded', value: result.value[0] } : result;
}
