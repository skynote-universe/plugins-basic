/**
 * @file text-format.ts
 * @description 行内格式的判定与补丁 (纯函数)：编辑选区与整块文字共用同一套规则
 *
 * 设计考量 (Why):
 * 取消某个格式时，若块样式本身没有该格式就移除分段上的键 (回到块样式，分段得以合并)，
 * 否则显式写入常规值覆盖块样式；这样反复开关不会在文档里留下冗余的样式键。
 */

import {
  hasDecorationLine,
  toggleDecorationLine,
  type NodeTextStyle,
  type RichTextRunStyle,
  type RichTextStylePatch,
  type TextDecorationLine
} from '@skynote/core';

/** 可开关的行内格式 */
export type TextFormat = 'bold' | 'italic' | 'underline' | 'strikethrough';

const DECORATION_LINES: Readonly<Record<'underline' | 'strikethrough', TextDecorationLine>> = {
  underline: 'underline',
  strikethrough: 'line-through'
};

export function isBold(style: RichTextRunStyle): boolean {
  const { fontWeight } = style;
  return fontWeight === 'bold' || fontWeight === 'bolder' || (typeof fontWeight === 'number' && fontWeight >= 600);
}

/** 生效样式中该格式是否开启 */
export function isFormatActive(style: RichTextRunStyle, format: TextFormat): boolean {
  if (format === 'bold') return isBold(style);
  if (format === 'italic') return style.fontStyle === 'italic';
  return hasDecorationLine(style.textDecoration, DECORATION_LINES[format]);
}

/**
 * 开关格式的样式补丁
 * @param current 目标文字当前的生效样式 (装饰线据此保留另一种线)
 * @param block 块样式：关闭时据此决定移除键还是写入常规值
 */
export function formatPatch(
  format: TextFormat,
  on: boolean,
  current: RichTextRunStyle,
  block: Readonly<NodeTextStyle>
): RichTextStylePatch {
  if (format === 'bold') return { fontWeight: on ? 'bold' : isBold(block) ? 'normal' : undefined };
  if (format === 'italic') return { fontStyle: on ? 'italic' : block.fontStyle === 'italic' ? 'normal' : undefined };
  const next = toggleDecorationLine(current.textDecoration, DECORATION_LINES[format], on);
  const blockNone = block.textDecoration === undefined || block.textDecoration === 'none';
  return { textDecoration: next === 'none' && blockNone ? undefined : next };
}

/** 块样式中与行内样式同名的部分：分段样式覆盖其上即为文字的生效样式 */
export function blockRunStyle(style: Readonly<NodeTextStyle>): RichTextRunStyle {
  const { fontSize, fontFamily, fontWeight, fontStyle, color, backgroundColor, textDecoration } = style;
  return { fontSize, fontFamily, fontWeight, fontStyle, color, backgroundColor, textDecoration };
}

/** 多组样式的共有部分：全部取值一致的键 */
export function commonStyle(styles: readonly RichTextRunStyle[]): RichTextRunStyle {
  const [first, ...rest] = styles;
  if (!first) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first)) {
    const same = rest.every((style) => JSON.stringify(style[key as keyof RichTextRunStyle]) === JSON.stringify(value));
    if (same) result[key] = value;
  }
  return result as RichTextRunStyle;
}
