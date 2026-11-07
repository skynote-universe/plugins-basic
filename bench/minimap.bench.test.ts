import { it, expect, vi } from 'vitest';
import { createEmptyCanvasDocument, SkyNoteEngine } from '@skynote/core';
import { BasicNodesPlugin, MinimapPlugin } from '../src';

it.each([1000, 10000])('%s节点小地图冷启动、平移缓存与单节点失效', (count) => {
  const doc = createEmptyCanvasDocument();
  for (let i = 0; i < count; i++)
    doc.content.nodes[`n${i}`] = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'shape',
      x: (i % 100) * 140,
      y: Math.floor(i / 100) * 100,
      width: 100,
      height: 60,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
  const minimap = new MinimapPlugin();
  const engine = new SkyNoteEngine({ initialDoc: doc }).use(new BasicNodesPlugin()).use(minimap);
  engine.session.setViewportSize({ width: 1200, height: 800 });
  minimap.setEnabled(true);
  const reads = vi.spyOn(engine.spatialIndex, 'getBounds');
  const size = { width: 224, height: 144 };
  try {
    const start = performance.now();
    const first = minimap.getSnapshot(size)!;
    const coldMs = performance.now() - start;
    expect(first.content.nodes).toHaveLength(count);
    reads.mockClear();
    const panStart = performance.now();
    for (let i = 0; i < 500; i++) {
      engine.session.setViewport({ x: -i, y: -i });
      expect(minimap.getSnapshot(size)!.content).toBe(first.content);
    }
    const panMs = performance.now() - panStart;
    expect(reads).not.toHaveBeenCalled();
    const editStart = performance.now();
    engine.documentStore.updateNode('n0', { x: 20 });
    expect(minimap.getSnapshot(size)!.content.nodes.find((n) => n.id === 'n0')?.bounds.left).toBe(20);
    const editMs = performance.now() - editStart;
    expect(reads).toHaveBeenCalledTimes(1);
    console.info(
      JSON.stringify({
        count,
        coldMs: +coldMs.toFixed(3),
        pan500Ms: +panMs.toFixed(3),
        editMs: +editMs.toFixed(3),
        panGeometryReads: 0,
        editGeometryReads: reads.mock.calls.length
      })
    );
  } finally {
    engine.destroy();
  }
});
