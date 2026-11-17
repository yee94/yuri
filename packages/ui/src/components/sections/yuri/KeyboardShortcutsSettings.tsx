import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ShortcutKbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import {
  formatShortcutForDisplay,
  getCustomizableShortcutActions,
  getShortcutActions,
  getDefaultShortcutCombos,
  getEffectiveShortcutCombos,
  getLegacyShortcutIds,
  SHORTCUT_COMBO_SEPARATOR,
  isRiskyBrowserShortcut,
  isShortcutCustomized,
  keyToShortcutToken,
  normalizeCombo,
  UNASSIGNED_SHORTCUT,
  type ShortcutAction,
  type ShortcutCombo,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { useCommandShortcuts } from '@/lib/gui-plugins/useCommandShortcuts';
import type { GuiCommandShortcut } from '@/lib/gui-plugins/command-shortcuts';
import { findShortcutConflicts, shortcutCombosConflict } from '@/lib/shortcut-bindings';
import { cn, isMacOS } from '@/lib/utils';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);

const keyboardEventToCombo = (event: React.KeyboardEvent<HTMLElement>): ShortcutCombo | null => {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) {
    return null;
  }

  const parts: string[] = [];
  // Option changes the produced character on macOS ("∫"); the matcher compares the physical key.
  let rawKey = event.key;
  if (event.altKey) {
    if (/^Key[A-Z]$/.test(event.code)) rawKey = event.code.slice(3);
    else if (/^Digit\d$/.test(event.code)) rawKey = event.code.slice(5);
  }

  if (event.metaKey || (event.ctrlKey && !isMacOS())) {
    parts.push('mod');
  }
  if (event.ctrlKey && isMacOS()) parts.push('ctrl');
  if (event.shiftKey) {
    parts.push('shift');
  }
  if (event.altKey) {
    parts.push('alt');
  }

  const keyToken = keyToShortcutToken(rawKey);
  if (!keyToken) {
    return null;
  }

  parts.push(keyToken);
  return normalizeCombo(parts.join('+'));
};

const isPlainEnter = (event: React.KeyboardEvent<HTMLElement>) =>
  event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

/** Display form, canonical form and modifier synonyms, so "cmd shift p" and "⌘" both find a binding. */
function comboSearchText(combo: ShortcutCombo): string {
  const normalized = normalizeCombo(combo);
  const words = normalized.split('+').flatMap((part) => {
    if (part === 'mod') return isMacOS() ? ['cmd', 'command'] : ['ctrl', 'control'];
    if (part === 'ctrl') return ['ctrl', 'control'];
    if (part === 'alt') return ['alt', 'option'];
    return [part];
  });
  return `${formatShortcutForDisplay(combo)} ${normalized} ${words.join(' ')}`;
}

/** "cmd+shift+p" searches that exact binding; anything else is a plain text query. */
function queryAsCombo(query: string): ShortcutCombo | null {
  if (!query.includes('+')) return null;
  const normalized = normalizeCombo(query.replace(/\s+/g, ''));
  return normalized.includes('+') ? normalized : null;
}

type ShortcutRowModel = {
  action: ShortcutAction;
  plugin?: GuiCommandShortcut;
  label: string;
  combos: ShortcutCombo[];
  customized: boolean;
  conflictLabels: string[];
  searchText: string;
};

type ShortcutEditorState = {
  draft: ShortcutCombo | null;
  conflictLabels: string[];
  risky: boolean;
  canSave: boolean;
};

const ShortcutCaptureField: React.FC<{
  label: string;
  draft: ShortcutCombo | null;
  onCombo: (combo: ShortcutCombo) => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ label, draft, onCombo, onConfirm, onCancel }) => {
  const { t } = useI18n();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="textbox"
      aria-readonly="true"
      aria-label={label}
      tabIndex={0}
      data-shortcut-capture
      className="yuri-settings-inline-value flex items-center justify-end outline-none"
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
          onCancel();
          return;
        }
        if (isPlainEnter(event) && draft) {
          onConfirm();
          return;
        }

        const combo = keyboardEventToCombo(event);
        if (combo) onCombo(combo);
      }}
    >
      {draft
        ? <ShortcutKbd variant="hint" shortcut={formatShortcutForDisplay(draft)} />
        : <span className="typography-meta text-muted-foreground">{t('settings.yuri.keyboardShortcuts.field.pressKeys')}</span>}
    </div>
  );
};

