import { locale, signal } from "nsh";
import { dict as en, type I18nKey } from "../ui/src/lib/i18n/messages/en";
import { dict as zhCN } from "../ui/src/lib/i18n/messages/zh-CN";
import { dict as zhTW } from "../ui/src/lib/i18n/messages/zh-TW";
import { dict as ja } from "../ui/src/lib/i18n/messages/ja";
import { dict as ko } from "../ui/src/lib/i18n/messages/ko";
import { dict as fr } from "../ui/src/lib/i18n/messages/fr";
import { dict as es } from "../ui/src/lib/i18n/messages/es";
import { dict as pl } from "../ui/src/lib/i18n/messages/pl";
import { dict as ptBR } from "../ui/src/lib/i18n/messages/pt-BR";
import { dict as uk } from "../ui/src/lib/i18n/messages/uk";

export const language = signal("system");
export const currentLocale = () => language() === 'system' ? locale() : language();
const dictionaries: Record<string, Record<I18nKey, string>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  fr,
  es,
  pl,
  "pt-BR": ptBR,
  uk,
};
export function t(
  key: I18nKey,
  params: Record<string, string | number> = {},
): string {
  const selected = currentLocale();
  const normalized = selected.startsWith("zh")
    ? /TW|HK|Hant/.test(selected)
      ? "zh-TW"
      : "zh-CN"
    : selected.startsWith("pt")
      ? "pt-BR"
      : selected.split("-")[0];
  const value = (dictionaries[normalized] ?? en)[key] ?? en[key];
  return value.replace(/\{(\w+)\}/g, (whole, name: string) =>
    String(params[name] ?? whole),
  );
}
