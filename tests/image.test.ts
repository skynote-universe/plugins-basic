import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine, SyntheticPointerEvent, isAspectLocked } from '@skynote/core';
import type { AssetAdapter, AssetUploadResult } from '@skynote/core';
import { BasicNodesPlugin, SelectionPlugin, TransformPlugin } from '../src';

const engines: SkyNoteEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.destroy()));

function setup(upload: AssetAdapter['upload']): SkyNoteEngine {
  const engine = new SkyNoteEngine({ assets: { upload, resolve: (src) => src } })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin());
  engine.session.setViewportSize({ width: 1000, height: 800 });
  engines.push(engine);
  return engine;
}

const asset = (src: string): AssetUploadResult => ({ src, mimeType: 'image/png', width: 800, height: 400 });

describe('图片事务与交互', () => {
  it('插入登记资产与缩放尺寸，一步撤销和重做；替换保留几何、样式和显示模式', async () => {
    const upload = vi
      .fn<AssetAdapter['upload']>()
      .mockResolvedValueOnce(asset('memory:first'))
      .mockResolvedValueOnce(asset('memory:second'));
    const engine = setup(upload);
    const store = engine.documentStore;
    const id = (await engine.insertImage('first', { x: 400, y: 300 }, 'contain'))!;
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
    const id = (await engine.insertImage('initial', { x: 300, y: 300 }))!;
    const oldTask = engine.replaceImage([id], 'old');
    const newTask = engine.replaceImage([id], 'new');
    expect(pending[0].signal.aborted).toBe(true);
    pending[1].resolve(asset('memory:new'));
    expect(await newTask).toBe(true);
    pending[0].resolve(asset('memory:old'));
    expect(await oldTask).toBe(false);
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
    expect(await task).toBeNull();
    expect(Object.keys(engine.documentStore.getView().content.nodes)).toHaveLength(0);
  });

  it('零透明度图片保留命中、连线吸附和拖动对齐，普通零透明度形状仍隐藏', async () => {
    const engine = setup(async () => asset('memory:image'));
    const store = engine.documentStore;
    const imageId = (await engine.insertImage('image', { x: 350, y: 50 }))!;
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
