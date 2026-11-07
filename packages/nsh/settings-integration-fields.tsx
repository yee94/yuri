import { openUrl, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { record, text, type Row } from './model';
import { SettingsChoice, SettingsInput, SettingsToggle, settingsAction } from './settings-controls';
import { integrationForm, type IntegrationFormDraft, type IntegrationFormValue } from './settings-integration-form';

export function SettingsIntegrationFields(props: { fields: Row[]; draft: IntegrationFormDraft; disabled: boolean; showErrors: boolean; onChange: (key: string, value: IntegrationFormValue) => void; onError: () => void }) {
  const form = () => { try { return integrationForm(props.fields, props.draft); } catch { return { visible: [], answer: {}, invalid: ['schema'] }; } };
  const value = (field: Row) => Object.prototype.hasOwnProperty.call(props.draft, text(field.key)) ? props.draft[text(field.key)] : field.default;
  return <View class="gap-3">
    <Each of={form().visible}>{field => <View class="gap-2">
      <If when={!!field().description}><Text class="text-xs text-muted-foreground">{text(field().description)}</Text></If>
      <If when={field().type === 'external'}><Button class={settingsAction} disabled={props.disabled} onPress={() => { void (async () => { try { const url = text(field().url); if (!/^https?:\/\//i.test(url) || !(await openUrl(url)).opened) props.onError(); } catch { props.onError(); } })(); }}><Text class="text-foreground">{text(field().title) || text(field().url)}</Text></Button></If>
      <If when={field().type === 'boolean'}><SettingsToggle title={text(field().title) || text(field().key)} value={value(field()) === true} disabled={props.disabled} onChange={next => props.onChange(text(field().key), next)} /></If>
      <If when={field().type === 'multiselect'}>
        <Text class="text-sm text-foreground">{text(field().title) || text(field().key)}</Text>
        <Each of={Array.isArray(field().options) ? field().options as Row[] : []}>{option => <View class="gap-1"><SettingsToggle title={text(option().label)} value={Array.isArray(value(field())) && (value(field()) as string[]).includes(text(option().value))} disabled={props.disabled} onChange={next => { const previous = Array.isArray(value(field())) ? value(field()) as string[] : []; props.onChange(text(field().key), next ? [...previous, text(option().value)] : previous.filter(item => item !== option().value)); }} /><If when={!!option().description}><Text class="text-xs text-muted-foreground">{text(option().description)}</Text></If></View>}</Each>
        <If when={field().custom === true}><SettingsInput testID={`integration-field-${text(field().key)}`} title={text(field().title) || text(field().key)} value={Array.isArray(value(field())) ? (value(field()) as string[]).join('\n') : ''} multiline disabled={props.disabled} onChange={next => props.onChange(text(field().key), [...new Set(next.split('\n').filter(Boolean))])} /></If>
      </If>
      <If when={field().type === 'string' && Array.isArray(field().options) && (field().options as unknown[]).length > 0}>
        <SettingsChoice title={text(field().title) || text(field().key)} value={typeof value(field()) === 'string' ? value(field()) as string : ''} items={(field().options as Row[]).map(option => ({ value: text(option.value), title: text(option.label) }))} disabled={props.disabled} onChange={next => props.onChange(text(field().key), next)} />
      </If>
      <If when={['number', 'integer'].includes(text(field().type)) || (field().type === 'string' && (!Array.isArray(field().options) || !(field().options as unknown[]).length || field().custom === true))}>
        <SettingsInput testID={`integration-field-${text(field().key)}`} title={text(field().title) || text(field().key)} value={value(field()) === undefined ? '' : String(value(field()))} disabled={props.disabled} onChange={next => props.onChange(text(field().key), next)} />
      </If>
      <If when={props.showErrors && form().invalid.includes(text(field().key))}><Text class="text-sm text-destructive">{t('chat.questionCard.inputNeeded')}</Text></If>
    </View>}</Each>
    <If when={form().invalid.includes('schema')}><Text class="text-destructive">{t('assistants.state.invalidConfiguration')}</Text></If>
  </View>;
}
