/**
 * @file content.ts
 * @description 图片节点：以文档资产引用描述图片，不把媒体内容放进节点数据
 *
 * 设计考量 (Why):
 * 1. 图片专有字段集中在类型化的 image 命名空间，避免 data 弱类型载荷及与其他插件字段冲突。
 * 2. 显示尺寸属于节点几何，固有尺寸只属于文档资产元数据，比例计算不重复持久化数据。
 */

import type {
  AssetTaskResult,
  CanvasPrimitive,
  CreateNodeAssetTaskOptions,
  ImageFit,
  NodeComposeContext,
  NodeCreateContent,
  NodeEntity,
  NodeTypeDefinition,
  Point,
  UpdateNodesAssetTaskOptions
} from '@skynote/core';
import { AssetAdapterError } from '@skynote/core';

export interface ImageNodeFields {
  assetId: string;
  fit: ImageFit;
}

declare module '@skynote/core' {
  interface CustomNodeFields {
    image?: ImageNodeFields;
  }
  interface NodeCreateOptionsMap {
    image: ImageCreateOptions;
  }
}

export interface ImageCreateOptions {
  assetId: string;
  fit?: ImageFit;
  intrinsicWidth: number;
  intrinsicHeight: number;
}

export const IMAGE_NODE_MAX_EDGE = 480;
const VALID_FITS: readonly ImageFit[] = ['fill', 'cover', 'contain', 'none'];

export class ImageNodeType implements NodeTypeDefinition {
  static readonly TYPE = 'image';

  readonly type = ImageNodeType.TYPE;
  readonly label = '图片';
  readonly defaultData = {};
  readonly defaultAspectLocked = true;
  readonly defaultStyle = { radius: 0 };
  readonly opacityBehavior = 'renderer-defined' as const;
  readonly assets = {
    repair: (node: Readonly<NodeEntity>): { image: ImageNodeFields } | undefined => {
      const image = node.image;
      if (!image || typeof image.assetId !== 'string' || !image.assetId) return undefined;
      return { image: { ...image, fit: VALID_FITS.includes(image.fit) ? image.fit : 'cover' } };
    },
    collect: (node: Readonly<NodeEntity>): readonly string[] => {
      const image = node.image;
      if (!image || typeof image.assetId !== 'string' || !image.assetId || !VALID_FITS.includes(image.fit))
        throw new AssetAdapterError('invalid-reference', '图片资产引用或显示模式无效');
      return [image.assetId];
    },
    remap: (node: Readonly<NodeEntity>, ids: ReadonlyMap<string, string>): { image: ImageNodeFields } => {
      const assetId = ids.get(node.image!.assetId);
      if (!assetId) throw new AssetAdapterError('invalid-reference', '缺少图片资产映射');
      return { image: { ...node.image!, assetId } };
    }
  };

  createContent(options: ImageCreateOptions): NodeCreateContent {
    const { intrinsicWidth, intrinsicHeight } = options;
    const validSize =
      Number.isFinite(intrinsicWidth) && intrinsicWidth > 0 && Number.isFinite(intrinsicHeight) && intrinsicHeight > 0;
    const ratio = validSize ? Math.min(1, IMAGE_NODE_MAX_EDGE / Math.max(intrinsicWidth, intrinsicHeight)) : 1;
    const width = validSize ? Math.max(1, Math.round(intrinsicWidth * ratio)) : IMAGE_NODE_MAX_EDGE;
    const height = validSize ? Math.max(1, Math.round(intrinsicHeight * ratio)) : IMAGE_NODE_MAX_EDGE;
    return {
      width,
      height,
      image: { assetId: options.assetId, fit: options.fit ?? 'cover' }
    };
  }

  supportsCornerRadius(): boolean {
    return true;
  }

  compose(node: NodeEntity, _context: NodeComposeContext): CanvasPrimitive[] {
    const image = node.image;
    if (!image || typeof image.assetId !== 'string' || image.assetId.length === 0) {
      return [{ kind: 'rect', x: 0, y: 0, width: node.width, height: node.height, fill: '$placeholder' }];
    }
    const fit = VALID_FITS.includes(image.fit) ? image.fit : 'cover';
    return [
      {
        kind: 'image',
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        assetId: image.assetId,
        fit,
        radius: node.style?.radius,
        opacity: node.style?.opacity
      }
    ];
  }
}

export interface ImageAssetTaskHost {
  createNodeWithAssetTask<T extends string>(options: CreateNodeAssetTaskOptions<T>): Promise<AssetTaskResult<string>>;
  updateNodesWithAssetTask(options: UpdateNodesAssetTaskOptions): Promise<AssetTaskResult<readonly string[]>>;
}

/** 经宿主资产适配器上传图片并在同一次可撤销事务中创建图片节点 */
export function insertImageAsset(
  host: Pick<ImageAssetTaskHost, 'createNodeWithAssetTask'>,
  file: unknown,
  point: Point,
  fit: ImageFit = 'cover',
  signal?: AbortSignal
): Promise<AssetTaskResult<string>> {
  const position = { ...point };
  return host.createNodeWithAssetTask({
    label: '插入图片',
    signal,
    prepare: async (upload) => {
      const meta = await upload({ file, mimePrefix: 'image/' });
      return {
        request: {
          nodeType: 'image',
          x: position.x,
          y: position.y,
          origin: 'center',
          options: {
            assetId: meta.id,
            fit,
            intrinsicWidth: meta.width ?? 0,
            intrinsicHeight: meta.height ?? 0
          },
          label: '插入图片'
        },
        assets: [meta]
      };
    }
  });
}

/** 上传并原子替换所选图片节点的资产引用，保留几何、样式与各自的显示方式 */
export function replaceImageAsset(
  host: Pick<ImageAssetTaskHost, 'updateNodesWithAssetTask'>,
  nodeIds: readonly string[],
  file: unknown,
  signal?: AbortSignal
): Promise<AssetTaskResult<readonly string[]>> {
  return host.updateNodesWithAssetTask({
    nodeIds,
    label: '替换图片',
    signal,
    getTargetSignature: (node) =>
      node.nodeType === 'image' && typeof node.image?.assetId === 'string' ? node.image.assetId : undefined,
    prepare: async (upload) => {
      const meta = await upload({ file, mimePrefix: 'image/' });
      return {
        assets: [meta],
        update: (node) => (node.image ? { image: { ...node.image, assetId: meta.id } } : {})
      };
    }
  });
}
