import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  isAspectLocked,
  AssetAdapterError,
  NODE_CLIPBOARD_MIME,
  parseNodeClipboard
} from '@skynote/core';
import type { AssetAdapter, AssetUploadResult } from '@skynote/core';
import { BasicNodesPlugin, SelectionPlugin, TransformPlugin, ClipboardPlugin } from '../src';

const engines: SkyNoteEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.destroy()));

function setup(upload: AssetAdapter['upload'], extra: Partial<AssetAdapter> = {}): SkyNoteEngine {
  const engine = new SkyNoteEngine({ assets: { upload, resolve: (src) => src, ...extra } })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin());
  engine.session.setViewportSize({ width: 1000, height: 800 });
  engines.push(engine);
  return engine;
}

const asset = (src: string): AssetUploadResult => ({ src, mimeType: 'image/png', width: 800, height: 400 });

async function insert(
  engine: SkyNoteEngine,
  file: unknown,
  point: { x: number; y: number },
  fit: 'cover' | 'contain' = 'cover'
): Promise<string> {
  const result = await engine.insertImage(file, point, fit);
  if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
  return result.value;
}

describe('图片事务与交互', () => {
  it('图片剪贴板同步认领、携带资产来源，异步失败只发布一次，复制失败不剪掉节点', async () => {
    const source = setup(async () => asset('memory:source'), { referenceScope: 'scope' }).use(new ClipboardPlugin());
    const id = await insert(source, 'image', { x: 0, y: 0 });
    source.session.setSelection({ nodeIds: [id] });
    const data = source.clipboard.copy()!;
    const parsed = parseNodeClipboard(data[NODE_CLIPBOARD_MIME]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.source?.referenceScope).toBe('scope');
    const target = setup(async () => asset('unused'), {
      checkReferences: async () => {
        throw new AssetAdapterError('missing-asset', '文件缺失');
      }
    }).use(new ClipboardPlugin());
    const observer = vi.fn();
    target.onAssetTaskEvent(observer);
    expect(target.clipboard.paste(data)).toBe(true);
    await vi.waitFor(() => expect(observer.mock.calls.filter(([event]) => event.phase === 'settled')).toHaveLength(1));
    expect(Object.keys(target.documentStore.getView().content.nodes)).toHaveLength(0);
    source.documentStore.commit({
      patches: [{ op: 'unset', path: ['assets', source.documentStore.getNode(id)!.image!.assetId] }]
    });
    expect(source.clipboard.cut()).toBeNull();
    expect(source.documentStore.getNode(id)).toBeDefined();
  });
  it('跨文档粘贴资产与节点一次登记，ID 冲突不覆盖原资产，撤销重做同步恢复', async () => {
    const checkReferences = vi.fn<NonNullable<AssetAdapter['checkReferences']>>().mockResolvedValue();
    const source = setup(async () => asset('memory:original'), { referenceScope: 'same-library' });
    const id = await insert(source, 'image', { x: 50, y: 50 });
    const payload = source.documentStore.copyEntities({ nodeIds: [id] })!;
    const oldId = source.documentStore.getNode(id)!.image!.assetId;
    const target = setup(async () => asset('unused'), { referenceScope: 'same-library', checkReferences });
    target.documentStore.commit({
      patches: [{ op: 'set', path: ['assets', oldId], value: { ...payload.assets[oldId], src: 'memory:existing' } }]
    });
    const result = await target.pasteNodesWithAssets(
      { ...payload, source: { referenceScope: 'same-library' } },
      { x: 20, y: 30 }
    );
    if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
    const copied = target.documentStore.getNode(result.value.nodeIds[0])!;
    const newId = copied.image!.assetId;
    expect(newId).not.toBe(oldId);
    expect(target.documentStore.getView().assets?.[newId].src).toBe('memory:original');
    expect(target.documentStore.getView().assets?.[oldId].src).toBe('memory:existing');
    expect(copied).toMatchObject({ x: payload.nodes[0].x + 20, y: payload.nodes[0].y + 30, image: { fit: 'cover' } });
    target.documentStore.undo();
    expect(target.documentStore.getNode(copied.id)).toBeUndefined();
    expect(target.documentStore.getView().assets?.[newId]).toBeUndefined();
    target.documentStore.redo();
    expect(target.documentStore.getNode(copied.id)?.image?.assetId).toBe(newId);
    expect(checkReferences).toHaveBeenCalledOnce();
  });

  it('宿主检查失败不提交实体或元数据；检查期间换文档取消且不接收晚到结果', async () => {
    const source = setup(async () => asset('memory:source'));
    const id = await insert(source, 'image', { x: 0, y: 0 });
    const payload = { ...source.documentStore.copyEntities({ nodeIds: [id] })!, source: { referenceScope: 'scope' } };
    const fail = setup(async () => asset('unused'), {
      checkReferences: async () => {
        throw new AssetAdapterError('missing-asset', '文件缺失');
      }
    });
    expect(await fail.pasteNodesWithAssets(payload, { x: 0, y: 0 })).toMatchObject({
      status: 'failed',
      failure: { code: 'missing-asset' }
    });
    expect(Object.keys(fail.documentStore.getView().assets ?? {})).toHaveLength(0);
    let finish!: () => void;
    const target = setup(async () => asset('unused'), {
      checkReferences: () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    });
    const pending = target.pasteNodesWithAssets(payload, { x: 0, y: 0 });
    target.documentStore.replaceContent({ nodes: {}, connectors: {} }, {}, {});
    expect(await pending).toEqual({ status: 'cancelled', reason: 'document-replaced' });
    finish();
    await Promise.resolve();
    expect(Object.keys(target.documentStore.getView().content.nodes)).toHaveLength(0);
  });

  it('删除替换目标及时取消整批，晚到上传不能恢复节点或写入资产', async () => {
    let finish!: (value: AssetUploadResult) => void;
    const engine = setup((file) =>
      file === 'original'
        ? Promise.resolve(asset('memory:original'))
        : new Promise((resolve) => {
            finish = resolve;
          })
    );
    const id = await insert(engine, 'original', { x: 0, y: 0 });
    const pending = engine.replaceImage([id], 'next');
    engine.documentStore.removeEntities({ nodeIds: [id] });
    expect(await pending).toEqual({ status: 'cancelled', reason: 'target-changed' });
    finish(asset('memory:late'));
    await Promise.resolve();
    expect(Object.values(engine.documentStore.getView().assets ?? {}).some((meta) => meta.src === 'memory:late')).toBe(
      false
    );
  });
  it('插入登记资产与缩放尺寸，一步撤销和重做；替换保留几何、样式和显示模式', async () => {
    const upload = vi
      .fn<AssetAdapter['upload']>()
      .mockResolvedValueOnce(asset('memory:first'))
      .mockResolvedValueOnce(asset('memory:second'));
    const engine = setup(upload);
    const store = engine.documentStore;
    const id = await insert(engine, 'first', { x: 400, y: 300 }, 'contain');
    const original = store.getNode(id)!;
    const firstAssetId = original.image!.assetId;
    expect(original).toMatchObject({ x: 160, y: 180, width: 480, height: 240, image: { fit: 'contain' } });
    expect(isAspectLocked(original, engine.nodeTypes.get('image')!)).toBe(true);
    expect(store.getView().assets?.[firstAssetId].src).toBe('memory:first');
    store.undo();
    expect(store.getNode(id)).toBeUndefined();
    expect(store.getView().assets?.[firstAssetId]).toBeUndefined();
    store.redo();
    store.updateNode(id, { x: 12, rotation: 30, style: { fill: '$red', stroke: '$blue', strokeWidth: 4, opacity: 0 } });
    const before = structuredClone(store.getNode(id)!);
    await engine.replaceImage([id], 'second');
    const replaced = structuredClone(store.getNode(id)!);
    expect(replaced.image!.assetId).not.toBe(firstAssetId);
    expect({ ...replaced, image: before.image }).toEqual(before);
    expect(store.getView().assets?.[replaced.image!.assetId].src).toBe('memory:second');
    store.undo();
    expect(store.getNode(id)).toEqual(before);
    store.redo();
    expect(store.getNode(id)).toEqual(replaced);
  });

  it('后发替换胜出，即使适配器忽略取消且旧任务最后返回', async () => {
    const pending: { resolve: (value: AssetUploadResult) => void; signal: AbortSignal }[] = [];
    const engine = setup((file, { signal }) =>
      file === 'initial'
        ? Promise.resolve(asset('memory:initial'))
        : new Promise((resolve) => pending.push({ resolve, signal }))
    );
    const id = await insert(engine, 'initial', { x: 300, y: 300 });
    const oldTask = engine.replaceImage([id], 'old');
    const newTask = engine.replaceImage([id], 'new');
    expect(pending[0].signal.aborted).toBe(true);
    pending[1].resolve(asset('memory:new'));
    expect(await newTask).toMatchObject({ status: 'succeeded' });
    pending[0].resolve(asset('memory:old'));
    expect(await oldTask).toEqual({ status: 'cancelled', reason: 'superseded' });
    const assetId = engine.documentStore.getNode(id)!.image!.assetId;
    expect(engine.documentStore.getView().assets?.[assetId].src).toBe('memory:new');
    expect(Object.values(engine.documentStore.getView().assets ?? {}).some((entry) => entry.src === 'memory:old')).toBe(
      false
    );
  });

  it('销毁期间取消上传，返回结果不再提交节点', async () => {
    let complete!: (value: AssetUploadResult) => void;
    let signal!: AbortSignal;
    const engine = setup((_file, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const task = engine.insertImage('pending', { x: 0, y: 0 });
    engine.destroy();
    expect(signal.aborted).toBe(true);
    complete(asset('memory:late'));
    expect(await task).toEqual({ status: 'cancelled', reason: 'engine-destroyed' });
    expect(Object.keys(engine.documentStore.getView().content.nodes)).toHaveLength(0);
  });

  it('零透明度图片保留命中、连线吸附和拖动对齐，普通零透明度形状仍隐藏', async () => {
    const engine = setup(async () => asset('memory:image'));
    const store = engine.documentStore;
    const imageId = await insert(engine, 'image', { x: 350, y: 50 });
    store.updateNode(imageId, {
      x: 300,
      y: 0,
      width: 100,
      height: 100,
      style: { opacity: 0, fill: '$red', strokeWidth: 2 }
    });
    store.createNode({ nodeType: 'shape', id: 'a', x: 0, y: 0, width: 100, height: 100 });
    store.createNode({ nodeType: 'shape', id: 'hidden', x: 600, y: 0, width: 100, height: 100 });
    store.updateNode('hidden', { style: { opacity: 0 } });
    expect(engine.hitTestNode({ x: 350, y: 50 })?.id).toBe(imageId);
    expect(engine.hitTestNode({ x: 650, y: 50 })).toBeUndefined();
    expect(engine.snapConnectorEndpoint({ x: 300, y: 50 }).endpoint.nodeId).toBe(imageId);
    expect(engine.snapConnectorEndpoint({ x: 600, y: 50 }).endpoint.nodeId).toBeUndefined();
    for (const [phase, point] of [
      ['down', { x: 50, y: 50 }],
      ['move', { x: 100, y: 200 }],
      ['move', { x: 353, y: 154 }],
      ['up', { x: 353, y: 154 }]
    ] as const) {
      const event = new SyntheticPointerEvent({ point, target: engine.hitTestNode(point) });
      if (phase === 'down') engine.pointer.dispatchPointerDown(event);
      else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
      else engine.pointer.dispatchPointerUp(event);
    }
    expect(store.getNode('a')).toMatchObject({ x: 300, y: 100 });
  });
});
