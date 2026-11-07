import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nativeAssistantTps, nativeReasoningPresentation } from './chat-preferences-core';
import { initialReasoningExpansion, reconcileReasoningExpansion } from '../ui/src/components/chat/message/parts/reasoningPresentation';

const directory = path.dirname(fileURLToPath(import.meta.url));
describe('native chat preference consumers', () => {
  it('hides only TPS when disabled/unknown, preserves supplied rate when enabled, and fabricates no rate', () => {
    for (const enabled of [false, null, undefined]) expect(nativeAssistantTps('34.2 tok/s', enabled)).toBeUndefined();
    expect(nativeAssistantTps('34.2 tok/s', true)).toBe('34.2 tok/s');
    expect(nativeAssistantTps(undefined, true)).toBeUndefined();
    const source = readFileSync(path.join(directory, 'transcript-actions.tsx'), 'utf8');
    expect(source).toContain('tps={nativeAssistantTps(props.tps, nativeAppearance.current()?.showAssistantTps)} duration={props.duration}');
  });
  it('matches Web inline non-collapsible rendering: original source, no Thought header/rail or local max-height', () => {
    const source = '> First paragraph\n\n> Second **paragraph**\n\n' + 'Full reasoning\n'.repeat(400);
    expect(nativeReasoningPresentation(source, false, false)).toEqual({ collapsible: false, content: source });
    for (const enabled of [true, null, undefined]) {
      const presentation = nativeReasoningPresentation(source, enabled, false);
      expect(presentation.collapsible).toBe(true);
      expect(presentation.content).toContain('First paragraph\nSecond **paragraph**');
      expect(presentation.content).not.toContain('> ');
      expect(presentation.content.match(/Full reasoning/g)).toHaveLength(400);
    }
  });
  it('does not confuse MessageBody inline preference with ProgressiveGroup Activity-owned Thought', () => {
    for (const enabled of [true, false, null, undefined]) expect(nativeReasoningPresentation('> Thinking', enabled, true)).toEqual({ collapsible: true, content: 'Thinking' });
    const source = readFileSync(path.join(directory, 'transcript-body.tsx'), 'utf8');
    expect(source).toContain('nativeAppearance.current()?.collapsibleThinkingBlocks, props.inActivity');
    expect(source).toContain('<Nodes nodes={plan().activity} body={props} inActivity />');
    expect(source).toContain('when={presentation().collapsible} else={<TextView');
    expect(source).toContain('<CollapsibleReasoning part={props.part} body={props.body} content={presentation().content} />');
  });
  it('retains shared historical/live/user-choice fold semantics rather than forcing the enabled mode open', () => {
    expect(initialReasoningExpansion(undefined, false)).toEqual({ expanded: false, source: 'auto' });
    const live = initialReasoningExpansion(undefined, true);
    expect(live).toEqual({ expanded: true, source: 'auto' });
    expect(reconcileReasoningExpansion(live, false)).toBe(live);
    const closed = { expanded: false, source: 'user' } as const;
    expect(reconcileReasoningExpansion(closed, true)).toBe(closed);
    expect(reconcileReasoningExpansion(closed, false)).toBe(closed);
  });
});
