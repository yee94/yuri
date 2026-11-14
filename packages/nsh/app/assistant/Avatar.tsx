import { Image, Text, View } from 'nsh';
import { colors, statusColor } from '../core/theme';

const hashed = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
};

const cache = new Map<string, string>();

/** A stable face per bot seed; Web's animated Grok anatomy is not reproduced. */
export function assistantAvatarSource(seed: string | undefined): string {
  const key = seed?.trim() || 'default';
  const hit = cache.get(key);
  if (hit) return hit;
  const value = hashed(key);
  const hue = value % 360;
  const light = 58 + (value % 10);
  const silhouettes = [
    '<rect x="5" y="5" width="38" height="38" rx="13" />',
    '<circle cx="24" cy="24" r="19" />',
    '<rect x="7" y="3" width="34" height="42" rx="17" />',
    '<path d="M24 3 45 42H3Z" />',
    '<path d="M24 3l6 12 13 2-9 9 2 13-12-6-12 6 2-13-9-9 13-2z" />',
    '<path d="M15 5h18l10 10v18l-10 10H15L5 33V15z" />',
  ];
  const silhouette = silhouettes[value % silhouettes.length];
  const eyes = value % 3;
  const eyeRow =
    eyes === 0
      ? '<circle cx="17" cy="23" r="3.4" fill="#20232b" /><circle cx="31" cy="23" r="3.4" fill="#20232b" />'
      : eyes === 1
        ? '<rect x="13" y="20" width="7" height="6" rx="3" fill="#20232b" /><rect x="28" y="20" width="7" height="6" rx="3" fill="#20232b" />'
        : '<ellipse cx="17" cy="23" rx="3.6" ry="4.4" fill="#20232b" /><ellipse cx="31" cy="23" rx="3.6" ry="4.4" fill="#20232b" />';
  const mouth =
    value % 2 === 0
      ? '<path d="M19 32q5 4 10 0" stroke="#20232b" stroke-width="2" fill="none" stroke-linecap="round" />'
      : '<path d="M20 32h8" stroke="#20232b" stroke-width="2" stroke-linecap="round" />';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">` +
    `<g fill="hsl(${hue} 62% ${light}%)">${silhouette}</g>` +
    eyeRow +
    mouth +
    `</svg>`;
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(key, uri);
  return uri;
}

export function AssistantAvatar(props: { seed?: string; size: number; label?: string }) {
  return (
    <Image
      src={assistantAvatarSource(props.seed)}
      accessibilityLabel={props.label}
      style={{ width: props.size, height: props.size, borderRadius: 8 }}
    />
  );
}

/** Web `AssistantWorkingAvatar`: the face with its working dot on the bottom-right corner. */
export function AssistantWorkingAvatar(props: { seed?: string; size: number; label?: string; working?: boolean }) {
  return (
    <View style={{ width: props.size, height: props.size }}>
      <AssistantAvatar seed={props.seed} size={props.size} label={props.label} />
      <If when={!!props.working}>
        <View
          testID="assistant-working-dot"
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: statusColor('success'),
            borderWidth: 2,
            borderColor: colors.background(),
            transform: [{ translateX: 2 }, { translateY: 2 }],
          }}
        />
      </If>
    </View>
  );
}

/** Web `AssistantUnreadBadge`: an 18pt pill over the avatar's corner. */
export function AssistantUnread(props: { count: number }) {
  return (
    <If when={props.count > 0}>
      <View
        style={{
          minWidth: 18,
          height: 18,
          borderRadius: 9,
          paddingHorizontal: 6,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#F95252',
        }}
      >
        <Text style={{ fontSize: 12, lineHeight: 14, fontWeight: '600', color: '#ffffff' }}>
          {props.count > 99 ? '99+' : String(props.count)}
        </Text>
      </View>
    </If>
  );
}
