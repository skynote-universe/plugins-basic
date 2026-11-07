/**
 * @file text-edit.ts
 * @description 画布内富文本编辑与文字格式：双击进入，光标、选区与滚动全部画在画布上 (ADR-122)
 *
 * 设计考量 (Why):
 * 1. 所见即所得：编辑视图 (editingTextPrimitive) 由渲染器与本插件共用，光标、选区与点击定位读同一份排版；
 *    宿主只提供隐藏的输入通道 (键入、输入法、粘贴、剪贴板)，本插件不感知 DOM。
 * 2. 实时提交、分段撤销：每次输入立即写入文档 (外框随文字伸缩、协同方实时可见)。连续打字合并为一步；
 *    格式调整各自成一步，打断打字段 (撤销先回退格式后的文字，再回退格式)；同一目标连续改同一项取值
 *    (颜色、字号、对齐) 合并为一步，试色不必逐个撤销；加粗等开关不合并，否则开关两次会合成一步空撤销。
 *    编辑中按 Ctrl+Z 先退出编辑再撤销。
 * 3. 输入法组合文字只在本地显示 (会话中的 composition，带下划线插入排版)，确认后才写入文档，协同方看不到拼音。
 * 4. 超出文本框的文字裁剪显示：光标、拖选自动滚动到可见，滚轮在文本框内滚动文字；滚动是本地状态，不进入文档。
 * 5. 编辑时占用最高优先级的键盘作用域并消费全部按键：Delete、空格等不会落到删除节点、平移画布等画布快捷键；
 *    字符键与复制粘贴不阻止默认行为，交给输入通道。
 * 6. 格式目标由插件决定：编辑中作用于文字选区 (空选区作用于接下来输入的文字)，未编辑时作用于选中节点的整块文字；
 *    界面只调用同一组方法。
 * 7. 删空即删除：节点类型声明 removeWhenEmpty (自由文本) 时，退出编辑文字为空则删除节点，与编辑同组撤销。
 * 8. 与其他插件零耦合：编辑目标写入会话 (textEditing)，渲染器据此显示编辑视图，变换控制柄据此隐藏。
 * 9. 文字可以属于节点或连线 (ADR-125)：两者只在「文字块从哪来、图元在哪个坐标系」上不同 (OwnerText)，
 *    光标、选区、输入法与格式完全共用。双击线上的文字编辑它，双击线上别处新加一段，删空即移除。
 */

import {
  CLEAR_FORMAT_PATCH,
  IDENTITY_MATRIX,
  applyMatrix,
  applyRunStyle,
  caretRect,
  editingTextBounds,
  editingTextPrimitive,
  findTextSlot,
  generateId,
  getRunsText,
  hitTestText,
  isPointInBounds,
  invertMatrix,
  layoutText,
  transformBounds,
  mergeStyle,
  nextWordBoundary,
  offsetAtX,
  paragraphRangeAt,
  paragraphsRange,
  parseRichTextRuns,
  previousWordBoundary,
  projectOntoPolyline,
  replaceRuns,
  replaceText,
  runStyleAt,
  selectionRects,
  selectionRunStyle,
  sliceRuns,
  stepOffset,
  wordRangeAt,
  worldToScreen,
  type CanvasKeyboardEvent,
  type CanvasPatch,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type CanvasWheelEvent,
  type CaretAffinity,
  type ConnectorEntity,
  type DocumentChangeSet,
  type FontMeasurer,
  type Matrix2D,
  type NodeEntity,
  type Point,
  type PointerHooks,
  type RichTextRun,
  type RichTextRunStyle,
  type RichTextStylePatch,
  type SessionChange,
  type SkyNotePlugin,
  type TextAlign,
  type TextBlock,
  type TextClipboardContent,
  type TextComposition,
  type TextHit,
  type TextInputHandler,
  type TextInputSession,
  type TextLayout,
  type TextPrimitive,
  type NodeTextSlotDefinition,
  type RectBounds,
  type VerticalAlign
} from '@skynote/core';
import { blockRunStyle, commonStyle, formatPatch, isFormatActive, type TextFormat } from './text-format';
import { resolveGroupTarget } from './group-selection';

export const TEXT_EDIT_PLUGIN_ID = '@skynote/plugins-basic/text-edit';
/** 高于变换控制柄 (50)：编辑中按在文字上是定位光标；滚轮高于视口平移 (-100) */
const TEXT_EDIT_PRIORITY = 60;
/** 编辑态消费全部按键，必须高于所有画布快捷键作用域 */
const SCOPE_PRIORITY = 1000;
const OVERLAY_SESSION = 'text-edit';
const CARET_BLINK_MS = 530;
/** 光标的屏幕宽度 */
const CARET_WIDTH_PX = 1.5;
/** 选区高亮透明度 */
const SELECTION_OPACITY = 0.25;
/** 拖选越出文本框时自动滚动的间隔与速度 (每帧滚动 = 越出的屏幕距离 × 系数，有上限) */
const AUTO_SCROLL_INTERVAL_MS = 16;
const AUTO_SCROLL_FACTOR = 0.3;
const AUTO_SCROLL_MAX_PX = 24;

/** Ctrl / Cmd + 键 → 格式 */
const FORMAT_SHORTCUTS: Readonly<Record<string, TextFormat>> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
  'shift+x': 'strikethrough'
};

/** 文字所属的实体类别 */
export type TextOwnerKind = 'node' | 'connector';

const COLLECTIONS: Readonly<Record<TextOwnerKind, 'nodes' | 'connectors'>> = { node: 'nodes', connector: 'connectors' };

/** 实体上可编辑的文字：文字块、各块的文字图元 (实体局部坐标) 与局部到世界的矩阵 */
interface OwnerText {
  readonly blocks: readonly TextBlock[];
  readonly primitives: readonly TextPrimitive[];
  readonly toWorld: Matrix2D;
}

/** 编辑态快照 */
export interface TextEditSnapshot {
  readonly kind: TextOwnerKind;
  readonly id: string;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
}

/** 取值类格式：同一目标连续调整合并为一步撤销 (开关类格式不在此列) */
const MERGEABLE_STYLE_KEYS: ReadonlySet<string> = new Set(['color', 'backgroundColor', 'fontSize']);

