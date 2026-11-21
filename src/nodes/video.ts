import {
  AssetAdapterError,
  type AssetTaskResult,
  type AssetUploader,
  type CanvasAssetMeta,
  type CanvasPrimitive,
  type CreateNodeAssetTaskOptions,
  type NodeCreateContent,
  type NodeEntity,
  type NodeTypeDefinition,
  type Point,
  type UpdateNodesAssetTaskOptions
} from '@skynote/core';

export type VideoDisplayMode = 'card' | 'preview';

export interface VideoNodeFields {
  assetId: string;
  posterAssetId?: string;
  /** 缺省时使用封面卡片。 */
  displayMode?: VideoDisplayMode;
}

export interface VideoCreateOptions extends VideoNodeFields {
  intrinsicWidth?: number;
  intrinsicHeight?: number;
}

declare module '@skynote/core' {
  interface CustomNodeFields {
    video?: VideoNodeFields;
  }
  interface NodeCreateOptionsMap {
    video: VideoCreateOptions;
  }
}

function requireVideo(node: Readonly<NodeEntity>): VideoNodeFields {
  const video = node.video;
  if (
    !video ||
    typeof video.assetId !== 'string' ||
    !video.assetId ||
    (video.posterAssetId !== undefined && (typeof video.posterAssetId !== 'string' || !video.posterAssetId))
  ) {
    throw new AssetAdapterError('invalid-reference', '视频资产引用无效');
  }
  return video;
}

export class VideoNodeType implements NodeTypeDefinition {
  readonly type = 'video';
  readonly label = '视频';
  readonly defaultData = {};
  readonly defaultAspectLocked = true;

  supportsCornerRadius(): boolean {
    return true;
  }

  validate({ video }: Readonly<NodeEntity>): string | null {
    if (!video || typeof video.assetId !== 'string' || !video.assetId) return '视频资产引用无效';
    if (video.posterAssetId !== undefined && (typeof video.posterAssetId !== 'string' || !video.posterAssetId))
      return '视频封面资产引用无效';
    if (video.displayMode !== undefined && video.displayMode !== 'card' && video.displayMode !== 'preview')
      return '视频展示方式无效';
    return null;
  }

  readonly assets = {
    collect(node: Readonly<NodeEntity>): readonly string[] {
      const { assetId, posterAssetId } = requireVideo(node);
      return posterAssetId ? [assetId, posterAssetId] : [assetId];
    },
    remap(node: Readonly<NodeEntity>, ids: ReadonlyMap<string, string>): { video: VideoNodeFields } {
      const video = requireVideo(node);
      const assetId = ids.get(video.assetId);
      const posterAssetId = video.posterAssetId ? ids.get(video.posterAssetId) : undefined;
      if (!assetId || (video.posterAssetId && !posterAssetId))
        throw new AssetAdapterError('invalid-reference', '缺少视频或封面资产映射');
      return { video: { ...video, assetId, ...(posterAssetId && { posterAssetId }) } };
    }
  };

  createContent({
    assetId,
    posterAssetId,
    displayMode,
    intrinsicWidth,
    intrinsicHeight
  }: VideoCreateOptions): NodeCreateContent {
    const width = intrinsicWidth && Number.isFinite(intrinsicWidth) && intrinsicWidth > 0 ? intrinsicWidth : 480;
    const height = intrinsicHeight && Number.isFinite(intrinsicHeight) && intrinsicHeight > 0 ? intrinsicHeight : 270;
    const scale = Math.min(1, 480 / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      video: { assetId, ...(posterAssetId && { posterAssetId }), ...(displayMode === 'preview' && { displayMode }) }
    };
  }

  compose(node: NodeEntity): CanvasPrimitive[] {
    const bounds = { x: 0, y: 0, width: node.width, height: node.height };
    return node.video?.posterAssetId
      ? [{ kind: 'image', ...bounds, assetId: node.video.posterAssetId, fit: 'cover' }]
      : [{ kind: 'rect', ...bounds, fill: '$placeholder' }];
  }
}

export interface VideoAssetTaskHost {
  createNodeWithAssetTask<T extends string>(options: CreateNodeAssetTaskOptions<T>): Promise<AssetTaskResult<string>>;
  updateNodesWithAssetTask(options: UpdateNodesAssetTaskOptions): Promise<AssetTaskResult<readonly string[]>>;
}

