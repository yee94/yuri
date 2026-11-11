import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ProceduralAssistantAvatar } from '@/components/assistants/ProceduralAssistantAvatar';
import { AVATAR_PICKER_SHAPES, encodeAssistantAvatar, resolveAssistantAvatar } from '@/lib/assistant-avatar/recipe';
import { createAssistantAvatarPlayer, mountAssistantAvatarRenderer } from '@/lib/assistant-avatar/engine';
import '@/index.css';

const host = document.createElement('main');
document.body.append(host);
const root = createRoot(host);
let commits = 0;
let writes = 0;
let reads = 0;
const setAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if (this.closest('[data-procedural-avatar]')) writes++;
  return setAttribute.call(this, name, value);
};
const getRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  if (this.hasAttribute('data-avatar-motion')) reads++;
  return getRect.call(this);
};
const recipeFor = (index: number) => ({ ...resolveAssistantAvatar('performance'), shape: AVATAR_PICKER_SHAPES[index % AVATAR_PICKER_SHAPES.length] });
const frames = async (count: number) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); };
const render = (count: number, draft: number, motion: 'idle' | 'working' = 'working', followPointer = true, synchronized = false, greeting = false) => flushSync(() => root.render(<div data-draft={draft} style={{ display: 'flex', gap: 4 }}>
  {Array.from({ length: count }, (_, i) => <React.Profiler key={i} id={`face-${i}`} onRender={() => { commits++; }}>
    <ProceduralAssistantAvatar seed={encodeAssistantAvatar(recipeFor(synchronized ? 0 : i))} size={synchronized ? [64, 40, 28][i % 3] : 44} motion={motion} followPointer={followPointer && (!synchronized || i % 3 !== 2)} animationKey={synchronized ? 'shared-bot' : `bot-${i}`} blinkOnMount={greeting ? 2 : synchronized} playOnce={greeting} />
  </React.Profiler>)}
</div>));

function benchmark(count: number, motion: 'idle' | 'working', randomizeShape = false) {
  const stage = document.createElement('section');
  stage.style.cssText = 'display:flex;gap:4px';
  document.body.append(stage);
  const random = Math.random;
  let seed = 1;
  Math.random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  try {
    const faces = Array.from({ length: count }, (_, i) => {
      const recipe = recipeFor(i), renderer = mountAssistantAvatarRenderer(document, `bench-${i}`, recipe);
      renderer.svg.style.cssText = 'width:44px;height:44px';
      stage.append(renderer.svg);
      const player = createAssistantAvatarPlayer(recipe, `performance-${i}`, motion, true, { randomizeShape });
      player.setGaze([-1, 1]);
      return { renderer, player };
    });
    const samples: number[] = [];
    for (let i = 0; i < 180; i++) {
      const start = performance.now();
      for (const { renderer, player } of faces) renderer.paint(player.advance(1 / 30));
      if (i >= 60) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { count, motion, randomizeShape, samples: samples.length, median: samples[60], p95: samples[114], max: samples.at(-1)! };
  } finally {
    Math.random = random;
    stage.remove();
  }
}

Object.assign(window, { avatarPerformance: {
  benchmark,
  commits: () => commits,
  pointerBurst() {
    const before = { reads, writes, commits };
    for (let i = 0; i < 1000; i++) window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: i, clientY: 100 }));
    return { reads: reads - before.reads, writes: writes - before.writes, commits: commits - before.commits };
  },
  async mount(count: number, draft = 0, motion: 'idle' | 'working' = 'working', followPointer = true) {
    render(count, draft, motion, followPointer);
    await frames(3);
    if (motion === 'idle' && (!followPointer || !matchMedia('(any-hover: hover) and (any-pointer: fine)').matches)) {
      // Measure quiet idle after the existing bounded gaze-to-rest transition.
      const deadline = performance.now() + 2000;
      let previous: number;
      do { previous = writes; await frames(4); } while (writes !== previous && performance.now() < deadline);
    }
  },
  async synchronized(motion: 'idle' | 'working' = 'working') {
    render(1, 0, motion, true, true);
    await frames(20);
    render(20, 0, motion, true, true);
    await frames(3);
    const samples: boolean[] = [];
    for (let i = 0; i < 60; i++) {
      await frames(1);
      host.querySelector('[data-avatar-motion]')!.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: i * 10, clientY: 100 }));
      const poses = [...host.querySelectorAll('svg')].map((svg) => [...svg.querySelectorAll('path, g')].map((node) => `${node.getAttribute('d')}|${node.getAttribute('transform')}`).join('|'));
      samples.push(poses.length === 20 && poses.every((pose) => pose === poses[0]));
    }
    return samples;
  },
  async greeting() {
    flushSync(() => root.render(null));
    render(1, 0, 'idle', false, false, true);
    await frames(3);
    const before = writes;
    const svg = host.querySelector('svg');
    const start = performance.now();
    while (performance.now() < start + 2000) await frames(1);
    const poses = new Set<string>();
    for (let i = 0; i < 24; i++) { await frames(1); poses.add(svg!.innerHTML); }
    const deadline = start + 6500;
    while (performance.now() < deadline) await frames(1);
    return { writes: writes - before, poses: poses.size, sameSvg: host.querySelector('svg') === svg };
  },
  async steady() {
    const before = { commits, writes };
    await frames(4);
    return { commits: commits - before.commits, writes: writes - before.writes, active: host.querySelectorAll('[data-avatar-active="true"]').length };
  },
  updateUnrelated() {
    const before = writes;
    for (let i = 0; i < 50; i++) render(20, i);
    return { writes: writes - before };
  },
  async unmount() { flushSync(() => root.render(null)); await frames(3); },
} });
