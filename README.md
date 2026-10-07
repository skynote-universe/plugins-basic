# @skynote/plugins-basic

> Official basic nodes and interactions for [SkyNote](https://github.com/skynote-universe): sticky notes, free text, shapes and frames, plus selection, transform, snapping guides, connectors, in-canvas rich-text editing, clipboard and keyboard shortcuts. Each piece is a standalone plugin built only on the public kernel protocol. MIT licensed.

SkyNote 官方基础节点与交互插件。每个能力都是独立插件，只依赖内核公开协议，可按需装配，也是编写第三方插件的参考实现。

## 内容

**节点类型** (由 `BasicNodesPlugin` 一次注册)

| 类型 | 说明 |
| --- | --- |
| `sticky` | 便签：预设配色，默认等比，可一键适应文字高度 |
| `free-text` | 自由文本：随内容自动宽高，删空即移除 |
| `shape` | 形状：矩形、圆形、菱形、三角形、星形，可带文字；吸附锚点贴合各自轮廓 |
| `frame` | 画框容器：拖入即成为子节点，超出部分裁剪，带标题 |

**交互插件**

| 插件 | 说明 |
| --- | --- |
| `ViewportNavigationPlugin` | 滚轮缩放与平移，空格或中键拖拽平移，快捷键缩放与适配内容 |
| `SelectionPlugin`、`SelectionOutlinePlugin` | 点选、框选、移动 (含拖入拖出画框)，选中描边与悬停高亮 |
| `TransformPlugin` | 缩放与旋转控制柄 |
| `SelectionPlugin` / `TransformPlugin` 内置吸附 | 边缘、中心与等间距参考线；按住 `Ctrl/⌘` 暂时关闭 |
| `ConnectorToolPlugin`、`ConnectorEditPlugin` | 画连线、拖动端点与线段，节点四周的「+」快速连线 |
| `TextEditPlugin` | 画布内富文本编辑 (粗体、斜体、下划线、删除线、颜色、字号、对齐)，支持输入法 |
| `ClipboardPlugin` | 复制、剪切、粘贴 (含外部纯文本)，粘贴的数据经校验 |
| `EditingShortcutsPlugin` | 删除、撤销重做、全选、创建副本、层级、锁定、微移 |

## 安装

```bash
npm i @skynote/plugins-basic
```

## 使用

[@skynote/editor](https://github.com/skynote-universe/editor) 已装配好全部插件，一般无需直接使用本包。自行装配时：

```ts
import { SkyNoteEngine } from '@skynote/core';
import { BasicNodesPlugin, SelectionPlugin, TransformPlugin, ViewportNavigationPlugin } from '@skynote/plugins-basic';

const engine = new SkyNoteEngine()
  .use(new BasicNodesPlugin())
  .use(new ViewportNavigationPlugin())
  .use(new SelectionPlugin())
  .use(new TransformPlugin());
```

只需要某种节点时，也可以从子路径导入：`@skynote/plugins-basic/sticky`、`/free-text`、`/shapes`、`/interactions`。

## 相关包

| 包 | 说明 |
| --- | --- |
| [@skynote/core](https://github.com/skynote-universe/core) | 平台中立内核：文档模型、事务与撤销、插件协议 |
| [@skynote/renderer-leafer](https://github.com/skynote-universe/renderer-leafer) | 基于 LeaferJS 的渲染器 |
| **@skynote/plugins-basic** | 基础节点与交互插件 (本包) |
| [@skynote/editor](https://github.com/skynote-universe/editor) | 开箱即用的编辑器 |
| [web](https://github.com/skynote-universe/web) | 官方示例应用 (Vue 3) |

## 许可证

[MIT](./LICENSE)
