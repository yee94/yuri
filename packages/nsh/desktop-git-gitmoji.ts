/** Offline Gitmoji shortcode catalog. Opening/inserting never makes a request or
 * requires a new native network permission. A shell may supply an updated catalog. */
export type DesktopGitmoji = { emoji: string; code: string; description: string };
const entries = [
  ['🎨', 'art'], ['⚡️', 'zap'], ['🔥', 'fire'], ['🐛', 'bug'], ['🚑️', 'ambulance'], ['✨', 'sparkles'], ['📝', 'memo'], ['🚀', 'rocket'], ['💄', 'lipstick'], ['🎉', 'tada'],
  ['✅', 'white_check_mark'], ['🔒️', 'lock'], ['🔐', 'closed_lock_with_key'], ['🔖', 'bookmark'], ['🚨', 'rotating_light'], ['🚧', 'construction'], ['💚', 'green_heart'], ['⬇️', 'arrow_down'], ['⬆️', 'arrow_up'], ['📌', 'pushpin'],
  ['👷', 'construction_worker'], ['📈', 'chart_with_upwards_trend'], ['♻️', 'recycle'], ['➕', 'heavy_plus_sign'], ['➖', 'heavy_minus_sign'], ['🔧', 'wrench'], ['🔨', 'hammer'], ['🌐', 'globe_with_meridians'], ['✏️', 'pencil2'], ['💩', 'poop'],
  ['⏪️', 'rewind'], ['🔀', 'twisted_rightwards_arrows'], ['📦️', 'package'], ['👽️', 'alien'], ['🚚', 'truck'], ['📄', 'page_facing_up'], ['💥', 'boom'], ['🍱', 'bento'], ['♿️', 'wheelchair'], ['💡', 'bulb'],
  ['🍻', 'beers'], ['💬', 'speech_balloon'], ['🗃️', 'card_file_box'], ['🔊', 'loud_sound'], ['🔇', 'mute'], ['👥', 'busts_in_silhouette'], ['🚸', 'children_crossing'], ['🏗️', 'building_construction'], ['📱', 'iphone'], ['🤡', 'clown_face'],
  ['🥚', 'egg'], ['🙈', 'see_no_evil'], ['📸', 'camera_flash'], ['⚗️', 'alembic'], ['🔍️', 'mag'], ['🏷️', 'label'], ['🌱', 'seedling'], ['🚩', 'triangular_flag_on_post'], ['🥅', 'goal_net'], ['💫', 'dizzy'],
  ['🗑️', 'wastebasket'], ['🛂', 'passport_control'], ['🩹', 'adhesive_bandage'], ['🧐', 'monocle_face'], ['⚰️', 'coffin'], ['🧪', 'test_tube'], ['👔', 'necktie'], ['🩺', 'stethoscope'], ['🧱', 'bricks'], ['🧑‍💻', 'technologist'],
  ['💸', 'money_with_wings'], ['🧵', 'thread'], ['🦺', 'safety_vest'],
] as const;
export const desktopGitmojis: readonly DesktopGitmoji[] = entries.map(([emoji, name]) => ({ emoji, code: `:${name}:`, description: name.replace(/_/g, ' ') }));
export function insertDesktopGitmoji(message: string, entry: DesktopGitmoji) {
  const trimmed = message.trimStart();
  return trimmed.startsWith(entry.emoji) || trimmed.startsWith(entry.code) ? message : `${entry.code || entry.emoji} ${message}`.trimStart();
}
