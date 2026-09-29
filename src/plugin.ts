/**
 * @file plugin.ts
 * @description 基础节点插件：一次注册便签、自由文本与基础形状
 */

import type { CanvasPluginContext, SkyNotePlugin } from '@skynote/core';
import { StickyNodeType } from './nodes/sticky';
import { FreeTextNodeType } from './nodes/free-text';
import { ShapeNodeType } from './nodes/shapes';

export class BasicNodesPlugin implements SkyNotePlugin {
  readonly id = '@skynote/plugins-basic/nodes';
  readonly name = '基础节点';
  readonly version = '0.1.0';

  install(ctx: CanvasPluginContext): void {
    ctx.registerNodeType(new StickyNodeType());
    ctx.registerNodeType(new FreeTextNodeType());
    ctx.registerNodeType(new ShapeNodeType());
  }
}
