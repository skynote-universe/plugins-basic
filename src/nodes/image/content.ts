/**
 * @file content.ts
 * @description 图片节点：以文档资产引用描述图片，不把媒体内容放进节点数据
 *
 * 设计考量 (Why):
 * 1. 图片专有字段集中在类型化的 image 命名空间，避免 data 弱类型载荷及与其他插件字段冲突。
 * 2. 显示尺寸属于节点几何，固有尺寸只属于文档资产元数据，比例计算不重复持久化数据。
 */

import type {
  CanvasPrimitive,
  ImageFit,
  NodeComposeContext,
  NodeCreateContent,
  NodeEntity,
  NodeTypeDefinition
} from '@skynote/core';

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
