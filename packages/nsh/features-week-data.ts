// Captured from Node ICU 78.3 / Unicode CLDR 48.0 Intl.Locale.getWeekInfo().
// Enumerated all two-letter regions/languages; 001 is CLDR's world first-day rule.
// These are calendar data, not a runtime guess that every locale starts Monday.
const sundayRegions = new Set('AG AS BD BR BS BT BU BW BZ CA CO DM DO ET GT GU HK HN ID IL IN IS JM JP JT KE KH KR LA MH MI MM MO MT MX MZ NI NP NT PA PE PH PK PR PT PU PY PZ RH SA SG SV TH TT TW UM US VE VI WK WS YD YE ZA ZW'.split(' '));
const saturdayRegions = new Set('AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '));
const sundayLanguages = new Set('aa af am as bh bn ch cr dz en gn gu he hi id ik in is iu iw ja jv jw ki km kn ko ks lo mh ml mr mt my nd ne nr nv oj om or pa pt qu sa sd sm sn ss st su ta te th ti tl tn ts ur ve xh zu fil haw yue'.split(' '));
const saturdayLanguages = new Set('ae ar fa ps'.split(' '));
const scriptDays: Readonly<Record<string, number>> = { 'en-Latn': 0, 'en-Shaw': 1, 'fr-Latn': 1, 'es-Latn': 1, 'pl-Latn': 1, 'pt-Latn': 0, 'ja-Jpan': 0, 'ko-Kore': 0, 'uk-Cyrl': 1, 'zh-Hans': 1, 'zh-Hant': 0 };

export function cldrWeekStart(locale: string): number {
  // NSH documents getCanonicalLocales, but does not implement Intl.Locale at all.
  const normalized = Intl.getCanonicalLocales(locale)[0];
  if (!normalized) throw new Error('locale-week-data-unavailable');
  const parts = normalized.split('-'), language = parts[0].toLowerCase();
  let script: string | undefined, territory: string | undefined;
  for (const part of parts.slice(1)) {
    if (part.length === 1) break;
    if (/^[A-Za-z]{4}$/.test(part)) script = part;
    if (/^[A-Za-z]{2}$|^[0-9]{3}$/.test(part)) territory = part.toUpperCase();
  }
  const explicitDay = /-fw-(sun|mon|tue|wed|thu|fri|sat)(?:-|$)/i.exec(normalized)?.[1]?.toLowerCase();
  if (explicitDay) return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(explicitDay);
  const override = /-rg-([a-z]{2}|[0-9]{3})zzzz(?:-|$)/i.exec(normalized)?.[1]?.toUpperCase();
  const region = override ?? territory;
  if (region) return sundayRegions.has(region) ? 0 : saturdayRegions.has(region) ? 6 : region === 'MV' ? 5 : 1;
  if (script && scriptDays[`${language}-${script}`] !== undefined) return scriptDays[`${language}-${script}`];
  if (!script) {
    if (sundayLanguages.has(language)) return 0;
    if (saturdayLanguages.has(language)) return 6;
    if (language === 'dv') return 5;
    if (/^[a-z]{2}$/.test(language)) return 1;
  }
  // For an unbundled bare language/script, use the runtime's actual formatter
  // fallback locale. Never invent a Monday rule for an unsupported locale.
  let resolved = new Intl.DateTimeFormat(normalized, { year: 'numeric' }).resolvedOptions().locale;
  if (resolved && Intl.getCanonicalLocales(resolved)[0] === normalized) resolved = new Intl.DateTimeFormat().resolvedOptions().locale;
  if (!resolved || Intl.getCanonicalLocales(resolved)[0] === normalized) throw new Error('locale-week-data-unavailable');
  return cldrWeekStart(resolved);
}
