import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from "@/stores/useUIStore";
import { getModifierLabel, formatShortcutForDisplay } from "@/lib/shortcuts";
import { helpShortcutDisplayKeys, helpShortcutSections } from "@/lib/help-shortcuts-core";
import { useI18n } from "@/lib/i18n";
import { isVSCodeRuntime } from "@/lib/desktop";
import { ShortcutKbd } from "@/components/ui/kbd";
import { useDeviceInfo } from '@/lib/device';

export const HelpDialog: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const isHelpDialogOpen = useUIStore((state) => state.isHelpDialogOpen);
  const setHelpDialogOpen = useUIStore((state) => state.setHelpDialogOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const shortcuts = helpShortcutSections(getModifierLabel());
  const isVSCode = isVSCodeRuntime();

  return (
    <Dialog open={isHelpDialogOpen} onOpenChange={setHelpDialogOpen}>
      <DialogContent presentation={isMobile ? 'default' : 'picker'} className={isMobile ? 'max-w-2xl w-[min(42rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden' : undefined}>
        <DialogHeader className="yuri-picker-header">
          <DialogTitle className="yuri-picker-title">{t('helpDialog.title')}</DialogTitle>
        </DialogHeader>
        <div className="yuri-picker-list">
          <div>
            {shortcuts.map((section) => (
              <div key={section.categoryKey} className="yuri-picker-section">
                <h3 className="yuri-picker-section-title text-muted-foreground">{t(section.categoryKey)}</h3>
                <div>
                  {section.items.filter((shortcut) => !(isVSCode && shortcut.id === 'toggle_prompt_navigator')).map((shortcut) => {
                    const displayKeys = helpShortcutDisplayKeys(shortcut, shortcutOverrides, formatShortcutForDisplay);
                    return (
                      <div key={shortcut.id || shortcut.descriptionKey} className="yuri-picker-row yuri-help-shortcut-row">
                        <div className="flex items-center gap-2">
                          {shortcut.icon && <Icon name={shortcut.icon} className="h-3.5 w-3.5 text-muted-foreground" />}
                          <span className="yuri-picker-label">{t(shortcut.descriptionKey)}</span>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                          {displayKeys.map((keyCombo, i) => (
                            <React.Fragment key={`${keyCombo}-${i}`}>
                              {i > 0 && <span className="typography-meta text-muted-foreground mx-1">{t('helpDialog.keyCombiner.or')}</span>}
                              <ShortcutKbd shortcut={keyCombo} variant="hint" />
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
