import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatMessage, I18nProvider } from '@/lib/i18n';
import { I18nContext } from '@/lib/i18n/react-context';
import { LOCALES, type Locale } from '@/lib/i18n/runtime';
import { dict as zhCnDict } from '@/lib/i18n/messages/zh-CN';
import { dict as zhTwDict } from '@/lib/i18n/messages/zh-TW';
import type { I18nDictionary } from '@/lib/i18n/store';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { SkillToolGroup } from './SkillToolGroup';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillToolGroupSource = readFileSync(join(__dirname, 'SkillToolGroup.tsx'), 'utf-8');

const skillActivity = (
    id: string,
    name: string,
    status: string,
): TurnActivityRecord => ({
    id,
    turnId: 'turn-1',
    messageId: 'message-1',
    partIndex: 0,
    kind: 'tool',
    part: {
        id,
        type: 'tool',
        callID: `call-${id}`,
        tool: 'skill',
        state: { status, input: { name } },
    },
} as unknown as TurnActivityRecord);

const renderWithLocale = (locale: Locale, dictionary: I18nDictionary, element: React.ReactElement) =>
    renderToStaticMarkup(
        <I18nContext.Provider
            value={{
                locale,
                locales: LOCALES,
                setLocale: () => {},
                label: () => locale,
                t: (key, params) => formatMessage(dictionary, key, params),
            }}
        >
            {element}
        </I18nContext.Provider>,
    );

describe('SkillToolGroup', () => {
    test('renders a collapsed one-line summary with original skill names', () => {
        const activities = [
            skillActivity('skill-1', 'sync-state-invariants', 'completed'),
            skillActivity('skill-2', 'diagnosing-bugs', 'completed'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <SkillToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('data-component="skill-tool-group"');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('Load Skill');
        expect(markup).toContain('sync-state-invariants, diagnosing-bugs');
        expect(markup).toContain('typography-meta h-5 min-h-0 w-0 min-w-0 max-w-full flex-1 overflow-clip sm:h-6');
        expect(markup).toContain('#yuri-book');
        expect(skillToolGroupSource).toContain("'flex min-h-0 min-w-0 items-center gap-1.5 overflow-clip'");
        expect(skillToolGroupSource).not.toContain("'flex w-full min-h-0 min-w-0 items-center gap-1.5 overflow-clip'");
    });

    test('shows the first three names and an overflow count past three', () => {
        const activities = [
            skillActivity('skill-1', 'one', 'completed'),
            skillActivity('skill-2', 'two', 'completed'),
            skillActivity('skill-3', 'three', 'completed'),
            skillActivity('skill-4', 'four', 'completed'),
            skillActivity('skill-5', 'five', 'completed'),
            skillActivity('skill-6', 'six', 'completed'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <SkillToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('one, two, three and 3 more');
        expect(markup).not.toContain('four');
        expect(markup).not.toContain('five');
        expect(markup).not.toContain('six');
    });

    test('shows total skill count in Chinese overflow copy', () => {
        const activities = [
            skillActivity('skill-1', 'one', 'completed'),
            skillActivity('skill-2', 'two', 'completed'),
            skillActivity('skill-3', 'three', 'completed'),
            skillActivity('skill-4', 'four', 'completed'),
        ];

        const simplifiedMarkup = renderWithLocale(
            'zh-CN',
            zhCnDict,
            <SkillToolGroup activities={activities} isMobile={false} />,
        );
        expect(simplifiedMarkup).toContain('one, two, three 等 4 个');

        const traditionalMarkup = renderWithLocale(
            'zh-TW',
            zhTwDict,
            <SkillToolGroup activities={activities} isMobile={false} />,
        );
        expect(traditionalMarkup).toContain('one, two, three 等 4 個');
    });

    test('flips the summary upward while the group is still loading', () => {
        expect(skillToolGroupSource).toContain('<FlipUpText text={summary} active={isActive} />');
    });

    test('keeps the group active while any member lacks settlement evidence', () => {
        const activities = [
            skillActivity('skill-1', 'sync-state-invariants', 'completed'),
            skillActivity('skill-2', 'diagnosing-bugs', 'running'),
        ];
        const markup = renderToStaticMarkup(
            <I18nProvider>
                <SkillToolGroup activities={activities} isMobile={false} />
            </I18nProvider>,
        );

        expect(markup).toContain('yuri-lattice-orb-dot');
        expect(markup).toContain('animate-text-shimmer');
        expect(markup).not.toContain('#yuri-book');
    });
});
