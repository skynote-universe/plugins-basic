import {
  isNodeHiddenByOpacity,
  unionBounds,
  type CanvasPluginContext,
  type CanvasTheme,
  type DocumentChangeSet,
  type Point,
  type RectBounds,
  type SkyNotePlugin
} from '@skynote/core';

export const MINIMAP_PLUGIN_ID = '@skynote/plugins-basic/minimap';
/** CSS像素；视口标识和命中范围共用最小宽度，高度保持画布视口比例。 */
export const MINIMAP_MIN_VIEWPORT_WIDTH = 50;

export interface MinimapSize {
  readonly width: number;
  readonly height: number;
}

export interface MinimapProjection {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface MinimapNode {
  readonly id: string;
  readonly bounds: RectBounds;
  readonly container: boolean;
}

export interface MinimapConnector {
  readonly id: string;
  readonly points: readonly Point[];
  readonly bounds: RectBounds;
}

export interface MinimapContent {
  readonly nodes: readonly MinimapNode[];
  readonly connectors: readonly MinimapConnector[];
  readonly bounds: RectBounds | null;
}

export interface MinimapSnapshot {
  readonly content: MinimapContent;
  readonly projection: MinimapProjection;
  readonly viewport: RectBounds;
  readonly theme: CanvasTheme;
  readonly selectedNodes: ReadonlySet<string>;
  readonly selectedConnectors: ReadonlySet<string>;
  readonly navigating: boolean;
  readonly disabled: boolean;
}

/** 优先容纳内容与视口；视口过小时整体放大并以视口居中，保证示意范围准确。 */
export function fitMinimap(content: RectBounds | null, viewport: RectBounds, size: MinimapSize): MinimapProjection {
  const bounds = content ? unionBounds(content, viewport) : viewport;
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const fitScale = Math.min(Math.max(1, size.width - 16) / width, Math.max(1, size.height - 16) / height);
  // 最小视口尺寸必须作用于整体映射，不能单独放大视口框而误示覆盖范围。
  const scale = Math.max(fitScale, MINIMAP_MIN_VIEWPORT_WIDTH / Math.max(1, viewport.right - viewport.left));
  const center = scale > fitScale ? viewport : bounds;
  return {
    scale,
    x: size.width / 2 - ((center.left + center.right) / 2) * scale,
    y: size.height / 2 - ((center.top + center.bottom) / 2) * scale
  };
}

/** 概览只读取已提交的公共几何；宿主自行绘制，插件不引用DOM或渲染引擎。 */
export class MinimapPlugin implements SkyNotePlugin {
  readonly id = MINIMAP_PLUGIN_ID;
  readonly name = '小地图';
  readonly version = '0.1.0';
  private ctx: CanvasPluginContext | undefined;
  private enabled = false;
  private focused = false;
  private fullRefresh = true;
  private visibilityRevision = -1;
  private hadCollapsed = false;
  private readonly dirtyNodes = new Set<string>();
  private readonly dirtyConnectors = new Set<string>();
  private readonly nodes = new Map<string, MinimapNode>();
  private readonly connectors = new Map<string, MinimapConnector>();
  private content: MinimapContent | undefined;
  private readonly listeners = new Set<() => void>();
  private navigation:
    | {
        pointerId: number;
        projection: MinimapProjection;
        offset: Point;
        zoom: number;
        width: number;
        height: number;
      }
    | undefined;