/** 当前格式目标 (编辑选区或选中节点的整块文字) 的样式，浮动工具栏据此显示按下态 */
export interface TextFormatState {
  /** 全部目标文字共有的生效样式 (分段样式覆盖块样式后取值一致的键) */
  readonly style: RichTextRunStyle;
  /** 段落对齐；各段不一致时为 undefined */
  readonly align: TextAlign | undefined;
  /** 文字在文本框内的垂直对齐；各块不一致或没有固定高度的文字块时为 undefined */
  readonly verticalAlign: VerticalAlign | undefined;
  /** 目标中有固定高度的文字块 (便签、形状标签)：垂直对齐对它们有效 */
  readonly verticalAlignable: boolean;
}

interface EditState {
  readonly kind: TextOwnerKind;
  readonly id: string;
  readonly blockId: string;
  /** 编辑块所属插槽：决定是否纯文本、是否单行 */
  readonly slot: NodeTextSlotDefinition | undefined;
  anchor: number;
  focus: number;
  affinity: CaretAffinity;
  /** 上下移动时保持的水平位置 (文本框坐标) */
  goalX: number | null;
  /** 光标处待输入文字的样式 (空选区时切换加粗等) */
  typingStyle: RichTextStylePatch | null;
  /** 输入法组合中的文字 (只在本地显示) */
  composition: TextComposition | null;
  /** 文字超出文本框时的滚动距离 */
  scrollY: number;
  /** 当前打字段的撤销组：格式调整后换新，格式与前后的打字各自撤销 */
  groupId: string;
  readonly input: TextInputSession;
  readonly disposeScope: () => void;
}

/** 编辑块的几何：编辑视图图元 (实体局部坐标)、其排版与实体到世界的矩阵 */
interface BlockGeometry {
  readonly primitive: TextPrimitive;
  readonly layout: TextLayout;
  readonly toWorld: Matrix2D;
  readonly blockIndex: number;
  /** 文档中的分段 (不含组合文字) */
  readonly runs: readonly RichTextRun[];
}

/** 一个格式目标：某个文字块的 [start, end) */
interface FormatBlock {
  readonly kind: TextOwnerKind;
  readonly id: string;
  readonly blockIndex: number;
  readonly runs: readonly RichTextRun[];
  /** 块的最终样式 (插槽默认 < 节点 < 文字块) */
  readonly blockStyle: TextPrimitive['style'];
  /** 文字块自身的样式 (垂直对齐写在这里) */
  readonly ownStyle: TextBlock['style'];
  /** 文本框有固定高度：垂直对齐只对这类文字块有意义 */
  readonly fixedHeight: boolean;
  readonly start: number;
  readonly end: number;
}

