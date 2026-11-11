# @skynote/plugins-basic

> Official basic nodes and interactions for [SkyNote](https://github.com/skynote-universe): sticky notes, free text, shapes and frames, plus selection, transform, snapping guides, connectors, in-canvas rich-text editing, clipboard and keyboard shortcuts. Each piece is a standalone plugin built only on the public kernel protocol. MIT licensed.

SkyNote 官方基础节点与交互插件。每个能力都是独立插件，只依赖内核公开协议，可按需装配，也是编写第三方插件的参考实现。

[快速开始](https://docs.skynote.top/guide/getting-started) · [API 参考](https://docs.skynote.top/api/plugins-basic) · [演练场](https://playground.skynote.top/)

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
| `MinimapPlugin` | 按需装配的小地图数据与导航：可见节点/连线概览、视口映射、点击定位及拖动平移；由宿主绘制 |
| `SelectionPlugin`、`SelectionOutlinePlugin` | 点选、框选、移动 (含拖入拖出画框)，选中描边与悬停高亮 |
| `TransformPlugin` | 缩放与旋转控制柄 |
| `SelectionPlugin` / `TransformPlugin` 内置吸附 | 边缘、中心与等间距参考线；按住 `Ctrl/⌘` 暂时关闭 |
| `ConnectorToolPlugin`、`ConnectorEditPlugin` | 画连线、拖动端点与线段，节点四周的「+」快速连线 |
| `TextEditPlugin` | 画布内富文本编辑 (粗体、斜体、下划线、删除线、颜色、字号、对齐)，支持输入法 |
| `ClipboardPlugin` | 复制、剪切、粘贴 (含外部纯文本)，粘贴的数据经校验 |
| `EditingShortcutsPlugin` | 删除、撤销重做、全选、创建副本、层级、锁定、微移 |

## 安装

首个公开版本为 `0.1.0-beta.1`。通过 npm 的 `beta` 标签安装。

```bash
npm install @skynote/plugins-basic@beta @skynote/core@beta
```

## 使用

[@skynote/editor](https://docs.skynote.top/api/editor) 已装配常用基础节点与交互，一般无需直接使用本包。小地图为按需插件。自行装配时：

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

### 小地图

```ts
import { MinimapPlugin } from '@skynote/plugins-basic';

const minimap = new MinimapPlugin();
engine.use(minimap);
minimap.setEnabled(true);
const snapshot = minimap.getSnapshot({ width: 224, height: 144 });
```

也可通过Editor构造参数的 `plugins: [minimap]` 装配。`getSnapshot` 返回已提交的可见几何、世界视口、世界到小地图的映射、主题和选区，不包含文字或媒体像素。关闭或卸载时释放概览缓存；折叠分支和隐藏端点连线不进入快照。快照为空表示未启用或插件不可用。

宿主通过 `subscribe` 接收失效通知并合并绘制；视口变化复用内容快照，内容变化按节点/连线增量读取几何，但快照数组与整表范围汇总仍有O(N)开销。布局可见性变化时全量刷新。Web底图预绘制周围余量，平移裁切缓存，超出余量或比例、内容变化时重建，视口框独立合成。

宿主把其小地图表面CSS像素坐标交给 `beginNavigation(pointerId, point, size)` / `moveNavigation` / `endNavigation`，并自行在该表面捕获和释放DOM指针；不要把这些独立表面事件重复分发到主画布。视口框内按下保留抓取偏移，框外按下立即居中，拖动期间固定映射。`cancelNavigation` 用于取消；失焦、Escape、维护冻结、文档替换和卸载也会取消。`isNavigating` 可用于同步回收宿主捕获，订阅结束需调用解绑函数。

`zoomAt(point, size, factor)` 按世界锚点缩放并遵守会话缩放范围，`panBy(x, y)` 按屏幕像素平移。全部导航只更新会话，不改变文档、选区或撤销历史；只读允许导航，维护冻结禁用导航。插件不依赖DOM、Canvas API或具体渲染器。

宿主表面获焦/失焦时调用 `setFocused(true/false)`，按键归一化后通过引擎公开InputScopeManager分发，不直接调用导航快捷键。插件只在获焦时消费方向键和加减键，失焦取消拖动并停止消费导航键；输入法组合态由统一分发器拦截。

## 相关包

| 包 | 说明 |
| --- | --- |
| [@skynote/core](https://docs.skynote.top/api/core) | 平台中立内核：文档模型、事务与撤销、插件协议 |
| [@skynote/renderer-leafer](https://docs.skynote.top/api/renderer-leafer) | 基于 LeaferJS 的渲染器 |
| **@skynote/plugins-basic** | 基础节点与交互插件 (本包) |
| [@skynote/editor](https://docs.skynote.top/api/editor) | 开箱即用的编辑器 |
| [SkyNote Web](https://canvas.skynote.top/) | 官方示例应用 (Vue 3) |

## 许可证

[MIT](./LICENSE)