async function uploadVideoAndPoster(
  upload: AssetUploader,
  file: unknown,
  preparePoster: ((signal: AbortSignal) => Promise<unknown>) | undefined,
  signal: AbortSignal
): Promise<readonly [CanvasAssetMeta, CanvasAssetMeta?]> {
  const video = await upload({ file, mimePrefix: 'video/' });
  const posterFile = await preparePoster?.(signal);
  const poster = posterFile === undefined ? undefined : await upload({ file: posterFile, mimePrefix: 'image/' });
  return [video, poster];
}

function getVideoTargetSignature(node: Readonly<NodeEntity>): string | undefined {
  return node.nodeType === 'video' && node.video
    ? JSON.stringify([node.video.assetId, node.video.posterAssetId])
    : undefined;
}

/** 宿主准备封面，以同一次可撤销提交登记视频、封面并创建视频节点 */
export function insertVideoAsset(
  host: Pick<VideoAssetTaskHost, 'createNodeWithAssetTask'>,
  file: unknown,
  point: Point,
  preparePoster?: (signal: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<AssetTaskResult<string>> {
  const position = { ...point };
  return host.createNodeWithAssetTask({
    label: '插入视频',
    signal,
    prepare: async (upload, taskSignal) => {
      const [video, poster] = await uploadVideoAndPoster(upload, file, preparePoster, taskSignal);
      return {
        request: {
          nodeType: 'video',
          x: position.x,
          y: position.y,
          origin: 'center',
          options: {
            assetId: video.id,
            posterAssetId: poster?.id,
            intrinsicWidth: video.width,
            intrinsicHeight: video.height
          },
          label: '插入视频'
        },
        assets: poster ? [video, poster] : [video]
      };
    }
  });
}

/** 替换视频节点的视频与可选封面资产引用，保留节点几何、样式与展示方式 */
export async function replaceVideoAsset(
  host: Pick<VideoAssetTaskHost, 'updateNodesWithAssetTask'>,
  nodeId: string,
  file: unknown,
  preparePoster?: (signal: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<AssetTaskResult<string>> {
  const result = await host.updateNodesWithAssetTask({
    nodeIds: [nodeId],
    label: '替换视频',
    signal,
    getTargetSignature: getVideoTargetSignature,
    prepare: async (upload, taskSignal) => {
      const [video, poster] = await uploadVideoAndPoster(upload, file, preparePoster, taskSignal);
      return {
        assets: poster ? [video, poster] : [video],
        update: (node) => {
          if (!node.video) return {};
          const { posterAssetId: _previousPoster, ...rest } = node.video;
          return { video: { ...rest, assetId: video.id, ...(poster && { posterAssetId: poster.id }) } };
        }
      };
    }
  });
  return result.status === 'succeeded' ? { status: 'succeeded', value: result.value[0] } : result;
}

/** 替换视频节点的封面资产引用，不影响视频源与当前播放状态 */
export async function setVideoPosterAsset(
  host: Pick<VideoAssetTaskHost, 'updateNodesWithAssetTask'>,
  nodeId: string,
  file: unknown,
  signal?: AbortSignal
): Promise<AssetTaskResult<string>> {
  const result = await host.updateNodesWithAssetTask({
    nodeIds: [nodeId],
    label: '修改视频封面',
    signal,
    getTargetSignature: getVideoTargetSignature,
    prepare: async (upload) => {
      const poster = await upload({ file, mimePrefix: 'image/' });
      return {
        assets: [poster],
        update: (node) => (node.video ? { video: { ...node.video, posterAssetId: poster.id } } : {})
      };
    }
  });
  return result.status === 'succeeded' ? { status: 'succeeded', value: result.value[0] } : result;
}

/** 读取视频源资产的固有尺寸，封面可以使用不同的尺寸和比例 */
export function getVideoAssetDimensions(
  node: Readonly<NodeEntity> | undefined,
  assets: Readonly<Record<string, Readonly<CanvasAssetMeta>>> | undefined
): { width: number; height: number } | undefined {
  if (node?.nodeType !== 'video' || !node.video) return undefined;
  const asset = assets?.[node.video.assetId];
  if (!asset?.mimeType.startsWith('video/')) return undefined;
  const { width, height } = asset;
  if (!width || !height || width < 0 || height < 0 || !Number.isFinite(width) || !Number.isFinite(height))
    return undefined;
  return { width, height };
}