  get isNavigating(): boolean {
    return !!this.navigation;
  }

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.onDocumentChange((change) => this.documentChanged(change));
    const invalidate = (): void => {
      this.fullRefresh = true;
      if (this.enabled) this.notify();
    };
    ctx.layouts.onChange(invalidate);
    ctx.nodeTypes.onChange(invalidate);
    ctx.onHostChange((available) => {
      if (!available) this.setFocused(false);
    });
    ctx.onSessionChange((change) => {
      const drag = this.navigation;
      const session = ctx.session;
      if (
        drag &&
        (session.inMaintenance ||
          change.toolChanged ||
          session.viewport.zoom !== drag.zoom ||
          session.viewportSize.width !== drag.width ||
          session.viewportSize.height !== drag.height)
      ) {
        this.navigation = undefined;
      }
      if (
        this.enabled &&
        (change.viewportChanged ||
          change.themeChanged ||
          change.maintenanceChanged ||
          change.toolChanged ||
          change.toggledNodeIds.size ||
          change.toggledConnectorIds.size)
      )
        this.notify();
    });
    ctx.registerInputScope({
      id: this.id,
      priority: 1100,
      onBlur: () => this.setFocused(false),
      onKeyDown: (event) => {
        if (event.key === 'Escape' && this.navigation) {
          event.preventDefault();
          this.cancelNavigation();
          return true;
        }
        if (!this.focused || !this.enabled || event.ctrlKey || event.metaKey || event.altKey) return false;
        const step = event.shiftKey ? 160 : 40;
        const directions: Record<string, readonly [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step]
        };
        const delta = directions[event.key];
        if (delta) this.panBy(...delta);
        else if (event.key === '+' || event.key === '=' || event.key === '-') {
          if (!this.navigation && !ctx.session.inMaintenance) ctx.session.zoomAt(event.key === '-' ? 1 / 1.2 : 1.2);
        } else return false;
        event.preventDefault();
        return true;
      }
    });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.focused = false;
    this.navigation = undefined;
    this.clearContent();
    this.notify();
  }

  /** 宿主表面获焦时启用导航按键，失焦同时结束尚未完成的拖动。 */
  setFocused(focused: boolean): void {
    this.focused = focused && this.enabled && !!this.ctx;
    if (!this.focused) this.cancelNavigation();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private documentChanged(change: DocumentChangeSet): void {
    const ctx = this.ctx!;
    if (!this.enabled) {
      this.fullRefresh = true;
      return;
    }
    if (change.contentReplaced) this.navigation = undefined;
    if (
      change.contentReplaced ||
      (ctx.document.visibility.revision !== this.visibilityRevision &&
        (this.hadCollapsed || ctx.document.visibility.hasCollapsed))
    )
      this.fullRefresh = true;
    else {
      for (const ids of [change.nodes.added, change.nodes.removed, change.nodes.worldGeometry, change.nodes.data])
        for (const id of ids) this.dirtyNodes.add(id);
      for (const ids of [
        change.connectors.added,
        change.connectors.removed,
        change.connectors.geometry,
        change.connectors.data
      ])
        for (const id of ids) this.dirtyConnectors.add(id);
    }
    this.notify();
  }

  private refreshContent(): MinimapContent {
    const ctx = this.ctx!;
    if (this.fullRefresh) {
      this.nodes.clear();
      this.connectors.clear();
      this.dirtyNodes.clear();
      this.dirtyConnectors.clear();
      for (const node of ctx.entities.getAllNodes()) this.dirtyNodes.add(node.entity.id);
      for (const connector of ctx.entities.getAllConnectors()) this.dirtyConnectors.add(connector.entity.id);
      this.content = undefined;
    }
    if (!this.content || this.dirtyNodes.size || this.dirtyConnectors.size) {
      for (const id of this.dirtyNodes) {
        const node = ctx.entities.getNode(id)?.entity;
        const bounds =
          node && !isNodeHiddenByOpacity(node, ctx.nodeTypes.get(node.nodeType)) && ctx.spatial.getBounds(id);
        if (bounds)
          this.nodes.set(id, { id, bounds, container: node.nodeType === 'group' || node.nodeType === 'frame' });
        else this.nodes.delete(id);
      }
      for (const id of this.dirtyConnectors) {
        const route = ctx.connectors.getConnectorRoute(id);
        if (route) this.connectors.set(id, { id, points: route.points, bounds: route.bounds });
        else this.connectors.delete(id);
      }
      let bounds: RectBounds | null = null;
      for (const item of [...this.nodes.values(), ...this.connectors.values()])
        bounds = bounds ? unionBounds(bounds, item.bounds) : item.bounds;
      this.content = { nodes: [...this.nodes.values()], connectors: [...this.connectors.values()], bounds };
      this.dirtyNodes.clear();
      this.dirtyConnectors.clear();
    }
    this.fullRefresh = false;
    this.visibilityRevision = ctx.document.visibility.revision;
    this.hadCollapsed = ctx.document.visibility.hasCollapsed;
    return this.content;
  }

  getSnapshot(size: MinimapSize): MinimapSnapshot | null {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !(size.width > 0 && size.height > 0)) return null;
    const { viewport, viewportSize, theme } = ctx.session;
    const rect = {
      left: -viewport.x / viewport.zoom,
      top: -viewport.y / viewport.zoom,
      right: (viewportSize.width - viewport.x) / viewport.zoom,
      bottom: (viewportSize.height - viewport.y) / viewport.zoom
    };
    const content = this.refreshContent();
    return {
      content,
      projection: this.navigation?.projection ?? fitMinimap(content.bounds, rect, size),
      viewport: rect,
      theme,
      selectedNodes: ctx.session.selectedNodeIds,
      selectedConnectors: ctx.session.selectedConnectorIds,
      navigating: !!this.navigation,
      disabled: ctx.session.inMaintenance
    };
  }

  beginNavigation(pointerId: number, point: Point, size: MinimapSize): boolean {
    const snapshot = this.getSnapshot(size);
    if (!snapshot || snapshot.disabled || this.navigation) return false;
    const session = this.ctx!.session;
    const world = this.toWorld(point, snapshot.projection);
    const rect = snapshot.viewport;
    const center = session.viewportCenter;
    const inside = world.x >= rect.left && world.x <= rect.right && world.y >= rect.top && world.y <= rect.bottom;
    this.navigation = {
      pointerId,
      projection: snapshot.projection,
      offset: inside ? { x: world.x - center.x, y: world.y - center.y } : { x: 0, y: 0 },
      zoom: session.viewport.zoom,
      width: session.viewportSize.width,
      height: session.viewportSize.height
    };
    this.moveNavigation(pointerId, point);
    this.notify();
    return true;
  }

  moveNavigation(pointerId: number, point: Point): void {
    const drag = this.navigation;
    if (!drag || drag.pointerId !== pointerId) return;
    const world = this.toWorld(point, drag.projection);
    this.centerOn({ x: world.x - drag.offset.x, y: world.y - drag.offset.y });
  }

  endNavigation(pointerId: number): void {
    if (this.navigation?.pointerId === pointerId) this.cancelNavigation();
  }

  cancelNavigation(): void {
    if (!this.navigation) return;
    this.navigation = undefined;
    this.notify();
  }

  private toWorld(point: Point, projection: MinimapProjection): Point {
    return { x: (point.x - projection.x) / projection.scale, y: (point.y - projection.y) / projection.scale };
  }

  private centerOn(point: Point): void {
    const session = this.ctx!.session;
    const { zoom } = session.viewport;
    session.setViewport({
      x: session.viewportSize.width / 2 - point.x * zoom,
      y: session.viewportSize.height / 2 - point.y * zoom
    });
  }

  zoomAt(point: Point, size: MinimapSize, factor: number): void {
    const snapshot = this.getSnapshot(size);
    if (!snapshot || snapshot.disabled || this.navigation || !(factor > 0 && Number.isFinite(factor))) return;
    this.ctx!.session.zoomAt(factor, this.toWorld(point, snapshot.projection));
  }

  panBy(x: number, y: number): void {
    const session = this.ctx?.session;
    if (!this.enabled || !session || session.inMaintenance || this.navigation) return;
    session.setViewport({ x: session.viewport.x - x, y: session.viewport.y - y });
  }

  private clearContent(): void {
    this.nodes.clear();
    this.connectors.clear();
    this.dirtyNodes.clear();
    this.dirtyConnectors.clear();
    this.content = undefined;
    this.fullRefresh = true;
  }

  unmount(): void {
    this.focused = false;
    this.navigation = undefined;
    this.ctx = undefined;
    this.clearContent();
    this.notify();
    this.listeners.clear();
    this.enabled = false;
  }
}
