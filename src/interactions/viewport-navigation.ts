/**
 * @file viewport-navigation.ts
 * @description 视口导航：空格 + 拖拽或中键拖拽平移画布，快捷键缩放与适配
 *
 * 设计考量 (Why):
 * 1. 平移优先于选择：以更高优先级接收指针并认领，按住空格或按中键时框选与拖拽节点自动让路。
 * 2. 平移按屏幕像素计算 (clientPoint 差值)：视口本身在变化，用世界坐标差会随平移漂移。
 * 3. 快捷键经焦点栈注册，只在画布持有焦点时生效；输入法组合态由焦点栈统一拦截。
 */

import {
  computeFitViewport,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type Point,
  type SkyNotePlugin
} from '@skynote/core';

export const VIEWPORT_NAVIGATION_PLUGIN_ID = '@skynote/plugins-basic/viewport-navigation';
/** 键盘缩放步长 */
const ZOOM_STEP = 1.2;
/**
 * 平移认领优先级：高于选择与移动 (0)，因此指针钩子单独注册，不用插件自身的 onPointer* (默认优先级)；
 * 处理方法也因此不以 onPointer* 命名，避免被插件管理器当作插件钩子再注册一次
 */
const PAN_PRIORITY = 100;

export class ViewportNavigationPlugin implements SkyNotePlugin {
  readonly id = VIEWPORT_NAVIGATION_PLUGIN_ID;
  readonly name = '视口导航';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private spaceHeld = false;
  private pan: { pointerId: number; lastClient: Point } | null = null;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerInputScope({
      id: 'canvas:viewport-navigation',
      priority: 0,
      onKeyDown: (e) => this.onKeyDown(e),
      onKeyUp: (e) => this.onKeyUp(e)
    });
    ctx.registerPointerHooks(
      {
        onPointerDown: (e) => this.startPan(e),
        onPointerMove: (e) => this.continuePan(e),
        onPointerUp: (e) => this.endPan(e),
        onPointerCancel: (e) => this.cancelPan(e)
      },
      PAN_PRIORITY
    );
  }

  unmount(): void {
    this.pan = null;
    this.spaceHeld = false;
  }

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space' && !mod) {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        if (!this.pan) this.ctx.host.setCursor('grab');
      }
      // 阻止页面滚动；空格按住期间重复触发的 keydown 同样吞掉
      e.preventDefault();
      return true;
    }
    if (mod && (e.key === '=' || e.key === '+')) this.zoomAtCenter(ZOOM_STEP);
    else if (mod && e.key === '-') this.zoomAtCenter(1 / ZOOM_STEP);
    else if (mod && e.key === '0') this.zoomAtCenter(1 / this.ctx.session.viewport.zoom);
    else if (e.shiftKey && !mod && e.code === 'Digit1') this.fitContent();
    else return false;
    // 浏览器默认会缩放整个页面，必须拦截
    e.preventDefault();
    return true;
  }

  private onKeyUp(e: CanvasKeyboardEvent): boolean {
    if (e.code !== 'Space') return false;
    this.spaceHeld = false;
    if (!this.pan) this.ctx.host.setCursor('default');
    return true;
  }

  private startPan(e: CanvasPointerEvent): void {
    if (e.isClaimed || this.pan) return;
    if (e.button !== 1 && !(e.button === 0 && this.spaceHeld)) return;
    e.claimPointer(VIEWPORT_NAVIGATION_PLUGIN_ID);
    this.ctx.host.capturePointer(e.pointerId);
    this.ctx.host.setCursor('grabbing');
    this.pan = { pointerId: e.pointerId, lastClient: e.clientPoint };
  }

  private continuePan(e: CanvasPointerEvent): void {
    const { pan } = this;
    if (!pan || pan.pointerId !== e.pointerId) return;
    const { x, y } = this.ctx.session.viewport;
    this.ctx.session.setViewport({
      x: x + e.clientPoint.x - pan.lastClient.x,
      y: y + e.clientPoint.y - pan.lastClient.y
    });
    pan.lastClient = e.clientPoint;
  }

  private endPan(e: CanvasPointerEvent): void {
    if (!this.pan || this.pan.pointerId !== e.pointerId) return;
    this.ctx.host.releasePointer(e.pointerId);
    this.ctx.host.setCursor(this.spaceHeld ? 'grab' : 'default');
    this.pan = null;
  }

  private cancelPan(e: CanvasPointerEvent): void {
    if (!this.pan || this.pan.pointerId !== e.pointerId) return;
    this.ctx.host.setCursor('default');
    this.pan = null;
  }

  /** 以视口中心为不动点缩放 */
  private zoomAtCenter(factor: number): void {
    const { width, height } = this.ctx.host.getViewportSize();
    const { x, y, zoom } = this.ctx.session.viewport;
    this.ctx.session.zoomAt(factor, { x: (width / 2 - x) / zoom, y: (height / 2 - y) / zoom });
  }

  private fitContent(): void {
    const { session, spatial, host } = this.ctx;
    session.setViewport(
      computeFitViewport(spatial.getContentBounds(), host.getViewportSize(), session.viewport, {
        padding: 80,
        minZoom: session.zoomRange.min,
        maxZoom: Math.min(1, session.zoomRange.max)
      })
    );
  }
}
