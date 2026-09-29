import type { SkyNotePlugin } from '@skynote/core';
import { SelectionPlugin } from './selection';
import { SelectionOutlinePlugin } from './selection-outline';
import { ViewportNavigationPlugin } from './viewport-navigation';
import { EditingShortcutsPlugin } from './editing-shortcuts';

export * from './selection';
export * from './selection-outline';
export * from './viewport-navigation';
export * from './editing-shortcuts';

/** 基础交互全集：宿主逐个 engine.use() 安装；也可按需只装其中几个 */
export function createBasicInteractionPlugins(): SkyNotePlugin[] {
  return [
    new ViewportNavigationPlugin(),
    new SelectionPlugin(),
    new SelectionOutlinePlugin(),
    new EditingShortcutsPlugin()
  ];
}
