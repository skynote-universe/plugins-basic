/**
 * @file clipboard.ts
 * @description 画布剪贴板：复制、剪切、粘贴选中节点 (含后代与内部连线)，粘贴外部纯文本为自由文本
 *
 * 设计考量 (Why):
 * 1. 同时写入画布节点数据与纯文本 (06 设计文档的多格式写入)：粘贴回画布或其他标签页时完整还原，
 *    粘贴到记事本等外部应用时得到节点里的文字。
 * 2. 剪贴板来自外部，粘贴前一律经 parseNodeClipboard 白名单校验，不合法时按纯文本处理。
 * 3. 粘贴位置看鼠标有没有移动：复制后鼠标没动就粘贴，在原位置右下偏移 (快速复制一份)；
 *    鼠标移到画布别处再粘贴，以鼠标位置为中心放下；同一位置连续粘贴从上一份继续错开。
 *    鼠标不在画布上时，原内容在视口内就原位偏移，否则放到视口中央。剪切后第一次粘贴回到原位。
 */

import {
  NODE_CLIPBOARD_MIME,
  computeNodeLocalMatrix,
  computeNodeWorldBounds,
  computeViewportWorldBounds,
  doBoundsIntersect,
  getPlainText,
  type CanvasPointerEvent,
  type Point,
  type PointerHooks,
  parseNodeClipboard,
  unionBounds,
  type CanvasPluginContext,
  type ClipboardData,
  type ClipboardHandler,
  type EntityRefs,
  type NodeClipboardPayload,
  type RectBounds,
  type SkyNotePlugin
} from '@skynote/core';

export const CLIPBOARD_PLUGIN_ID = '@skynote/plugins-basic/clipboard';
/** 连续粘贴时每份相对上一份的偏移 (世界距离) */
const PASTE_STEP = 20;
/** 鼠标在屏幕上移动超过这个距离才算换了位置，避免手抖误判 */
const MOVE_THRESHOLD_PX = 8;
/** 粘贴外部纯文本时创建的节点类型 */
const TEXT_NODE_TYPE = 'free-text';

/**
 * 一串连续粘贴：anchor 为这一串的基准中心 (null 表示以原内容所在位置为基准)，count 为已粘贴的份数
 * (每份再错开一步)，pointer 为上次复制或粘贴时的鼠标位置，用来判断之后鼠标有没有移动
 */
interface PasteSeries {
  readonly key: string;
  readonly anchor: Point | null;
  readonly count: number;
  readonly pointer: Point | null;
}

