import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MobileScheduleAssistantHint } from '@/mobile/scheduled/MobileScheduleAssistantHint';
import { MobileTabPageHeader } from '@/mobile/MobileTabPageHeader';
import { Button } from '@/components/ui/button';
import { I18nContext } from '@/lib/i18n/react-context';
import { dict } from '@/lib/i18n/messages/en';
import '@/index.css';

const host = document.getElementById('root')!;
const root = createRoot(host);
let revision = 0;
function mount(active = true) {
  flushSync(() => root.render(
    <I18nContext.Provider value={{ locale: 'en', locales: ['en'], setLocale: () => {}, label: () => 'English', t: key => dict[key] }}>
      <main className="yuri-mobile-floating-shell">
        <section id="fixture" role="tabpanel" style={{ padding: '16px var(--yuri-mobile-page-inline-inset)' }}>
          <div className="yuri-mobile-scheduled-workspace">
            <MobileTabPageHeader title="Schedule" trailing={<MobileScheduleAssistantHint key={revision} active={active} />} />
            <div id="content" className="yuri-mobile-floating-surface yuri-mobile-segmented-track" style={{ marginTop: 20 }}>
              <span style={{ flex: 1 }}>All &nbsp; Active &nbsp; Paused</span>
              <Button id="add" size="mobileIcon" variant="ghost" className="yuri-mobile-floating-action yuri-mobile-inverse-action yuri-mobile-segmented-action">+</Button>
            </div>
          </div>
        </section>
      </main>
    </I18nContext.Provider>,
  ));
}
Object.assign(window, { scheduleFixture: {
  restart() { revision++; mount(); },
  hide() { mount(false); },
} });
mount();
