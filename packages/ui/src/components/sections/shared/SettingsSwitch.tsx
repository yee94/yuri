import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SettingsSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** Explicit off/on choices; selecting the current value never repeats a write. */
export function SettingsSwitch({ checked, onChange, disabled = false, ariaLabel, className }: SettingsSwitchProps) {
  const { t } = useI18n();

  return (
    <RadioGroup
      value={checked}
      onValueChange={(next) => {
        if (!disabled && next !== checked) onChange(next);
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      data-slot="settings-switch"
      className={cn('yuri-settings-switch', className)}
      // Legacy Settings rows also toggle on click/keypress. This group owns its interactions.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {[false, true].map((value) => (
        <Radio.Root
          key={String(value)}
          value={value}
          nativeButton
          render={<Button variant="ghost" size="xs" />}
          className="yuri-settings-switch-option"
        >
          {checked === value && <span aria-hidden className="yuri-segmented-selected-pill yuri-settings-switch-pill" />}
          <span className="relative">{t(value ? 'settings.switch.on' : 'settings.switch.off')}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
