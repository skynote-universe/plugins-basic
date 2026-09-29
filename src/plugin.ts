/**
 * @file plugin.ts
 * @description 基础节点插件：一次注册便签、自由文本与基础形状
 */

import type { SkyNotePlugin } from '@skynote/core';
import { stickyNodeType } from './nodes/sticky';
import { freeTextNodeType } from './nodes/free-text';
import { shapeNodeType } from './nodes/shapes';

export const BASIC_NODE_TYPES = [stickyNodeType, freeTextNodeType, shapeNodeType] as const;

export function createBasicNodesPlugin(): SkyNotePlugin {
  return {
    id: '@skynote/plugins-basic/nodes',
    name: '基础节点',
    version: '0.1.0',
    install(ctx) {
      for (const definition of BASIC_NODE_TYPES) ctx.registerNodeType(definition);
    }
  };
}
