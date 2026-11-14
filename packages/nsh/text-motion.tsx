import { cleanup, createMotion, effect, lifecycle, reduceMotion, signal, Text, untracked, View, type TextStyle } from 'nsh';
import { CHARACTER_FADE_DURATION, SHIMMER_DURATION, characterFadeDelay, characterFadePlan, characterFadeTotal, flipPlan, FLIP_DURATION } from './text-motion-model';

/** Motions only while the app is on screen and the user allows motion. */
const active = () => lifecycle() === 'active' && !reduceMotion();

/**
 * Web renders live labels with a highlight sweeping across the glyphs
 * (`animate-text-shimmer`, 1.7s linear infinite, `background-clip: text`).
 * Native text cannot clip a gradient to its glyphs, so the nearest lossless
 * form is one label at the same 1.7s cadence: its opacity rises and falls
 * between the base colour and the highlight colour. One native opacity motion,
 * no extra text node, no geometry change, and it never restarts on unrelated
 * state updates.
 */
export function NativeShimmerText(props: {
  text: string;
  active: boolean;
  class?: string;
  /** Typography of the label; its colour stays the one the call site already uses. */
  style?: TextStyle;
  testID?: string;
  /** Host generation / chat fence, so a retired row never animates. */
  current?: () => boolean;
}) {
  const motion = createMotion({ initial: { opacity: 1 } });
  effect(() => {
    const on = props.active && lifecycle() === 'active' && !reduceMotion() && (props.current?.() ?? true);
    if (!on) {
      motion.stop();
      motion.opacity.set(1);
      return;
    }
    void motion.play({
      keyframes: [{ offset: 0, opacity: 0.45 }, { offset: 0.5, opacity: 1 }, { offset: 1, opacity: 0.45 }],
      duration: SHIMMER_DURATION,
      easing: 'easeInOut',
      iterations: 'infinite',
    });
    return motion.stop;
  });
  cleanup(motion.stop);
  return <Text testID={props.testID} class={props.class} style={{ ...props.style, opacity: motion.opacity }}>{props.text}</Text>;
}

/**
 * Web FlipUpText (components/chat/message/parts/FlipUpText.tsx): the previous
 * summary slides up and fades out while the new one slides in from below
 * (280ms ease-out). Streamed summaries change faster than 280ms, so a running
 * flip is never restarted: it keeps the outgoing text and shows the newest text
 * the moment it lands, as the Web `displayed` state does.
 */
export function NativeFlipUpText(props: {
  text: string;
  active: boolean;
  /** Layout classes of the viewport (Web: flex-1 min-w-0 for a summary cell). */
  class?: string;
  /** Typography of both layers (fontSize/lineHeight decide the viewport height). */
  style?: TextStyle;
  current?: () => boolean;
}) {
  const state = signal<{ shown: string; outgoing: string | null }>({ shown: props.text, outgoing: null });
  const out = createMotion({ initial: { opacity: 1 } }), incoming = createMotion({ initial: { opacity: 0 } });
  let generation = 0;
  effect(() => {
    const next = props.text;
    const active = props.active && lifecycle() === 'active' && !reduceMotion() && (props.current?.() ?? true);
    untracked(() => {
      const value = state();
      const plan = flipPlan(value.shown, next, active, value.outgoing !== null);
      if (plan === 'hold') return;
      if (plan === 'replace') {
        generation++;
        out.stop();
        incoming.stop();
        state.set({ shown: next, outgoing: null });
        return;
      }
      if (plan === 'defer') {
        // Keep the outgoing text and the running motions: only the newest value lands.
        state.set({ shown: next, outgoing: value.outgoing });
        return;
      }
      state.set({ shown: next, outgoing: value.shown });
      const id = ++generation;
      const height = lineHeight(props.style);
      void Promise.all([
        out.play({ keyframes: [{ offset: 0, translateY: 0, opacity: 1 }, { offset: 1, translateY: -height, opacity: 0 }], duration: FLIP_DURATION, easing: 'easeOut' }),
        incoming.play({ keyframes: [{ offset: 0, translateY: height, opacity: 0 }, { offset: 1, translateY: 0, opacity: 1 }], duration: FLIP_DURATION, easing: 'easeOut' }),
      ]).then(([finished]) => {
        if (id !== generation || !finished.finished) return;
        const latest = state();
        if (latest.outgoing !== null) state.set({ shown: latest.shown, outgoing: null });
      });
    });
  });
  cleanup(() => {
    generation++;
    out.stop();
    incoming.stop();
  });
  const layer = () => ({ position: 'absolute' as const, top: 0, left: 0, right: 0, pointerEvents: 'none' as const, overflow: 'hidden' as const, height: lineHeight(props.style) });
  const text = () => ({ ...props.style, lineHeight: lineHeight(props.style) });
  return (
    <View class={props.class} style={{ position: 'relative', height: lineHeight(props.style), overflow: 'hidden' }}>
      <Text style={{ ...text(), opacity: state().outgoing === null ? 1 : 0 }}>{state().shown}</Text>
      <If when={state().outgoing !== null}>
        <View style={{ ...layer(), opacity: out.opacity, transform: [{ translateY: out.translateY }] }} accessibilityElementsHidden>
          <Text style={text()}>{state().outgoing}</Text>
        </View>
        <View style={{ ...layer(), opacity: incoming.opacity, transform: [{ translateY: incoming.translateY }] }} accessibilityElementsHidden>
          <Text style={text()}>{state().shown}</Text>
        </View>
      </If>
    </View>
  );
}

