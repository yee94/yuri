import React from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { foldGutter } from '@codemirror/language';
import { EditorView, placeholder as editorPlaceholder } from '@codemirror/view';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { shikiHighlightExtension } from '@/lib/codemirror/shikiHighlight';
import { getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { cn } from '@/lib/utils';

type SettingsJsonEditorProps = {
  value: string;
  onChange: (value: string) => void;
  fileName?: string;
  className?: string;
  readOnly?: boolean;
  hasError?: boolean;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
};

export function SettingsJsonEditor({
  value, onChange, fileName = 'config.json', className, readOnly = false,
  hasError = false, id, ariaLabel, placeholder,
}: SettingsJsonEditorProps) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const extensions = React.useMemo<Extension[]>(() => {
    const attributes: Record<string, string> = {
      'aria-invalid': String(hasError),
      'aria-disabled': String(readOnly),
      spellcheck: 'false',
    };
    if (id) attributes.id = id;
    if (ariaLabel) attributes['aria-label'] = ariaLabel;
    const language = languageByExtension(fileName);
    return [
      createFlexokiCodeMirrorTheme(currentTheme, { syntaxColors: false }),
      foldGutter(),
      EditorState.phrases.of({
        'Fold line': t('settings.jsonEditor.fold'),
        'Unfold line': t('settings.jsonEditor.unfold'),
        unfold: t('settings.jsonEditor.unfold'),
        'folded code': t('settings.jsonEditor.foldedCode'),
      }),
      ...(language ? [language] : []),
      shikiHighlightExtension({
        language: fileName.endsWith('.jsonc') ? 'jsonc' : 'json',
        themeName: currentTheme.metadata.id,
        theme: getResolvedShikiTheme(currentTheme),
      }),
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of(attributes),
      ...(placeholder ? [editorPlaceholder(placeholder)] : []),
    ];
  }, [currentTheme, fileName, t, hasError, readOnly, id, ariaLabel, placeholder]);

  return (
    <div className={cn(
      'h-full min-w-0 overflow-hidden bg-background focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--interactive-focus-ring)]',
      hasError && 'ring-1 ring-inset ring-[var(--status-error)] focus-within:ring-[var(--status-error)]',
      className,
    )}>
      <CodeMirrorEditor value={value} onChange={onChange} readOnly={readOnly} extensions={extensions} enableSearch />
    </div>
  );
}
