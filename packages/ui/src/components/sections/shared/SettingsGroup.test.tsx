import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsActionHeader } from './SettingsActionHeader';

import {
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsToggleRow,
} from './SettingsGroup';

describe('SettingsGroup', () => {
  test('renders one shared grouped card with responsive split rows', () => {
    const markup = renderToStaticMarkup(
      <SettingsGroup
        label="OpenCode"
        ariaLabel="OpenCode"
        description="Appears under the card"
        itemId="provider-group"
      >
        <SettingsRow label="Provider" description="Choose a provider" itemId="provider">
          <button type="button">Default</button>
        </SettingsRow>
      </SettingsGroup>,
    );

    expect(markup).toContain('class="yuri-settings-group"');
    expect(markup).toContain('class="yuri-settings-group-card"');
    expect(markup).toContain('data-settings-item="provider-group" class="yuri-settings-group-card"');
    expect(markup).toContain('yuri-settings-group-row yuri-settings-split-row');
    expect(markup).toContain('data-settings-label-script="latin"');
    expect(markup).toContain('data-settings-item="provider"');
    expect(markup).toContain('data-settings-value=""');
    expect(markup).toContain('yuri-settings-group-description');
    expect(markup).toContain('Appears under the card');
  });

  test('does not opt CJK labels into Latin optical sizing', () => {
    const markup = renderToStaticMarkup(
      <SettingsGroup label="个性化">
        <SettingsRow label="外观">System</SettingsRow>
      </SettingsGroup>,
    );

    expect(markup).not.toContain('data-settings-label-script');
  });

  test.each(['Remote Instances', 'Desktop Network Access', 'Remote desktop'])(
    'uses the same title tokens and compact action header for %s', (label) => {
      const markup = renderToStaticMarkup(
        <SettingsGroup label={label} actions={<button type="button">Add</button>}>
          <SettingsRow label="Instance">Ready</SettingsRow>
        </SettingsGroup>,
      );
      const container = document.createElement('div');
      container.innerHTML = markup;
      const header = container.querySelector('[data-settings-action-header]')!;

      expect(header.classList.contains('py-0')).toBe(true);
      expect(header.classList.contains('py-3')).toBe(false);
      expect(header.classList.contains('sticky')).toBe(false);
      expect(header.classList.contains('top-0')).toBe(false);
      expect(header.classList.contains('z-10')).toBe(false);
      expect(header.classList.contains('bg-background')).toBe(false);
      const title = header.querySelector('.yuri-settings-group-label')!;
      expect(title.className).toBe('yuri-settings-group-label');
      expect(title.getAttribute('style')).toBeNull();
      expect(title.getAttribute('data-settings-label-script')).toBe('latin');
      expect(title.textContent).toBe(label);
      expect(header.querySelector('button')?.textContent).toBe('Add');
      expect(header.nextElementSibling?.classList.contains('yuri-settings-group-card')).toBe(true);
    },
  );

  test('keeps whole-page editor actions in normal flow without a covering background', () => {
    const markup = renderToStaticMarkup(
      <SettingsActionHeader actions={<button type="button">Save</button>}>
        Editor
      </SettingsActionHeader>,
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const header = container.querySelector('header')!;

    for (const className of ['sticky', 'fixed', 'top-0', 'z-10', 'bg-background']) {
      expect(header.classList.contains(className)).toBe(false);
    }
    expect(header.classList.contains('py-3')).toBe(true);
    expect(header.textContent).toBe('EditorSave');
  });

  test('keeps a single field label and description inside its card', () => {
    const markup = renderToStaticMarkup(
      <SettingsField
        label="Sidebar brand"
        description="Shown in the desktop sidebar."
        itemId="appearance.sidebar-brand"
      >
        <input aria-label="Sidebar brand" />
      </SettingsField>,
    );

    const cardStart = markup.indexOf('yuri-settings-group-card');
    expect(cardStart).toBeGreaterThan(-1);
    expect(markup.indexOf('Sidebar brand', cardStart)).toBeGreaterThan(cardStart);
    expect(markup.indexOf('Shown in the desktop sidebar.', cardStart)).toBeGreaterThan(cardStart);
    expect(markup).not.toContain('yuri-settings-group-label');
  });

  test('places long single-field helper text below the card when requested', () => {
    const markup = renderToStaticMarkup(
      <SettingsField
        label="Sidebar brand"
        description="A longer explanation that belongs below the field surface."
        descriptionPlacement="outside"
      >
        <input aria-label="Sidebar brand" />
      </SettingsField>,
    );

    const cardEnd = markup.indexOf('</div><p class="yuri-settings-group-description');
    expect(cardEnd).toBeGreaterThan(-1);
    expect(markup.indexOf('A longer explanation', cardEnd)).toBeGreaterThan(cardEnd);
  });

  test('renders boolean settings with the shared row typography contract', () => {
    const markup = renderToStaticMarkup(
      <SettingsGroup label="Notifications">
        <SettingsToggleRow
          checked
          onChange={() => undefined}
          label="Enable notifications"
          description="Delivered by the operating system."
          ariaLabel="Enable notifications"
          itemId="notifications.delivery"
        />
      </SettingsGroup>,
    );

    expect(markup).toContain('yuri-settings-group-row');
    expect(markup).toContain('typography-ui-label');
    expect(markup).toContain('typography-meta');
    expect(markup).toContain('data-settings-item="notifications.delivery"');
    expect(markup).toContain('data-settings-value=""');
    expect(markup).toContain('aria-pressed="true"');

    const labelIndex = markup.indexOf('Enable notifications');
    const checkboxIndex = markup.indexOf('role="checkbox"');
    expect(labelIndex).toBeGreaterThan(-1);
    expect(checkboxIndex).toBeGreaterThan(labelIndex);
  });
});