export class TextEditPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = TEXT_EDIT_PLUGIN_ID;
  readonly name = '文字编辑';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private state: EditState | null = null;
  /** 上一次可合并的格式调整 (属性 + 目标范围)：紧接着的同类调整并入它的撤销组 */
  private lastFormat: { key: string; groupId: string } | null = null;
  /** 拖选中的指针与最近的落点 (自动滚动时据此重新定位) */
  private drag: { pointerId: number; point: Point } | null = null;
  private autoScrollTimer: ReturnType<typeof setInterval> | null = null;
  private autoScrollStep = 0;
  private caretVisible = true;
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private releaseEditRequests: (() => void) | null = null;

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerPointerHooks(this, TEXT_EDIT_PRIORITY);
    // 其他插件 (如导图新建主题) 请求立即输入：进入该节点第一个文字块的编辑并全选，接着输入即替换
    this.releaseEditRequests = ctx.session.onTextEditRequest((nodeId, blockId) =>
      this.enterNodeSelectingAll(nodeId, blockId)
    );
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  unmount(): void {
    this.releaseEditRequests?.();
    this.releaseEditRequests = null;
    // 卸载时只释放编辑态，不再修改文档
    const { state } = this;
    if (!state) return;
    this.state = null;
    this.stopTimers();
    state.input.close();
    state.disposeScope();
  }

  // ================= 对外 API =================

  /** 当前编辑态；未在编辑时为 null */
  get snapshot(): TextEditSnapshot | null {
    const { state } = this;
    if (!state) return null;
    const [start, end] = this.range(state);
    return { kind: state.kind, id: state.id, blockId: state.blockId, start, end };
  }

  /** 当前格式目标的样式；没有可设置格式的文字时为 null */
  get formatState(): TextFormatState | null {
    const blocks = this.formatBlocks();
    if (blocks.length === 0) return null;
    const style = commonStyle(
      blocks.map((b) =>
        selectionRunStyle(
          b.runs.map((run) => ({ ...blockRunStyle(b.blockStyle), ...run })),
          b.start,
          b.end
        )
      )
    );
    const { state } = this;
    const typing = state && state.anchor === state.focus && state.typingStyle;
    const aligns = new Set(blocks.map((b) => this.alignAt(b)));
    const fixed = blocks.filter((b) => b.fixedHeight);
    const verticalAligns = new Set(fixed.map((b) => b.blockStyle.verticalAlign ?? 'top'));
    return {
      style: typing ? mergeStyle(style, typing) : style,
      align: aligns.size === 1 ? [...aligns][0] : undefined,
      verticalAlign: verticalAligns.size === 1 ? [...verticalAligns][0] : undefined,
      verticalAlignable: fixed.length > 0
    };
  }

  /**
   * 编辑中文字的世界外接框 (含延展出文本框的部分与旋转)，界面据此把工具栏放在文字旁；未编辑时为 null
   * 用世界坐标而非屏幕坐标：视口变化时由界面换算，插件不必随平移缩放广播
   */
  get editingBounds(): RectBounds | null {
    const geometry = this.state && this.geometry(this.state);
    return geometry && transformBounds(editingTextBounds(geometry.primitive, geometry.layout), geometry.toWorld);
  }

  /** 订阅编辑态与格式目标的变化 (进入、退出、选区、样式，以及未编辑时选中节点的变化) */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 为格式目标设置样式；编辑中空选区时作用于接下来输入的文字 */
  applyStyle(patch: RichTextStylePatch): void {
    const { state } = this;
    if (state && state.anchor === state.focus) {
      state.typingStyle = { ...state.typingStyle, ...patch };
      this.refresh(false);
      state.input.focus();
      return;
    }
    const keys = Object.keys(patch);
    this.commitBlocks(
      this.formatBlocks(),
      (b) => applyRunStyle(b.runs, b.start, b.end, patch),
      '设置文字格式',
      keys.every((key) => MERGEABLE_STYLE_KEYS.has(key)) ? keys.sort().join() : undefined
    );
  }

  /** 加粗、斜体、下划线、删除线：目标全部已有该格式时取消，否则全部加上 */
  toggleFormat(format: TextFormat): void {
    const current = this.formatState;
    if (!current) return;
    const on = !isFormatActive(current.style, format);
    const { state } = this;
    if (state && state.anchor === state.focus) {
      const block = this.formatBlocks()[0].blockStyle;
      this.applyStyle(formatPatch(format, on, current.style, block));
      return;
    }
    this.commitBlocks(
      this.formatBlocks(),
      (b) => applyRunStyle(b.runs, b.start, b.end, formatPatch(format, on, current.style, b.blockStyle)),
      '设置文字格式'
    );
  }

  /** 清除行内格式 (保留段落对齐) */
  clearFormat(): void {
    this.applyStyle(CLEAR_FORMAT_PATCH);
  }

  /** 段落对齐：编辑中作用于选区覆盖的段落，未编辑时作用于整块文字 */
  setAlign(align: TextAlign): void {
    const blocks = this.formatBlocks().map((b) => {
      const text = getRunsText(b.runs);
      return { ...b, ...paragraphsRange(text, b.start, b.end) };
    });
    const { state } = this;
    // 光标所在的末尾空段落没有可承载对齐的字：记为待输入样式
    if (state && blocks[0] && blocks[0].start === blocks[0].end) {
      state.typingStyle = { ...state.typingStyle, textAlign: align };
    }
    this.commitBlocks(
      blocks,
      (b) => applyRunStyle(b.runs, b.start, b.end, { textAlign: align }),
      '段落对齐',
      'textAlign'
    );
  }

  /** 垂直对齐：写入文字块自身的样式 (整块生效)，只作用于有固定高度的文字块 */
  setVerticalAlign(verticalAlign: VerticalAlign): void {
    const blocks = this.formatBlocks().filter((b) => b.fixedHeight);
    const patches: CanvasPatch[] = blocks.map((b) => ({
      op: 'set',
      path: ['content', COLLECTIONS[b.kind], b.id, 'textBlocks', b.blockIndex, 'style'],
      value: { ...b.ownStyle, verticalAlign }
    }));
    this.commitFormat(blocks, patches, '垂直对齐', 'verticalAlign');
  }

  /** 退出编辑 (保留节点选中) */
  exit(): void {
    const { state } = this;
    if (!state) return;
    this.state = null;
    this.stopTimers();
    state.input.close();
    state.disposeScope();
    this.ctx.host.overlay.clear(OVERLAY_SESSION);
    this.ctx.session.setTextEditing(null);
    this.removeIfEmpty(state);
    this.emit();
  }

  // ================= 指针 =================

  onPointerDown(e: CanvasPointerEvent): void {
    if (this.ctx.session.isReadOnly) {
      if (this.state) this.exit();
      return;
    }
    if (e.isClaimed || e.button !== 0) return;
    const { state } = this;
    if (state) {
      const geometry = this.geometry(state);
      if (!geometry || !this.isInside(state, e.point, geometry)) {
        // 点在编辑区之外：退出编辑，交给选择等交互照常处理
        this.exit();
        return;
      }
      e.claimPointer(TEXT_EDIT_PLUGIN_ID);
      this.pointAt(state, geometry, e);
      if (e.clickCount === 1) {
        this.drag = { pointerId: e.pointerId, point: e.point };
        this.ctx.host.capturePointer(e.pointerId);
      }
      state.input.focus();
      return;
    }
    if (e.clickCount !== 2) return;
    // 节点与连线都点中时按画面层叠取最上层 (与点选一致)
    const hit = this.ctx.hitTest(e.point);
    const entered =
      hit?.kind === 'connector'
        ? !hit.connector.locked && this.enterConnector(hit.connector, e.point)
        : !!e.target && resolveGroupTarget(this.ctx, e.target.id) === e.target.id && this.enterNode(e.target, e.point);
    if (entered) e.claimPointer(TEXT_EDIT_PLUGIN_ID);
  }

  onPointerMove(e: CanvasPointerEvent): void {
    if (this.ctx.session.isReadOnly) return;
    const { state, drag } = this;
    const geometry = state && this.geometry(state);
    if (!state || !geometry) return;
    if (drag?.pointerId === e.pointerId) {
      drag.point = e.point;
      this.dragTo(state, geometry, e.point);
      this.updateAutoScroll(geometry, e.point);
      return;
    }
    if (!e.isClaimed) this.ctx.host.setCursor(this.isInside(state, e.point, geometry) ? 'text' : 'default');
  }

  onPointerUp(e: CanvasPointerEvent): void {
    if (this.drag?.pointerId !== e.pointerId) return;
    this.drag = null;
    this.stopAutoScroll();
    this.ctx.host.releasePointer(e.pointerId);
    this.state?.input.focus();
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    this.onPointerUp(e);
  }

  /** 编辑中滚轮落在编辑节点上且文字超出文本框：滚动文字而不是平移画布 */
  onWheel(e: CanvasWheelEvent): void {
    const { state } = this;
    const geometry = state && this.geometry(state);
    if (!state || !geometry || e.deltaZoom !== 0 || this.maxScroll(geometry) === 0) return;
    if (!this.isInside(state, e.centerPoint, geometry)) return;
    e.stopPropagation?.();
    this.scrollTo(state, geometry, state.scrollY - e.deltaPan.y / this.ctx.session.viewport.zoom);
  }

  // ================= 进入与定位 =================

  /** 双击节点进入编辑：定位到点中的文字块 (都没点中时取框内的第一个)，光标放在点击处 */
  private enterNode(node: Readonly<NodeEntity>, point: Point): boolean {
    const blocks = this.textPrimitives(node);
    const toWorld = this.ctx.entities.getWorldTransform(node.id);
    const fonts = this.ctx.document.fonts;
    if (blocks.length === 0 || !toWorld || !fonts) return false;
    const local = applyMatrix(invertMatrix(toWorld), point.x, point.y);
    // 文字框的实际范围：未限定宽高的 (如自适应文本、画框标题) 按排版结果
    const contains = (p: TextPrimitive, pad = 0): boolean => {
      const layout =
        p.width === undefined || p.height === undefined
          ? layoutText(p.runs, p.style, { width: p.width, height: p.height }, fonts)
          : null;
      const width = p.width ?? layout!.width;
      const height = p.height ?? layout!.height;
      return (
        local.x >= p.x - pad && local.y >= p.y - pad && local.x <= p.x + width + pad && local.y <= p.y + height + pad
      );
    };
    const primitive =
      blocks.find((p) => contains(p, 0)) ??
      blocks.find((p) => contains(p, 8)) ??
      // 没点中文字时取框内的第一个文字块 (如点在便签内边距上)；多文字块节点 (如表格) 须点中对应块，不随意回退到第一块
      (blocks.length === 1 ? blocks.find((p) => p.x >= 0 && p.y >= 0) : undefined);
    if (!primitive) return false;
    this.ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    const block = node.textBlocks!.find((b) => b.id === primitive.id)!;
    this.start('node', node.id, primitive.id!, findTextSlot(block, this.ctx.nodeTypes.get(node.nodeType)), point);
    return true;
  }

  /** 按请求进入节点编辑：优先取框内的第一个文字块 (没有时取框外的，如画框标题) 并全选 */
  private enterNodeSelectingAll(nodeId: string, blockId?: string): void {
    if (this.ctx.session.isReadOnly) return;
    const node = this.ctx.document.getNode(nodeId);
    if (!node || node.locked) return;
    const blocks = this.textPrimitives(node);
    const primitive =
      blockId === undefined
        ? (blocks.find((p) => p.x >= 0 && p.y >= 0) ?? blocks[0])
        : blocks.find((p) => p.id === blockId);
    if (!primitive) return;
    this.exit();
    this.ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    const block = node.textBlocks!.find((b) => b.id === primitive.id)!;
    this.start('node', node.id, primitive.id!, findTextSlot(block, this.ctx.nodeTypes.get(node.nodeType)), null);
  }

  /**
   * 双击连线编辑线上的文字：双击在某段文字上时编辑它，双击在线上没有文字的地方时在该处新加一段；
   * 新建与随后的输入同组撤销，什么都没输入就退出时移除
   */
  private enterConnector(connector: Readonly<ConnectorEntity>, point: Point): boolean {
    if (this.ctx.session.isReadOnly) return false;
    const route = this.ctx.connectors.getConnectorRoute(connector.id);
    if (!route || !this.ctx.document.fonts) return false;
    const groupId = generateId('text-edit');
    const hit = route.labels.find(({ bounds }) => isPointInBounds(point, bounds));
    let blockId = hit?.blockId;
    if (!blockId) {
      const block = { id: generateId('label'), runs: [], position: projectOntoPolyline(route.points, point) };
      blockId = block.id;
      this.ctx.document.updateConnector(
        connector.id,
        { textBlocks: [...(connector.textBlocks ?? []), block] },
        { label: '编辑文字', groupId }
      );
    }
    this.ctx.session.setSelection({ nodeIds: [], connectorIds: [connector.id] });
    this.start('connector', connector.id, blockId, undefined, point, groupId);
    return true;
  }

  /** 打开输入通道与键盘作用域，进入编辑并把光标放在 point 处 */
  private start(
    kind: TextOwnerKind,
    id: string,
    blockId: string,
    slot: NodeTextSlotDefinition | undefined,
    /** 光标放在此处；null 时全选 */
    point: Point | null,
    groupId = generateId('text-edit')
  ): void {
    const handler: TextInputHandler = {
      insertText: (text) => this.insertText(text),
      paste: (content) => this.paste(content),
      compositionStart: () => this.compositionStart(),
      compositionUpdate: (text) => this.compositionUpdate(text),
      compositionEnd: (text) => this.compositionEnd(text),
      copySelection: () => this.clipboardContent(),
      cutSelection: () => {
        const content = this.clipboardContent();
        if (content) this.insertText('');
        return content;
      }
    };
    const state: EditState = {
      kind,
      id,
      blockId,
      slot,
      anchor: 0,
      focus: 0,
      affinity: 'forward',
      goalX: null,
      typingStyle: null,
      composition: null,
      scrollY: 0,
      groupId,
      input: this.ctx.host.openTextInput(handler),
      disposeScope: this.ctx.registerInputScope({
        id: 'text:editing',
        priority: SCOPE_PRIORITY,
        onKeyDown: (e) => this.onKeyDown(e)
      })
    };
    this.state = state;
    const geometry = this.geometry(state);
    if (geometry && point) {
      const hit = this.hit(geometry, point);
      state.anchor = state.focus = hit.offset;
      state.affinity = hit.affinity;
    } else if (geometry) {
      state.focus = getRunsText(geometry.runs).length;
    }
    this.refresh();
  }

  /** 单击定位光标 (Shift 扩展选区)，双击选词，三击选段落 */
  private pointAt(state: EditState, geometry: BlockGeometry, e: CanvasPointerEvent): void {
    const hit = this.hit(geometry, e.point);
    const text = getRunsText(geometry.runs);
    state.goalX = null;
    state.typingStyle = null;
    if (e.clickCount === 2 || e.clickCount === 3) {
      const range = e.clickCount === 2 ? wordRangeAt(text, hit.offset) : paragraphRangeAt(text, hit.offset);
      state.anchor = range.start;
      state.focus = range.end;
    } else {
      if (!e.modifiers.shift) state.anchor = hit.offset;
      state.focus = hit.offset;
      state.affinity = hit.affinity;
    }
    this.refresh();
  }

  private dragTo(state: EditState, geometry: BlockGeometry, point: Point): void {
    const hit = this.hit(geometry, point);
    state.focus = hit.offset;
    state.affinity = hit.affinity;
    state.goalX = null;
    this.refresh();
  }

  // ================= 滚动 =================

  /** 可滚动的最大距离：内容底部超出文本框的部分 */
  private maxScroll(geometry: BlockGeometry): number {
    const { primitive, layout } = geometry;
    const last = layout.lines[layout.lines.length - 1];
    if (primitive.height === undefined || !last) return 0;
    return Math.max(0, last.top + last.height - primitive.height);
  }

  private scrollTo(state: EditState, geometry: BlockGeometry, scrollY: number): void {
    const next = Math.min(Math.max(scrollY, 0), this.maxScroll(geometry));
    if (next === state.scrollY) return;
    state.scrollY = next;
    this.refresh(false);
  }

  /** 拖选越出文本框上下边时按帧自动滚动 (越出越多滚得越快)，回到框内即停 */
  private updateAutoScroll(geometry: BlockGeometry, point: Point): void {
    const { primitive } = geometry;
    const local = applyMatrix(invertMatrix(geometry.toWorld), point.x, point.y);
    const y = local.y - primitive.y;
    const height = primitive.height ?? Infinity;
    const outside = y < 0 ? y : y > height ? y - height : 0;
    const zoom = this.ctx.session.viewport.zoom;
    const step =
      (Math.sign(outside) * Math.min(Math.abs(outside) * zoom * AUTO_SCROLL_FACTOR, AUTO_SCROLL_MAX_PX)) / zoom;
    this.autoScrollStep = step;
    if (step === 0) {
      this.stopAutoScroll();
      return;
    }
    this.autoScrollTimer ??= setInterval(() => {
      const { state, drag } = this;
      const current = state && this.geometry(state);
      if (!state || !current || !drag) return;
      this.scrollTo(state, current, state.scrollY + this.autoScrollStep);
      this.dragTo(state, current, drag.point);
    }, AUTO_SCROLL_INTERVAL_MS);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer !== null) clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = null;
    this.autoScrollStep = 0;
  }

  /** 让光标 (组合文字末尾) 可见 */
  private revealCaret(state: EditState, geometry: BlockGeometry): void {
    const height = geometry.primitive.height;
    const caret = caretRect(geometry.layout, this.caretOffset(state), state.affinity, this.fonts);
    if (height === undefined || !caret) return;
    let scrollY = state.scrollY;
    if (caret.top < scrollY) scrollY = caret.top;
    else if (caret.top + caret.height > scrollY + height) scrollY = caret.top + caret.height - height;
    state.scrollY = Math.min(Math.max(scrollY, 0), this.maxScroll(geometry));
  }

  // ================= 键盘 =================

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    const { state } = this;
    const geometry = state && this.geometry(state);
    if (!state || !geometry) return false;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // 单行文字 (如画框标题) 与表单输入框一致：Tab 确认并退出编辑，按键继续下传给更低优先级的作用域
    const node = state.kind === 'node' ? this.ctx.document.getNode(state.id) : undefined;
    if (
      key === 'Tab' &&
      (state.slot?.singleLine || (node && this.ctx.nodeTypes.get(node.nodeType)?.tabNavigatesTextBlocks))
    ) {
      this.exit();
      return false;
    }
    if (this.handleKey(state, geometry, key, mod, e.shiftKey)) e.preventDefault();
    // 其余按键 (字符、复制粘贴) 保留默认行为交给输入通道，但不再下传给画布快捷键
    return true;
  }

  /** @returns 是否由编辑器处理 (需阻止默认行为) */
  private handleKey(state: EditState, geometry: BlockGeometry, key: string, mod: boolean, shift: boolean): boolean {
    const text = getRunsText(geometry.runs);
    const [start, end] = this.range(state);
    if (key === 'Escape' || (key === 'Enter' && state.slot?.singleLine)) {
      this.exit();
      return true;
    }
    if (mod && (key === 'z' || key === 'y')) {
      // 先退出编辑再撤销 / 重做：撤销会改写正在编辑的文字，光标与选区随之失效
      this.exit();
      if (key === 'z' && !shift) this.ctx.document.undo();
      else this.ctx.document.redo();
      return true;
    }
    if (mod && key === 'a') {
      this.select(state, 0, text.length);
      return true;
    }
    const format = mod ? FORMAT_SHORTCUTS[shift ? `shift+${key}` : key] : undefined;
    if (format) {
      this.toggleFormat(format);
      return true;
    }
    if (key === 'Backspace' || key === 'Delete') {
      if (start !== end) {
        this.insertText('');
        return true;
      }
      const forward = key === 'Delete';
      const target = forward
        ? mod
          ? nextWordBoundary(text, start)
          : stepOffset(text, start, 1)
        : mod
          ? previousWordBoundary(text, start)
          : stepOffset(text, start, -1);
      if (target !== start) {
        state.anchor = Math.min(start, target);
        state.focus = Math.max(start, target);
        this.insertText('');
      }
      return true;
    }
    if (key === 'Tab') return true;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const direction = key === 'ArrowLeft' ? -1 : 1;
      const next =
        start !== end && !shift
          ? direction < 0
            ? start
            : end
          : mod
            ? direction < 0
              ? previousWordBoundary(text, state.focus)
              : nextWordBoundary(text, state.focus)
            : stepOffset(text, state.focus, direction);
      this.moveFocus(state, next, shift, 'forward');
      return true;
    }
    const caret = caretRect(geometry.layout, state.focus, state.affinity, this.fonts);
    // 文字框比内边距还窄时没有可排版的行，方向键无处可去
    if (!caret) return key.startsWith('Arrow') || key === 'Home' || key === 'End';
    if (key === 'Home' || key === 'End') {
      const line = geometry.layout.lines[caret.lineIndex];
      const next = mod ? (key === 'Home' ? 0 : text.length) : key === 'Home' ? line.start : line.end;
      this.moveFocus(state, next, shift, key === 'End' && !line.hardBreak ? 'backward' : 'forward');
      return true;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const goalX = state.goalX ?? caret.x;
      const lineIndex = caret.lineIndex + (key === 'ArrowUp' ? -1 : 1);
      const { lines } = geometry.layout;
      if (lineIndex < 0) this.moveFocus(state, 0, shift, 'forward');
      else if (lineIndex >= lines.length) this.moveFocus(state, text.length, shift, 'forward');
      else {
        const hit = offsetAtX(geometry.layout, lineIndex, goalX, this.fonts);
        this.moveFocus(state, hit.offset, shift, hit.affinity);
      }
      state.goalX = goalX;
      return true;
    }
    return false;
  }

  private moveFocus(state: EditState, offset: number, extend: boolean, affinity: CaretAffinity): void {
    state.focus = offset;
    if (!extend) state.anchor = offset;
    state.affinity = affinity;
    state.goalX = null;
    state.typingStyle = null;
    this.refresh();
  }

  private select(state: EditState, anchor: number, focus: number): void {
    state.anchor = anchor;
    state.focus = focus;
    state.goalX = null;
    state.typingStyle = null;
    this.refresh();
  }

  // ================= 文字变更 =================

  /** 光标处新输入文字的样式：前一个字的样式叠加待输入样式 */
  private typingRunStyle(state: EditState, runs: readonly RichTextRun[], offset: number): RichTextRunStyle {
    const base = runStyleAt(runs, offset);
    return state.typingStyle ? mergeStyle(base, state.typingStyle) : base;
  }

  /** 用文字替换选区 (空串即删除) */
  private insertText(text: string): void {
    const { state } = this;
    const geometry = state && this.geometry(state);
    if (!state || !geometry) return;
    const [start, end] = this.range(state);
    const style = this.typingRunStyle(state, geometry.runs, start);
    const value = state.slot?.singleLine ? text.replace(/\r?\n/g, ' ') : text;
    this.replaceSelection(state, geometry, replaceText(geometry.runs, start, end, value, style), start + value.length);
  }

  /** 粘贴：剪贴板带画布富文本分段时保留样式 (纯文本插槽除外)，否则按纯文本插入 */
  private paste(content: TextClipboardContent): void {
    const { state } = this;
    const geometry = state && this.geometry(state);
    const runs = content.richText && !state?.slot?.plainText ? parseRichTextRuns(content.richText) : null;
    if (!state || !geometry || !runs) {
      this.insertText(content.text);
      return;
    }
    const [start, end] = this.range(state);
    const normalized = state.slot?.singleLine
      ? runs.map((run) => ({ ...run, text: run.text.replace(/\r\n?|\n/g, ' ') }))
      : runs;
    this.replaceSelection(
      state,
      geometry,
      replaceRuns(geometry.runs, start, end, normalized),
      start + getRunsText(normalized).length
    );
  }

  private replaceSelection(state: EditState, geometry: BlockGeometry, runs: RichTextRun[], caret: number): void {
    this.commitRuns(state, geometry.blockIndex, runs);
    state.anchor = state.focus = caret;
    state.affinity = 'forward';
    state.goalX = null;
    state.typingStyle = null;
    this.refresh();
  }

  /** 输入法组合开始：先删除选区，组合文字只在本地显示 */
  private compositionStart(): void {
    const { state } = this;
    const geometry = state && this.geometry(state);
    if (!state || !geometry) return;
    if (state.anchor !== state.focus) this.insertText('');
    const offset = state.focus;
    state.composition = { offset, text: '', style: this.typingRunStyle(state, geometry.runs, offset) };
    this.refresh();
  }

  private compositionUpdate(text: string): void {
    const { state } = this;
    if (!state?.composition) return;
    state.composition = { ...state.composition, text };
    this.refresh();
  }

  /** 确认后才写入文档 (取消时 text 为空串，什么也不写) */
  private compositionEnd(text: string): void {
    const { state } = this;
    if (!state?.composition) return;
    const { style } = state.composition;
    state.composition = null;
    if (text) {
      const geometry = this.geometry(state)!;
      const [start, end] = this.range(state);
      this.replaceSelection(state, geometry, replaceText(geometry.runs, start, end, text, style), start + text.length);
    } else {
      this.refresh();
    }
  }

  /** 复制内容：纯文本与富文本分段；空选区为 null */
  private clipboardContent(): TextClipboardContent | null {
    const { state } = this;
    const geometry = state && this.geometry(state);
    if (!state || !geometry) return null;
    const [start, end] = this.range(state);
    if (start === end) return null;
    return {
      text: getRunsText(geometry.runs).slice(start, end),
      richText: JSON.stringify(sliceRuns(geometry.runs, start, end))
    };
  }

  private commitRuns(state: EditState, blockIndex: number, runs: RichTextRun[]): void {
    this.ctx.document.commit({
      label: '编辑文字',
      groupId: state.groupId,
      patches: [
        {
          op: 'set',
          path: ['content', COLLECTIONS[state.kind], state.id, 'textBlocks', blockIndex, 'runs'],
          value: runs
        }
      ]
    });
  }

  /** 按格式目标逐块改写分段，一次提交 */
  private commitBlocks(
    blocks: readonly FormatBlock[],
    transform: (block: FormatBlock) => RichTextRun[],
    label: string,
    mergeKey?: string
  ): void {
    const patches: CanvasPatch[] = blocks.map((b) => ({
      op: 'set',
      path: ['content', COLLECTIONS[b.kind], b.id, 'textBlocks', b.blockIndex, 'runs'],
      value: transform(b)
    }));
    this.commitFormat(blocks, patches, label, mergeKey);
  }

  /**
   * 格式调整单独成一步撤销：mergeKey 与目标范围都和上一次相同时并入上一次的撤销组
   * (撤销栈只合并紧邻的同组条目，中间夹了别的操作自然不会合并)；编辑中随后的打字另起一段
   */
  private commitFormat(
    blocks: readonly FormatBlock[],
    patches: CanvasPatch[],
    label: string,
    mergeKey: string | undefined
  ): void {
    if (patches.length === 0) return;
    const key = mergeKey && `${mergeKey}|${blocks.map((b) => `${b.id}:${b.blockIndex}:${b.start}:${b.end}`).join()}`;
    const groupId = key && this.lastFormat?.key === key ? this.lastFormat.groupId : generateId('text-format');
    this.ctx.document.commit({ label, groupId, patches });
    this.lastFormat = key ? { key, groupId } : null;
    if (this.state) {
      this.state.groupId = generateId('text-edit');
      this.refresh(false);
      // 格式可能来自会拿走焦点的界面控件 (如颜色面板的十六进制输入框)：交还输入通道，接着就能打字
      this.state.input.focus();
    }
  }

  /**
   * 删空即移除，与本次编辑同组提交 (撤销一步即恢复原有文字)：
   * 节点类型声明 removeWhenEmpty (如自由文本) 时删除节点；连线移除空的那段文字
   */
  private removeIfEmpty(state: EditState): void {
    const { document } = this.ctx;
    if (state.kind === 'connector') {
      const blocks = document.getConnector(state.id)?.textBlocks;
      if (!blocks) return;
      const rest = blocks.filter((block) => block.id !== state.blockId || getRunsText(block.runs) !== '');
      if (rest.length === blocks.length) return;
      document.updateConnector(
        state.id,
        { textBlocks: rest.length > 0 ? rest : undefined },
        { label: '删除空文本', groupId: state.groupId }
      );
      return;
    }
    const node = document.getNode(state.id);
    if (!node || !this.ctx.nodeTypes.get(node.nodeType)?.removeWhenEmpty) return;
    if (node.textBlocks?.some((block) => getRunsText(block.runs) !== '')) return;
    document.removeEntities({ nodeIds: [state.id] }, { label: '删除空文本', groupId: state.groupId });
  }

  // ================= 格式目标 =================

  /** 编辑中为选区所在文字块，否则为选中节点 (未锁定) 的全部文字块 */
  private formatBlocks(): FormatBlock[] {
    const { state } = this;
    if (state?.kind === 'connector') {
      const geometry = this.geometry(state);
      if (!geometry) return [];
      const [start, end] = this.range(state);
      return [
        {
          kind: 'connector',
          id: state.id,
          blockIndex: geometry.blockIndex,
          runs: geometry.runs,
          blockStyle: geometry.primitive.style,
          ownStyle: this.ctx.document.getConnector(state.id)!.textBlocks![geometry.blockIndex].style,
          fixedHeight: false,
          start,
          end: Math.min(end, getRunsText(geometry.runs).length)
        }
      ];
    }
    const nodeIds = state ? [state.id] : this.ctx.session.selectedNodeIds;
    const blockSelection = !state ? this.ctx.session.selectedTextBlocks : null;
    const [start, end] = state ? this.range(state) : [0, Infinity];
    const blocks: FormatBlock[] = [];
    for (const id of nodeIds) {
      const node = this.ctx.document.getNode(id);
      if (!node || (!state && node.locked)) continue;
      const definition = this.ctx.nodeTypes.get(node.nodeType);
      for (const primitive of this.textPrimitives(node)) {
        if (state && primitive.id !== state.blockId) continue;
        if (blockSelection?.nodeId === id && (!primitive.id || !blockSelection.blockIds.has(primitive.id))) continue;
        const blockIndex = node.textBlocks?.findIndex((b) => b.id === primitive.id) ?? -1;
        if (blockIndex < 0) continue;
        const block = node.textBlocks![blockIndex];
        // 插件声明为纯文本的插槽由节点类型固定外观，不作为格式目标。
        if (findTextSlot(block, definition)?.plainText) continue;
        blocks.push({
          kind: 'node',
          id,
          blockIndex,
          runs: block.runs,
          blockStyle: primitive.style,
          ownStyle: block.style,
          fixedHeight: primitive.height !== undefined,
          start,
          end: Math.min(end, getRunsText(block.runs).length)
        });
      }
    }
    return blocks;
  }

  /** 目标起点所在段落的对齐 (与排版取值规则一致) */
  private alignAt(block: FormatBlock): TextAlign {
    const text = getRunsText(block.runs);
    const paragraph = paragraphRangeAt(text, block.start).start;
    const index = paragraph < text.length ? paragraph : paragraph - 1;
    const typing = this.state?.typingStyle?.textAlign;
    const runAlign = index < 0 ? block.runs[0]?.textAlign : runStyleAt(block.runs, index + 1).textAlign;
    return typing ?? runAlign ?? block.blockStyle.textAlign ?? 'left';
  }

  // ================= 几何 =================

  private get fonts(): FontMeasurer {
    return this.ctx.document.fonts!;
  }

  private textPrimitives(node: Readonly<NodeEntity>): TextPrimitive[] {
    const definition = this.ctx.nodeTypes.getValid(node);
    const primitives: CanvasPrimitive[] =
      definition?.compose?.(node as NodeEntity, { theme: this.ctx.session.theme }) ?? [];
    return primitives.filter((p): p is TextPrimitive => p.kind === 'text' && p.id !== undefined);
  }

  /** 实体上的文字：节点按节点类型的 compose 生成 (节点局部坐标)；连线取路由一并排版的文字 (世界坐标) */
  private ownerText(kind: TextOwnerKind, id: string): OwnerText | null {
    const { document, connectors, entities } = this.ctx;
    if (kind === 'connector') {
      const connector = document.getConnector(id);
      const route = connectors.getConnectorRoute(id);
      if (!connector?.textBlocks || !route) return null;
      return {
        blocks: connector.textBlocks,
        primitives: route.labels.map((label) => label.primitive),
        toWorld: IDENTITY_MATRIX
      };
    }
    const node = document.getNode(id);
    const toWorld = entities.getWorldTransform(id);
    if (!node?.textBlocks || !toWorld) return null;
    return { blocks: node.textBlocks, primitives: this.textPrimitives(node), toWorld };
  }

  /** 编辑块的当前几何 (每次按最新文档计算：文字、尺寸或位置随时可能被撤销、协同改变) */
  private geometry(state: EditState): BlockGeometry | null {
    const owner = this.ownerText(state.kind, state.id);
    const fonts = this.ctx.document.fonts;
    const raw = owner?.primitives.find((p) => p.id === state.blockId);
    const blockIndex = owner?.blocks.findIndex((b) => b.id === state.blockId) ?? -1;
    if (!owner || !fonts || !raw || blockIndex < 0) return null;
    const { toWorld } = owner;
    const primitive = editingTextPrimitive(raw, this.editingTarget(state));
    const layout = layoutText(
      primitive.runs,
      primitive.style,
      { width: primitive.width, height: primitive.height },
      fonts
    );
    return { primitive, layout, toWorld, blockIndex, runs: owner.blocks[blockIndex].runs };
  }

  private editingTarget(state: EditState) {
    return {
      kind: state.kind,
      id: state.id,
      blockId: state.blockId,
      scrollY: state.scrollY,
      composition: state.composition
    };
  }

  /** 光标在排版中的偏移：组合中位于组合文字末尾 */
  private caretOffset(state: EditState): number {
    const { composition } = state;
    return composition ? composition.offset + composition.text.length : state.focus;
  }

  /** 世界坐标 → 排版坐标 (文本框坐标加上滚动) */
  private toBox(geometry: BlockGeometry, point: Point): Point {
    const local = applyMatrix(invertMatrix(geometry.toWorld), point.x, point.y);
    return { x: local.x - geometry.primitive.x, y: local.y - geometry.primitive.y + (geometry.primitive.scrollY ?? 0) };
  }

  private hit(geometry: BlockGeometry, point: Point): TextHit {
    return hitTestText(geometry.layout, this.toBox(geometry, point), this.fonts);
  }

  /**
   * 点是否落在编辑区：节点外框 (连线没有) 或编辑中文字的可见范围 (延展出文本框的标题、随输入伸缩的自适应文字)；
   * 在框内滚动的文字超出部分已裁剪，不再可点
   */
  private isInside(state: EditState, point: Point, geometry: BlockGeometry): boolean {
    const local = applyMatrix(invertMatrix(geometry.toWorld), point.x, point.y);
    const node = state.kind === 'node' ? this.ctx.document.getNode(state.id)! : null;
    const isMultiBlock = (node?.textBlocks?.length ?? 0) > 1;
    if (node && !isMultiBlock && local.x >= 0 && local.y >= 0 && local.x <= node.width && local.y <= node.height)
      return true;
    const bounds = editingTextBounds(geometry.primitive, geometry.layout);
    const pad = isMultiBlock ? 8 : 0;
    return (
      local.x >= bounds.left - pad &&
      local.y >= bounds.top - pad &&
      local.x <= bounds.right + pad &&
      local.y <= bounds.bottom + pad
    );
  }

  private range(state: EditState): [number, number] {
    return state.anchor <= state.focus ? [state.anchor, state.focus] : [state.focus, state.anchor];
  }

  // ================= 绘制 =================

  /**
   * 状态变化后：同步会话中的编辑视图、光标常亮重新计时、重画覆盖层并通知订阅者
   * @param reveal 是否滚动到光标可见 (滚轮与格式变化不滚)
   */
  private refresh(reveal = true): void {
    const { state } = this;
    const geometry = state && this.geometry(state);
    if (state && geometry) {
      if (reveal) this.revealCaret(state, geometry);
      state.scrollY = Math.min(state.scrollY, this.maxScroll(geometry));
      this.ctx.session.setTextEditing(this.editingTarget(state));
    }
    this.caretVisible = true;
    this.restartBlink();
    this.redraw();
    this.emit();
  }

  private redraw(): void {
    const { state } = this;
    const geometry = state && this.geometry(state);
    if (!state || !geometry) {
      this.ctx.host.overlay.clear(OVERLAY_SESSION);
      return;
    }
    const { session, host } = this.ctx;
    const { theme, viewport } = session;
    const { layout, primitive, toWorld } = geometry;
    const scrollY = primitive.scrollY ?? 0;
    // 可见窗口 (排版坐标)：滚动时只画文本框内的部分，与渲染器的裁剪一致
    const top = scrollY;
    const bottom = primitive.scrollY === undefined ? Infinity : scrollY + primitive.height!;
    const toWorldPoint = (x: number, y: number): Point =>
      applyMatrix(toWorld, primitive.x + x, primitive.y + y - scrollY);
    const quad = (x: number, y: number, width: number, height: number): number[] =>
      [
        toWorldPoint(x, y),
        toWorldPoint(x + width, y),
        toWorldPoint(x + width, y + height),
        toWorldPoint(x, y + height)
      ].flatMap((p) => [p.x, p.y]);

    const primitives: CanvasPrimitive[] = [];
    const [start, end] = this.range(state);
    if (!state.composition) {
      for (const rect of selectionRects(layout, start, end, this.fonts)) {
        const y1 = Math.max(rect.y, top);
        const y2 = Math.min(rect.y + rect.height, bottom);
        if (y2 <= y1) continue;
        primitives.push({
          kind: 'polygon',
          points: quad(rect.x, y1, rect.width, y2 - y1),
          fill: theme.accent,
          fillOpacity: SELECTION_OPACITY
        });
      }
    }
    const caret = caretRect(layout, this.caretOffset(state), state.affinity, this.fonts);
    if (caret) {
      const visible = caret.top >= top - 0.5 && caret.top + caret.height <= bottom + 0.5;
      if (start === end && this.caretVisible && visible) {
        const a = toWorldPoint(caret.x, caret.top);
        const b = toWorldPoint(caret.x, caret.top + caret.height);
        primitives.push({
          kind: 'line',
          points: [a.x, a.y, b.x, b.y],
          stroke: theme.accent,
          strokeWidth: CARET_WIDTH_PX / viewport.zoom
        });
      }
      // 输入法候选框跟随光标
      const screen = worldToScreen(toWorldPoint(caret.x, caret.top), viewport);
      state.input.setCaretRect({ x: screen.x, y: screen.y, height: caret.height * viewport.zoom });
    }
    host.overlay.setPrimitives(OVERLAY_SESSION, primitives);
  }

  private restartBlink(): void {
    if (this.blinkTimer !== null) clearTimeout(this.blinkTimer);
    this.blinkTimer = setTimeout(() => {
      this.caretVisible = !this.caretVisible;
      this.redraw();
      this.restartBlink();
    }, CARET_BLINK_MS);
  }

  private stopTimers(): void {
    if (this.blinkTimer !== null) clearTimeout(this.blinkTimer);
    this.blinkTimer = null;
    this.drag = null;
    this.stopAutoScroll();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // ================= 外部变化 =================

  private onSessionChange(change: SessionChange): void {
    if (this.ctx.session.isReadOnly) {
      if (this.state) this.exit();
      return;
    }
    const { state } = this;
    if (!state) {
      // 未编辑时格式目标是选中节点
      if (change.toggledNodeIds.size > 0 || change.selectionScopeChanged) this.emit();
      return;
    }
    const { session } = this.ctx;
    // 选区换成别的实体、编辑目标被外部改变时退出编辑
    const selected = state.kind === 'node' ? session.selectedNodeIds : session.selectedConnectorIds;
    const editing = session.textEditing;
    if (!selected.has(state.id) || editing?.kind !== state.kind || editing.id !== state.id) {
      this.exit();
      return;
    }
    if (change.viewportChanged || change.themeChanged) this.redraw();
  }

  private onDocumentChange(changes: DocumentChangeSet): void {
    const { state } = this;
    const { nodes, connectors } = changes;
    if (!state) {
      for (const id of this.ctx.session.selectedNodeIds) {
        if (nodes.data.has(id)) {
          this.emit();
          return;
        }
      }
      return;
    }
    const removed = state.kind === 'node' ? nodes.removed : connectors.removed;
    if (removed.has(state.id)) {
      this.exit();
      return;
    }
    // 连线文字随路由一起排版，属于几何变更
    const changed =
      state.kind === 'node'
        ? nodes.data.has(state.id) || nodes.worldGeometry.has(state.id)
        : connectors.geometry.has(state.id) || connectors.data.has(state.id);
    if (!changed) return;
    // 撤销、协同可能改短文字：偏移夹取到新文本内
    const geometry = this.geometry(state);
    if (!geometry) {
      this.exit();
      return;
    }
    const length = getRunsText(geometry.runs).length;
    state.anchor = Math.min(state.anchor, length);
    state.focus = Math.min(state.focus, length);
    this.refresh(false);
  }
}
