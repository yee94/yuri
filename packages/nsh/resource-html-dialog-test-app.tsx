import { effect, mount, signal, untracked, View, Text } from 'nsh';
import { NavPage, NavStack, createNavStack } from 'nsh/base';
import { ResourceHtmlViewer } from './resource-html-viewer';
import { language } from './i18n';

function SyntheticPresentation(props: { closing: boolean; closed(): void }) {
  effect(() => { if (props.closing) untracked(() => { void Promise.resolve().then(() => props.closed()); }); });
  return <View testID="html-dialog-anchor" style={{ position: 'absolute', width: 0, height: 0 }} />;
}

/** Real NSH Dialog/NavStack event loop with synthetic display and retirement ports. */
function HtmlDialogFixture() {
  language.set('en');
  const nav = createNavStack(['root']), closed = signal(0);
  let serial = 0;
  const viewer = <ResourceHtmlViewer title="Synthetic HTML" input={{ identity: 'synthetic-html', active: true, htmlFile: true, gui: 'bypassed' }}
      identifyMount={() => `display-${++serial}`} closePreview={async () => { closed.set(closed() + 1); }} onBack={() => {}}
      renderPreview={owner => <View class="flex-1"><Text testID="html-dialog-preview">{owner.presentation}</Text></View>}
      renderSource={() => <Text testID="html-dialog-source">Synthetic source</Text>} renderStatus={() => null} renderActions={() => null}
      presentationAnchor={(_, lifecycle) => <SyntheticPresentation closing={lifecycle.closing} closed={lifecycle.closed} />} />;
  const page = <NavPage title="Synthetic HTML parent" class="flex-1"><Text testID="html-dialog-close-count">{String(closed())}</Text>{viewer}</NavPage>;
  return <NavStack state={nav} class="flex-1">{() => page}</NavStack>;
}
mount(HtmlDialogFixture);