const noticeClass = 'flex items-start gap-1.5 typography-meta text-muted-foreground';

const ShortcutRow: React.FC<{
  row: ShortcutRowModel;
  editor: ShortcutEditorState | null;
  editingIndex: number | null;
  onEdit: (index: number) => void;
  onDraft: (combo: ShortcutCombo) => void;
  onSave: () => void;
  onCancel: () => void;
  onUnassign: () => void;
  onReset: () => void;
}> = ({ row, editor, editingIndex, onEdit, onDraft, onSave, onCancel, onUnassign, onReset }) => {
  const { t } = useI18n();
  const bound = row.combos.length > 0;
  const notes = [
    row.plugin ? t('settings.yuri.keyboardShortcuts.pluginPriority', {
      plugin: row.plugin.pluginId, priority: row.plugin.priority ?? 0,
    }) : null,
    row.action.context === 'terminal' ? t('settings.yuri.keyboardShortcuts.context.terminal') : null,
  ].filter((note): note is string => Boolean(note));
  const showConflict = !editor && row.conflictLabels.length > 0;
  const description = notes.length || showConflict ? (
    <>
      {notes.map((note) => <span key={note} className="block">{note}</span>)}
      {showConflict ? (
        <span className="flex items-start gap-1">
          <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" />
          <span>{t('settings.yuri.keyboardShortcuts.conflict.alsoUsedBy', { actions: row.conflictLabels.join(' · ') })}</span>
        </span>
      ) : null}
    </>
  ) : undefined;

  const footer = editor ? (
    <div className="flex flex-col gap-2 pt-1">
      {editor.conflictLabels.length > 0 ? (
        <div role="alert" className={noticeClass}>
          <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" />
          <div>
            <div>{t('settings.yuri.keyboardShortcuts.overwritePrompt')}</div>
            <div>{t('settings.yuri.keyboardShortcuts.conflict.alsoUsedBy', { actions: editor.conflictLabels.join(' · ') })}</div>
          </div>
        </div>
      ) : null}
      {editor.risky ? (
        <div role="status" className={noticeClass}>
          <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" />
          <div>{t('settings.yuri.keyboardShortcuts.warning.riskyBrowserShortcut')}</div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mr-auto typography-meta text-muted-foreground">{t('settings.yuri.keyboardShortcuts.edit.hint')}</span>
        <div className="flex items-center gap-0.5">
          {editingIndex !== null && editingIndex < row.combos.length ? (
            <Button type="button" size="xs" variant="ghost" className="!h-6 !px-1.5 !font-normal text-muted-foreground" onClick={onUnassign}>
              {t('settings.yuri.keyboardShortcuts.actions.unassign')}
            </Button>
          ) : null}
          {row.customized ? (
            <Button type="button" size="xs" variant="ghost" className="!h-6 !px-1.5 !font-normal text-muted-foreground" onClick={onReset}>
              {t('settings.common.actions.reset')}
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" className="!h-6 !px-1.5 !font-normal text-muted-foreground" onClick={onCancel}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button type="button" size="xs" className="!h-6 !px-2 !font-normal" onClick={onSave} disabled={!editor.canSave}>
            {editor.conflictLabels.length > 0
              ? t('settings.yuri.keyboardShortcuts.actions.overwrite')
              : t('settings.common.actions.saveChanges')}
          </Button>
        </div>
      </div>
    </div>
  ) : undefined;

  return (
    <SettingsRow
      className="group/row yuri-settings-shortcut-row"
      label={row.label}
      description={description}
      footer={footer}
    >
      {editor ? (
        <div className="flex min-w-0 items-center justify-end gap-2">
          {row.combos.map((combo, index) => index === editingIndex ? null : (
            <ShortcutKbd key={combo} variant="hint" shortcut={formatShortcutForDisplay(combo)} />
          ))}
          <ShortcutCaptureField
            label={row.label}
            draft={editor.draft}
            onCombo={onDraft}
            onConfirm={onSave}
            onCancel={onCancel}
          />
        </div>
      ) : (
        <div className="flex min-w-0 items-center justify-end gap-1">
          {bound || row.customized ? (
            <div className="hidden shrink-0 items-center sm:flex sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100">
              {row.customized ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t('settings.common.actions.reset')}
                  title={t('settings.common.actions.reset')}
                  onClick={onReset}
                >
                  <Icon name="arrow-go-back" className="size-3.5" />
                </Button>
              ) : null}
            </div>
          ) : null}
          {bound
            ? row.combos.map((combo, index) => (
              <React.Fragment key={combo}>
                {index > 0 ? <span aria-hidden className="h-3.5 w-px shrink-0 bg-[var(--yuri-settings-row-divider)]" /> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={t('settings.yuri.keyboardShortcuts.edit.aria', { action: row.label })}
                  className="h-auto min-h-6 min-w-0 px-1.5 py-1"
                  onClick={() => onEdit(index)}
                >
                  <ShortcutKbd variant="hint" shortcut={formatShortcutForDisplay(combo)} />
                </Button>
              </React.Fragment>
            ))
            : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={t('settings.yuri.keyboardShortcuts.edit.aria', { action: row.label })}
                className="h-auto min-h-6 min-w-0 px-1.5 py-1"
                onClick={() => onEdit(0)}
              >
                <span className="typography-meta font-normal text-muted-foreground">{t('settings.yuri.keyboardShortcuts.field.unassigned')}</span>
              </Button>
            )}
        </div>
      )}
    </SettingsRow>
  );
};

export const KeyboardShortcutsSettings: React.FC = () => {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const clearShortcutOverride = useUIStore((state) => state.clearShortcutOverride);
  const resetAllShortcutOverrides = useUIStore((state) => state.resetAllShortcutOverrides);
  const pluginCommands = useCommandShortcuts();
  const pluginCommandsById = React.useMemo(() => new Map(pluginCommands.map((command) => [command.id, command])), [pluginCommands]);

  const actions = React.useMemo(() => {
    const all = [...getCustomizableShortcutActions(), ...pluginCommands];
    if (!isVSCodeRuntime()) {
      return all;
    }
    return all.filter((action) => action.id !== 'toggle_prompt_navigator');
  }, [pluginCommands]);
  const allActions = React.useMemo(() => [...getShortcutActions(), ...pluginCommands], [pluginCommands]);

  const labelOf = React.useMemo(() => (action: ShortcutAction): string => {
    if (pluginCommandsById.has(action.id)) return action.label;
    const key = `settings.yuri.keyboardShortcuts.action.${action.id}.label`;
    const translated = t(key as Parameters<typeof t>[0]);
    return translated === key ? action.label : translated;
  }, [pluginCommandsById, t]);

  const [query, setQuery] = React.useState('');
  const [recording, setRecording] = React.useState(false);
  const [recorded, setRecorded] = React.useState<ShortcutCombo | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; index: number; draft: ShortcutCombo | null } | null>(null);

  const rows = React.useMemo<ShortcutRowModel[]>(() => actions.map((action) => {
    const combos = getEffectiveShortcutCombos(action, shortcutOverrides).filter(Boolean);
    const conflicts = new Map<string, ShortcutAction>();
    for (const combo of combos) {
      for (const other of findShortcutConflicts(action, combo, allActions, shortcutOverrides)) conflicts.set(other.id, other);
    }
    const plugin = pluginCommandsById.get(action.id);
    const label = labelOf(action);
    return {
      action,
      plugin,
      label,
      combos,
      customized: isShortcutCustomized(action, shortcutOverrides),
      conflictLabels: [...conflicts.values()].map(labelOf),
      searchText: [label, action.label, plugin ? `${plugin.pluginId} ${plugin.commandId}` : action.id, ...combos.map(comboSearchText)]
        .join(' ').toLowerCase(),
    };
  }), [actions, allActions, labelOf, pluginCommandsById, shortcutOverrides]);


  const editingId = editing?.id;
  const visibleRows = React.useMemo(() => {
    const queryCombo = queryAsCombo(query);
    const tokens = query.trim().toLowerCase().split(/[\s+]+/).filter(Boolean);
    return rows.filter((row) => {
      if (row.action.id === editingId) return true;
      if (recorded) return row.combos.some((combo) => shortcutCombosConflict(combo, recorded));
      if (queryCombo) return row.combos.some((combo) => shortcutCombosConflict(combo, queryCombo));
      return tokens.every((token) => row.searchText.includes(token));
    });
  }, [rows, query, recorded, editingId]);

  const persistShortcutOverrides = (nextOverrides: Record<string, ShortcutCombo>) => {
    void updateDesktopSettings({ shortcutOverrides: nextOverrides });
  };

  const dropLegacyOverrides = (nextOverrides: Record<string, ShortcutCombo>, actionIds: readonly string[]) => {
    for (const legacyId of actionIds.flatMap(getLegacyShortcutIds)) {
      if (legacyId in nextOverrides) {
        delete nextOverrides[legacyId];
        clearShortcutOverride(legacyId);
      }
    }
  };

  /** Store the action's full binding list; a list equal to the defaults needs no override. */
  const writeCombos = (nextOverrides: Record<string, ShortcutCombo>, action: ShortcutAction, combos: ShortcutCombo[]) => {
    const unique = [...new Set(combos.map(normalizeCombo))];
    const defaults = getDefaultShortcutCombos(action).map(normalizeCombo);
    if (unique.length === defaults.length && unique.every((combo, index) => combo === defaults[index])) {
      delete nextOverrides[action.id];
    } else {
      nextOverrides[action.id] = unique.length > 0 ? unique.join(SHORTCUT_COMBO_SEPARATOR) : UNASSIGNED_SHORTCUT;
    }
  };

  /** Replace (or, with UNASSIGNED, remove) only the binding at `index`; the action's other bindings stay. */
  const applyBinding = useEvent((action: ShortcutAction, combo: ShortcutCombo, index: number) => {
    const normalized = normalizeCombo(combo);
    const remove = normalized === UNASSIGNED_SHORTCUT;
    const conflicts = remove ? [] : findShortcutConflicts(action, normalized, allActions, shortcutOverrides);
    const nextOverrides = { ...shortcutOverrides };

    const current = [...getEffectiveShortcutCombos(action, shortcutOverrides)];
    if (remove) current.splice(index, 1);
    else if (index < current.length) current[index] = normalized;
    else current.push(normalized);
    writeCombos(nextOverrides, action, current);

    for (const conflict of conflicts) {
      writeCombos(
        nextOverrides,
        conflict,
        getEffectiveShortcutCombos(conflict, shortcutOverrides).filter((existing) => !shortcutCombosConflict(existing, normalized)),
      );
    }
    dropLegacyOverrides(nextOverrides, [action.id, ...conflicts.map((conflict) => conflict.id)]);
    for (const id of new Set([...Object.keys(shortcutOverrides), ...Object.keys(nextOverrides)])) {
      if (nextOverrides[id] === undefined) clearShortcutOverride(id);
      else if (nextOverrides[id] !== shortcutOverrides[id]) setShortcutOverride(id, nextOverrides[id]);
    }
    persistShortcutOverrides(nextOverrides);
    setEditing(null);
  });

  const resetOne = useEvent((actionId: string) => {
    const nextOverrides = { ...shortcutOverrides };
    delete nextOverrides[actionId];
    clearShortcutOverride(actionId);
    dropLegacyOverrides(nextOverrides, [actionId]);
    persistShortcutOverrides(nextOverrides);
    setEditing(null);
  });

  const resetAll = useEvent(() => {
    resetAllShortcutOverrides();
    persistShortcutOverrides({});
    setEditing(null);
  });

  const saveEditing = useEvent(() => {
    const draft = editing?.draft;
    const action = rows.find((row) => row.action.id === editing?.id)?.action;
    if (draft && action) applyBinding(action, draft, editing!.index);
  });

  const editorFor = (row: ShortcutRowModel): ShortcutEditorState | null => {
    if (editing?.id !== row.action.id) return null;
    const draft = editing.draft;
    const conflictLabels = draft
      ? findShortcutConflicts(row.action, draft, allActions, shortcutOverrides).map(labelOf)
      : [];
    const unchanged = draft !== null
      && normalizeCombo(draft) === normalizeCombo(row.combos[editing.index] ?? '');
    return {
      draft,
      conflictLabels,
      risky: draft !== null && isRiskyBrowserShortcut(draft),
      canSave: draft !== null && (!unchanged || conflictLabels.length > 0),
    };
  };

  const stopRecording = () => {
    setRecording(false);
    setRecorded(null);
  };
  const clearSearch = () => {
    setQuery('');
    setRecorded(null);
  };

  const searchActive = recording ? recorded !== null : query.length > 0;

  return (
    <SettingsGroup
      itemId="shortcuts.keyboard-shortcuts"
      label={(
        <div className="flex items-center gap-2">
          <span>{t('settings.yuri.keyboardShortcuts.title')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              {t('settings.yuri.keyboardShortcuts.tooltip')}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      actions={(
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          disabled={Object.keys(shortcutOverrides).length === 0}
          onClick={resetAll}
        >
          {t('settings.yuri.keyboardShortcuts.actions.resetAll')}
        </Button>
      )}
    >
      <div className="flex flex-col gap-2 border-b border-[var(--yuri-settings-row-divider)] px-[var(--yuri-settings-row-inset)] py-[var(--yuri-settings-row-block-padding)]">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          {recording ? (
            <Input
              key="record"
              readOnly
              autoFocus
              data-shortcut-capture
              aria-label={t('settings.yuri.keyboardShortcuts.search.recordKeys')}
              value={recorded ? formatShortcutForDisplay(recorded) : t('settings.yuri.keyboardShortcuts.field.pressKeys')}
              className="!h-8 !min-h-0 !pl-8 !pr-16 !text-left"
              onKeyDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === 'Escape') {
                  stopRecording();
                  return;
                }
                const combo = keyboardEventToCombo(event);
                if (combo) setRecorded(combo);
              }}
            />
          ) : (
            <Input
              key="search"
              aria-label={t('settings.yuri.keyboardShortcuts.search.placeholder')}
              placeholder={t('settings.yuri.keyboardShortcuts.search.placeholder')}
              value={query}
              className="!h-8 !min-h-0 !pl-8 !pr-16 !text-left"
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {searchActive ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t('settings.yuri.keyboardShortcuts.search.clear')}
                onClick={clearSearch}
              >
                <Icon name="close" className="size-3.5" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn('size-6', recording && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)] hover:bg-[var(--interactive-selection)]')}
              aria-label={t('settings.yuri.keyboardShortcuts.search.recordKeys')}
              title={t('settings.yuri.keyboardShortcuts.search.recordKeys')}
              aria-pressed={recording}
              onClick={recording ? stopRecording : () => setRecording(true)}
            >
              <Icon name="keyboard" className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <div className="yuri-settings-group-row py-8 text-center typography-meta text-muted-foreground">
          {t('settings.yuri.keyboardShortcuts.empty')}
        </div>
      ) : visibleRows.map((row) => (
        <ShortcutRow
          key={row.action.id}
          row={row}
          editor={editorFor(row)}
          editingIndex={editing?.id === row.action.id ? editing.index : null}
          onEdit={(index) => setEditing({ id: row.action.id, index, draft: null })}
          onDraft={(combo) => setEditing({ id: row.action.id, index: editing?.index ?? 0, draft: combo })}
          onSave={saveEditing}
          onCancel={() => setEditing(null)}
          onUnassign={() => applyBinding(row.action, UNASSIGNED_SHORTCUT, editing?.index ?? 0)}
          onReset={() => resetOne(row.action.id)}
        />
      ))}
    </SettingsGroup>
  );
};
