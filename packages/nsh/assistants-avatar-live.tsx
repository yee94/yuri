import { cleanup, computed, effect, Image, lifecycle, reduceMotion, signal, untracked } from 'nsh';
import { assistantAvatarSvg } from '../ui/src/lib/assistant-avatar/engine';
import { resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import { nativeAssistantAvatarClock, type NativeAvatarLease } from './assistants-avatar-clock';
import { text, type Row } from './model';
import { app, epoch } from './state';

export function AssistantAvatar(props: { bot: Row; size?: number; active?: boolean; testID?: string }) {
  const captured = epoch();
  const seed = () => text(props.bot.avatarSeed) || text(props.bot.id);
  const still = computed(() => 'data:image/svg+xml,' + encodeURIComponent(assistantAvatarSvg(seed())));
  const frame = signal('');
  let lease: NativeAvatarLease | null = null, key = '', alive = true;
  const release = () => { lease?.release(); lease = null; };
  effect(() => {
    const identity = text(props.bot.id), value = seed(), connectionID = app.connection()?.id;
    const eligible = props.active === true && lifecycle() === 'active' && !reduceMotion() && resolveAssistantAvatar(value).animate && captured === epoch();
    const working = props.bot.working === true || !!props.bot.activeContactTurn;
    const nextKey = JSON.stringify([captured, connectionID, identity, value]);
    untracked(() => {
      if (!eligible || key !== nextKey) { release(); frame.set(''); }
      key = nextKey;
      if (!eligible) return;
      if (lease) lease.working(working);
      else if (working) lease = nativeAssistantAvatarClock.subscribe(JSON.stringify([captured, connectionID]), identity, value, sample => {
        if (!alive || captured !== epoch()) return;
        frame.set(sample.uri);
        if (sample.settled) release();
      });
    });
  });
  cleanup(() => { alive = false; release(); });
  return <Image testID={props.testID} src={frame() || still()} style={{ width: props.size ?? 44, height: props.size ?? 44 }} />;
}
