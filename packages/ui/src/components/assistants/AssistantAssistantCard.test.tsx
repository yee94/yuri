import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { AssistantAssistantCard } from './AssistantAssistantCard';
import { generatedAvatarDataUri } from '@/lib/generatedAvatar';
import type { AssistantContactAssistantCardPart } from '@/queries/assistantQueries';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => null }));
vi.mock('@/mobile/useMobileNavigationStore', () => ({ useMobileNavigationStore: { getState: () => ({ openAssistant: vi.fn() }) } }));
vi.mock('@/stores/useAssistantUIStore', () => ({ openAssistant: vi.fn() }));

const card: AssistantContactAssistantCardPart = {
  type: 'card', cardType: 'assistant', assistantID: 'recruited', name: 'Project lead', providerID: 'provider', modelID: 'model', mode: 'continuous',
};

describe('newly recruited assistant card identity', () => {
  test('uses the recruited assistant saved face, not a robot icon or the speaking assistant', () => {
    const seed = 'yuri-avatar:v1:star:capsule:coral:neutral:1:new';
    const markup = renderToStaticMarkup(<AssistantAssistantCard card={card} assistant={{ avatarSeed: seed, working: false, activeContactTurn: null }} active={false} />);
    expect(markup).toContain(generatedAvatarDataUri('assistant', seed));
    expect(markup).not.toContain(generatedAvatarDataUri('assistant', 'recruited'));
    expect(markup).not.toContain('robot-2');
    expect(markup).toContain('Project lead');
  });

  test('uses stable assistant ID until the snapshot arrives and reflects later avatar edits', () => {
    const render = (seed?: string) => renderToStaticMarkup(<AssistantAssistantCard card={card} assistant={seed ? { avatarSeed: seed, working: false, activeContactTurn: null } : undefined} active={false} />);
    expect(render()).toContain(generatedAvatarDataUri('assistant', card.assistantID));
    for (const seed of ['saved-face', 'edited-face']) expect(render(seed)).toContain(generatedAvatarDataUri('assistant', seed));
  });

  test('active cards opt into live faces while covered conversations remain static', () => {
    const active = renderToStaticMarkup(<AssistantAssistantCard card={card} />);
    expect(active).toContain('data-avatar-motion="idle"');
    expect(active).not.toContain('data-assistant-working-dot');
    const covered = renderToStaticMarkup(<AssistantAssistantCard card={card} active={false} />);
    expect(covered).not.toContain('data-avatar-motion');
  });
});
