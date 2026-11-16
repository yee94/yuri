import { useContext, useEffect, useMemo, useRef } from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { GuiPluginHostContext } from '@/lib/gui-plugins/react';
import { useCommandShortcuts } from '@/lib/gui-plugins/useCommandShortcuts';
import { compileShortcutBindings, shortcutComboToEvent } from '@/lib/shortcut-bindings';
import { getEffectiveShortcutCombos, getShortcutActions, normalizeCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { getDesktopMenuShortcutsBridge } from '@/lib/desktop';

export function useGuiPluginKeyboardShortcuts() {
  const host = useContext(GuiPluginHostContext);
  const commands = useCommandShortcuts();
  const overrides = useUIStore((state) => state.shortcutOverrides);
  const bindings = useMemo(() => commands.length
    ? compileShortcutBindings([...getShortcutActions(), ...commands], overrides) : null, [commands, overrides]);
  const byId = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands]);
  const nativeBridge = getDesktopMenuShortcutsBridge();
  const lastNativeClaim = useRef<string | null>('[]');
  const nativeClaimsActive = useRef(true);
  const candidateCombos = useMemo(() => nativeBridge ? [...new Set(commands.flatMap((command) =>
    getEffectiveShortcutCombos(command, overrides).filter(Boolean).map(normalizeCombo)))] : [], [commands, overrides, nativeBridge]);

  const match = useEvent((event: KeyboardEvent) => {
    if (!host || !commands.length || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const target = event.target instanceof Element ? event.target : document.activeElement;
    if (target instanceof Element) {
      if (target.closest('[data-shortcut-capture], [data-terminal-view="true"], .terminal-viewport-container, [data-terminal-hidden-input="true"]')) return;
    }
    const binding = bindings?.match(event, (action) => {
      const command = byId.get(action.id);
      if (!command) return true;
      const focus = target instanceof Element ? target : document.activeElement;
      if (command.scope && !focus?.closest(command.scope)) return false;
      return command.editable || event.metaKey || event.ctrlKey || event.altKey
        || !(focus?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'));
    });
    const command = binding ? byId.get(binding.action.id) : undefined;
    return binding && command ? { command, combo: binding.combo } : undefined;
  });
  const run = useEvent((event: KeyboardEvent) => {
    const matched = match(event);
    if (!matched || !host) return false;
    const { command, combo } = matched;
    if (!event.repeat && !host.runShortcutCommand(command.pluginId, command.commandId)) {
      if (nativeBridge) queueMicrotask(() => {
        if (!event.defaultPrevented) void nativeBridge.fallback(combo).catch(() => {});
      });
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  });

  const syncNativeClaims = useEvent(() => {
    if (!nativeBridge || !nativeClaimsActive.current) return;
    const combos = candidateCombos.filter((combo) => Boolean(match(shortcutComboToEvent(combo)))).sort();
    const signature = JSON.stringify(combos);
    if (lastNativeClaim.current === signature) return;
    lastNativeClaim.current = signature;
    void nativeBridge.claim(combos).catch(() => {
      if (lastNativeClaim.current !== signature) return;
      lastNativeClaim.current = null;
      void nativeBridge.claim([]).catch(() => {});
    });
  });
  useEffect(() => {
    nativeClaimsActive.current = true;
    return () => {
      nativeClaimsActive.current = false;
      if (lastNativeClaim.current && lastNativeClaim.current !== '[]') void nativeBridge?.claim([]).catch(() => {});
      lastNativeClaim.current = '[]';
    };
  }, [host, nativeBridge]);
  useEffect(() => {
    syncNativeClaims();
  }, [host, candidateCombos, nativeBridge, syncNativeClaims]);
  const focusTarget = () => nativeBridge && candidateCombos.length ? window : null;
  useEventListener('focusin', syncNativeClaims, focusTarget);
  useEventListener('focusout', () => queueMicrotask(syncNativeClaims), focusTarget);
  return { match, run };
}
