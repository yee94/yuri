import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as helpers from '../chat-models-helpers';
import { createFeaturePicker } from '../features-picker-core';
import type { ModelRef } from '../chat-models-helpers';
import { nativeLayoutDensity } from '../native-density';

type Props = Record<string, unknown>;
type Element = { type: string | ((props: Props) => Element); props: Props; children: unknown[] };
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };

/** Production JSX callbacks with explicit parent/content teardown; no NSH renderer or sheet simulation proof. */
export function featurePickerFixture(request: (path: string, method?: string, body?: unknown) => Promise<unknown>, padding = 100) {
  const parentCleanup: (() => void)[] = []; let contentCleanup: (() => void)[] = [], currentCleanup = parentCleanup;
  let current = true, selected: ModelRef = { providerID: 'p', modelID: 'm', variant: 'high' }, content: Element | undefined, contentProps: Props | undefined;
  const selections: ModelRef[] = [];
  const h = (type: Element['type'], props: Props | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
  const imports: Record<string, unknown> = {
    nsh: { cleanup: (work: () => void) => currentCleanup.push(work), signal, computed: (read: () => unknown) => read, locale: () => 'en', Text: 'Text', View: 'View', Scroll: 'Scroll' },
    'nsh/base': { Button: 'Button' },
    './sheet-search': { NativeSheetSearch: 'NativeSheetSearch' }, './Icon': { Icon: 'Icon' },
    './chat-identity': { NativeModelLogo: 'NativeModelLogo' }, './provider-logo': { NativeProviderLogo: 'NativeProviderLogo' },
    './native-sheet': { NativeSheet: 'NativeSheet' },
    './model-picker-presentation': { createModelPickerSheet: () => ({ reset() {}, height: () => 500 }), NativeModelPickerHandle: 'NativeModelPickerHandle', NativeModelVariants: 'NativeModelVariants', NativeModelVariantHeader: 'NativeModelVariantHeader' },
    './chat-models-helpers': helpers, './i18n': { t: (key: string) => key, language: () => 'en' },
    './model': { text: (value: unknown) => typeof value === 'string' ? value : '' }, './features-picker-core': { createFeaturePicker },
    './appearance': { nativeDensity: () => nativeLayoutDensity(padding) },
  };
  const javascript = ts.transpileModule(readFileSync(fileURLToPath(new URL('../features-model-picker.tsx', import.meta.url)), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' },
    // NSH lazily constructs the nullable variant-page branch. TypeScript's React
    // JSX lowering is eager, so preserve that guard in this callback-only VM.
    transformers: { before: [context => source => {
      const visit: ts.Visitor = node => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'If') {
          const when = node.openingElement.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'when');
          if (when && ts.isJsxAttribute(when) && when.initializer && ts.isJsxExpression(when.initializer) && when.initializer.expression?.getText() === 'target()') {
            return ts.factory.createJsxExpression(undefined, ts.factory.createConditionalExpression(when.initializer.expression, undefined, ts.visitEachChild(node, visit, context), undefined, ts.factory.createNull()));
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitEachChild(source, visit, context);
    }] },
  }).outputText;
  const exports: Record<string, (props: Props) => Element> = {};
  vm.runInNewContext(javascript, { exports, require: (name: string) => { if (!(name in imports)) throw new Error(`Unmocked picker import ${name}`); return imports[name]; }, h, If: 'If', Each: 'Each', Map, Set, Object, String, Promise, Error }, { filename: 'features-model-picker.tsx' });
  const ownerProps: Props = { providers: [{ id: 'p', name: 'Provider', models: { m: { id: 'm', name: 'Model', variants: { high: {} } } } }], selected, disabled: false, loading: false, error: '', partial: false, current: () => current, request, reload: () => {}, onChange: (value: ModelRef) => { selected = value; selections.push(value); } };
  const root = exports.FeaturesModelPicker(ownerProps);
  function nodes(value: unknown): Element[] {
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Element; return [node, ...node.children.flat(Infinity).flatMap(nodes)];
  }
  function find(value: unknown, predicate: (node: Element) => boolean) { const node = nodes(value).find(predicate); if (!node) throw new Error('Missing picker fixture element'); return node; }
  const sheet = find(root, node => node.type === 'NativeSheet');
  const child = find(root, node => typeof node.type === 'function' && node.type.name === 'PickerContent');
  const press = (node: Element) => (node.props.onPress as () => void)();
  function row() {
    const providerEach = find(content, node => node.type === 'Each' && Array.isArray(node.props.of) && !!(node.props.of[0] as { models?: unknown[] } | undefined)?.models);
    const group = (providerEach.children[0] as (read: () => unknown) => Element)(() => (providerEach.props.of as unknown[])[0]);
    const modelEach = find(group, node => node.type === 'Each' && Array.isArray(node.props.of) && !!(node.props.of[0] as { modelID?: string } | undefined)?.modelID);
    return (modelEach.children[0] as (read: () => unknown) => Element)(() => (modelEach.props.of as unknown[])[0]);
  }
  return {
    selections,
    contentStyle: () => find(content, node => node.type === 'Scroll').props.contentStyle,
    open() {
      press(find(root, node => node.props.testID === 'features-model-picker'));
      (sheet.props.onOpen as () => void)(); currentCleanup = contentCleanup = [];
      contentProps = { ...child.props, selected }; content = (child.type as (props: Props) => Element)(contentProps); currentCleanup = parentCleanup;
    },
    close() { (sheet.props.onOpenChange as (event: { open: boolean }) => void)({ open: false }); (sheet.props.onClose as () => void)(); contentCleanup.forEach(work => work()); content = undefined; contentProps = undefined; },
    choose() { press(find(row(), node => node.props.testID === 'features-model-all-p-m')); },
    favorite() { press(find(row(), node => node.props.testID === 'features-favorite-all-p-m')); },
    retry() { press(find(content, node => node.props.testID === 'features-model-retry')); },
    modelDisabled: () => find(row(), node => node.props.testID === 'features-model-all-p-m').props.disabled,
    favoriteDisabled: () => find(row(), node => node.props.testID === 'features-favorite-all-p-m').props.disabled,
    visible: () => !!contentProps && (contentProps.current as () => boolean)(),
    dismissible: () => sheet.props.closeOnSwipe === true && sheet.props.closeOnBackdropPress === true && sheet.props.closeOnEscape === true,
    retire(rebind = false) { current = false; if (rebind) ownerProps.current = () => true; },
    dispose() { contentCleanup.forEach(work => work()); parentCleanup.forEach(work => work()); },
  };
}