export class ClipboardPlugin implements SkyNotePlugin, ClipboardHandler, PointerHooks {
  readonly id = CLIPBOARD_PLUGIN_ID;
  readonly name = '剪贴板';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  /** 复制后 count 为 0 (第一次粘贴偏移一步)，剪切后为 -1 (第一次粘贴回到原位) */
  private series: PasteSeries | null = null;
  /** 鼠标在画布上的世界坐标；离开画布 (移到工具栏或窗口外) 时为 null */
  private pointer: Point | null = null;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerClipboardHandler(this);
    ctx.registerPointerHooks(this);
  }

  onPointerDown(e: CanvasPointerEvent): void {
    this.pointer = e.point;
  }

  onPointerMove(e: CanvasPointerEvent): void {
    this.pointer = e.point;
  }

  onPointerLeave(): void {
    this.pointer = null;
  }

  copy(): ClipboardData | null {
    const { session } = this.ctx;
    const data = this.serialize({ nodeIds: session.selectedNodeIds, connectorIds: session.selectedConnectorIds });
    if (data) this.series = { key: data[NODE_CLIPBOARD_MIME], anchor: null, count: 0, pointer: this.pointer };
    return data;
  }

  cut(): ClipboardData | null {
    const { session, entities, document } = this.ctx;
    const refs = {
      nodeIds: [...session.selectedNodeIds].filter((id) => !entities.getNode(id)?.entity.locked),
      connectorIds: [...session.selectedConnectorIds].filter((id) => !entities.getConnector(id)?.entity.locked)
    };
    const data = this.serialize(refs);
    if (!data) return null;
    document.removeEntities(refs, { label: '剪切' });
    this.series = { key: data[NODE_CLIPBOARD_MIME], anchor: null, count: -1, pointer: this.pointer };
    return data;
  }

  paste(data: ClipboardData, files?: readonly unknown[]): boolean {
    const json = data[NODE_CLIPBOARD_MIME];
    const parsed = json === undefined ? null : parseNodeClipboard(json);
    if (parsed?.ok) return this.pasteContent(json, parsed.value);
    const imageFile = files?.find(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        'type' in file &&
        String((file as { type?: unknown }).type).startsWith('image/')
    );
    if (imageFile !== undefined) {
      void this.ctx.insertImage(imageFile, this.pointer ?? this.ctx.session.viewportCenter).catch((err: unknown) => {
        console.warn('[SkyNote] 粘贴图片失败:', err);
      });
      return true;
    }
    const text = data['text/plain']?.trim();
    return text ? this.pasteText(text) : false;
  }

  /** 选中实体 → 画布数据 + 节点与连线上的文字；没有可复制的内容时为 null */
  private serialize(refs: EntityRefs): Record<string, string> | null {
    const payload = this.ctx.document.copyEntities(refs);
    if (!payload) return null;
    // 节点与连线上的文字依次成行，粘贴到外部应用时内容不丢
    const text = [...payload.nodes, ...payload.connectors]
      .flatMap((entity) => entity.textBlocks ?? [])
      .map(getPlainText)
      .filter((line) => line !== '')
      .join('\n');
    return { [NODE_CLIPBOARD_MIME]: JSON.stringify(payload), 'text/plain': text };
  }

  private pasteContent(key: string, payload: NodeClipboardPayload): boolean {
    const { session, document } = this.ctx;
    const ids = document.pasteEntities(payload, this.placeSeries(key, this.boundsOf(payload)));
    const pasted = ids.nodeIds.length + ids.connectorIds.length > 0;
    if (pasted) session.setSelection(ids);
    return pasted;
  }

  /**
   * 推进连续粘贴并给出这一份的世界位移
   * @param bounds 剪贴板内容在原位置的外接框
   */
  private placeSeries(key: string, bounds: RectBounds): Point {
    const { session } = this.ctx;
    const { pointer } = this;
    const prev = this.series?.key === key ? this.series : null;
    const moved =
      pointer !== null &&
      (!prev?.pointer ||
        Math.hypot(pointer.x - prev.pointer.x, pointer.y - prev.pointer.y) * session.viewport.zoom > MOVE_THRESHOLD_PX);
    let anchor = moved ? pointer : (prev?.anchor ?? null);
    let count = moved ? 0 : (prev?.count ?? 0) + 1;
    // 以原位置为基准但原内容已不在视口内：改为从视口中央开始
    if (
      anchor === null &&
      !doBoundsIntersect(bounds, computeViewportWorldBounds(session.viewport, session.viewportSize))
    ) {
      anchor = session.viewportCenter;
      count = 0;
    }
    this.series = { key, anchor, count, pointer };
    const center = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    const base = anchor ?? center;
    return { x: base.x + PASTE_STEP * count - center.x, y: base.y + PASTE_STEP * count - center.y };
  }

  /** 外部纯文本：鼠标在画布上时放在鼠标位置，否则放在视口中央 */
  private pasteText(text: string): boolean {
    const { nodeTypes, document, session } = this.ctx;
    if (!nodeTypes.get(TEXT_NODE_TYPE)) return false;
    const { x, y } = this.pointer ?? session.viewportCenter;
    const id = document.createNode({
      nodeType: TEXT_NODE_TYPE,
      x,
      y,
      origin: 'center',
      options: { text },
      label: '粘贴'
    });
    if (id) session.setSelection({ nodeIds: [id], connectorIds: [] });
    return id !== null;
  }

  /** 剪贴板内容的整体外接框：最顶层节点 (根层级世界位姿)、连线的自由端与手动拐点 */
  private boundsOf(payload: NodeClipboardPayload): RectBounds {
    const ids = new Set(payload.nodes.map((node) => node.id));
    const boxes = payload.nodes
      .filter((node) => node.parentId === undefined || !ids.has(node.parentId))
      .map((node) => computeNodeWorldBounds(node, computeNodeLocalMatrix(node)));
    for (const c of payload.connectors) {
      const points = [c.from.position, c.to.position, ...(c.controlPoints ?? [])];
      for (const p of points) if (p) boxes.push({ left: p.x, top: p.y, right: p.x, bottom: p.y });
    }
    // 外部数据可能只有连在缺失节点上的连线 (粘贴时会被跳过)，此时没有可定位的内容
    return boxes.reduce((union, b) => unionBounds(union, b), boxes[0] ?? { left: 0, top: 0, right: 0, bottom: 0 });
  }
}
