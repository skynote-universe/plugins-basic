/**
 * @file viewport-navigation.ts
 * @description 视口导航：滚轮缩放与平移、空格 + 拖拽或中键拖拽平移、快捷键缩放与适配内容
 *
 * 设计考量 (Why):
 * 1. 视口交互只在这一个插件：渲染器只上报视口尺寸，缩放与适配的计算都在会话 (SessionController) 中。
 * 2. 平移优先于选择：指针钩子以更高优先级注册并认领，按住空格或按中键时框选与拖拽节点自动让路；
 *    滚轮以最低优先级注册，可滚动的节点内容 (如表格) 先行消费。
 * 3. 平移按屏幕像素计算 (clientPoint 差值)：视口本身在变化，用世界坐标差会随平移漂移。
 * 4. 快捷键经焦点栈注册，只在画布持有焦点时生效；输入法组合态由焦点栈统一拦截。
 */

import type {
  CanvasKeyboardEvent,
  CanvasPluginContext,
  CanvasPointerEvent,
  CanvasWheelEvent,
  Point,
  PointerHooks,
  SkyNotePlugin
} from '@skynote/core';

export const VIEWPORT_NAVIGATION_PLUGIN_ID = '@skynote/plugins-basic/viewport-navigation';
/** 键盘缩放步长 */
const ZOOM_STEP = 1.2;
/** 平移认领优先级：高于选择与移动 (0) */
const PAN_PRIORITY = 100;
/** 滚轮兜底优先级：低于一切内容交互 */
const WHEEL_PRIORITY = -100;

export class ViewportNavigationPlugin implements SkyNotePlugin, PointerHooks {
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
      onKeyUp: (e) => this.onKeyUp(e),
      onBlur: () => this.releaseSpace()
    });
    // 指针与滚轮优先级不同，分两次注册；滚轮处理方法因此不以 onWheel 命名，避免随 this 以平移优先级注册
    ctx.registerPointerHooks(this, PAN_PRIORITY);
    ctx.registerPointerHooks({ onWheel: (e) => this.applyWheel(e) }, WHEEL_PRIORITY);
  }

  unmount(): void {
    this.pan = null;
    this.spaceHeld = false;
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (e.isClaimed || this.pan) return;
    if (e.button !== 1 && !(e.button === 0 && this.spaceHeld)) return;
    e.claimPointer(VIEWPORT_NAVIGATION_PLUGIN_ID);
    this.ctx.host.capturePointer(e.pointerId);
    this.ctx.host.setCursor('grabbing');
    this.pan = { pointerId: e.pointerId, lastClient: e.clientPoint };
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { pan } = this;
    if (pan?.pointerId !== e.pointerId) return;
    const { x, y } = this.ctx.session.viewport;
    this.ctx.session.setViewport({
      x: x + e.clientPoint.x - pan.lastClient.x,
      y: y + e.clientPoint.y - pan.lastClient.y
    });
    pan.lastClient = e.clientPoint;
  }

  onPointerUp(e: CanvasPointerEvent): void {
    if (this.pan?.pointerId !== e.pointerId) return;
    this.ctx.host.releasePointer(e.pointerId);
    this.ctx.host.setCursor(this.spaceHeld ? 'grab' : 'default');
    this.pan = null;
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    if (this.pan?.pointerId !== e.pointerId) return;
    this.ctx.host.setCursor('default');
    this.pan = null;
  }

  /** 捏合或 Ctrl + 滚轮以指针为不动点缩放，其余滚动平移 */
  private applyWheel(e: CanvasWheelEvent): void {
    const { session } = this.ctx;
    if (e.deltaZoom !== 0) {
      session.zoomAt(Math.exp(e.deltaZoom), e.centerPoint);
    } else if (e.deltaPan.x !== 0 || e.deltaPan.y !== 0) {
      session.setViewport({ x: session.viewport.x + e.deltaPan.x, y: session.viewport.y + e.deltaPan.y });
    }
  }

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const { session, spatial, host } = this.ctx;
    if (e.code === 'Space' && !mod) {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        if (!this.pan) host.setCursor('grab');
      }
      // 阻止页面滚动；空格按住期间重复触发的 keydown 同样吞掉
      e.preventDefault();
      return true;
    }
    if (mod && (e.key === '=' || e.key === '+')) session.zoomAt(ZOOM_STEP);
    else if (mod && e.key === '-') session.zoomAt(1 / ZOOM_STEP);
    else if (mod && e.key === '0') session.zoomAt(1 / session.viewport.zoom);
    else if (e.shiftKey && !mod && e.code === 'Digit1') session.fitBounds(spatial.getContentBounds());
    else return false;
    // 浏览器默认会缩放整个页面，必须拦截
    e.preventDefault();
    return true;
  }

  private onKeyUp(e: CanvasKeyboardEvent): boolean {
    if (e.code !== 'Space') return false;
    this.releaseSpace();
    return true;
  }

  /** 松开空格；失焦时同样调用，否则切回窗口后仍处于平移模式 */
  private releaseSpace(): void {
    if (!this.spaceHeld) return;
    this.spaceHeld = false;
    if (!this.pan) this.ctx.host.setCursor('default');
  }
}