/**
 * Whole-text fallback for the generate-effect on text that is too long to split
 * per character (Web's `animateTailText` sits on file paths and tool tails).
 * One opacity motion, same 140ms, only when this text appears where nothing was
 * shown before, so a recycled row never replays it.
 */
export function NativeFadeInText(props: {
  text: string;
  class?: string;
  style?: TextStyle;
  current?: () => boolean;
}) {
  const motion = createMotion({ initial: { opacity: 1 } });
  let previous = '';
  effect(() => {
    const next = props.text;
    untracked(() => {
      if (next === previous) return;
      const entered = previous.length === 0 && next.length > 0 && active() && (props.current?.() ?? true);
      previous = next;
      if (!entered) {
        motion.stop();
        motion.opacity.set(1);
        return;
      }
      void motion.play({ keyframes: [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }], duration: CHARACTER_FADE_DURATION, easing: 'easeOut' });
    });
  });
  cleanup(motion.stop);
  return <Text class={props.class} style={{ ...props.style, opacity: motion.opacity }}>{props.text}</Text>;
}

/** Web's mobile flip viewport is exactly one `leading-5`/`h-5` line (20px). */
const FLIP_VIEWPORT_HEIGHT = 20;
function lineHeight(style: TextStyle | undefined): number {
  return Math.max(FLIP_VIEWPORT_HEIGHT, style?.lineHeight ?? 0);
}

/**
 * Web `<Text variant="generate-effect">` (components/ui/text.tsx): every
 * character starts at opacity 0 and fades in over 140ms, staggered by
 * `min(index * 4.5, 140)`ms. Native splits only short, newly appeared text:
 * a longer title or a tail text stays one Text, and the node count drops back
 * to one as soon as the entrance is over.
 */
export function NativeCharacterFadeText(props: {
  text: string;
  class?: string;
  style?: TextStyle;
  /** Long text falls back to a plain Text. */
  limit?: number;
  current?: () => boolean;
}) {
  const characters = signal<string[] | null>(null);
  let previous = '';
  effect(() => {
    const next = props.text;
    untracked(() => {
      if (next === previous) return;
      const animate = active() && (props.current?.() ?? true);
      const plan = animate ? characterFadePlan(previous, next, props.limit) : null;
      previous = next;
      characters.set(plan);
    });
  });
  effect(() => {
    const plan = characters();
    if (!plan) return;
    previous = props.text;
    const timer = setTimeout(() => { if (characters() === plan) characters.set(null); }, characterFadeTotal(plan.length) + 40);
    return () => clearTimeout(timer);
  });
  return (
    <Text class={props.class} style={props.style} accessibilityLabel={props.text}>
      <If when={!!characters()} else={<Text style={{ opacity: 1 }}>{props.text}</Text>}>
        <Each of={(characters() ?? []).map((value, index) => ({ value, index }))} key={character => String(character.index)}>{character => {
          const motion = createMotion({ initial: { opacity: 0 } });
          effect(() => {
            if (!active()) {
              motion.stop();
              motion.opacity.set(1);
              return;
            }
            void motion.play({ keyframes: [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }], duration: CHARACTER_FADE_DURATION, delay: characterFadeDelay(character().index), easing: 'easeOut' });
            return motion.stop;
          });
          cleanup(motion.stop);
          return <Text style={{ opacity: motion.opacity }}>{character().value === ' ' ? '\u00A0' : character().value}</Text>;
        }}</Each>
      </If>
    </Text>
  );
}
