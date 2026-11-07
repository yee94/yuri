import { effect, Image, signal, token } from 'nsh';
import { Icon } from './Icon';
import anthropic from '../ui/src/assets/provider-logos/anthropic.svg';
import bailian from '../ui/src/assets/provider-logos/bailian-coding-plan.svg';
import cursor from '../ui/src/assets/provider-logos/cursor.svg';
import deepseek from '../ui/src/assets/provider-logos/deepseek.svg';
import evroc from '../ui/src/assets/provider-logos/evroc.svg';
import copilot from '../ui/src/assets/provider-logos/github-copilot.svg';
import gocode from '../ui/src/assets/provider-logos/gocode.svg';
import google from '../ui/src/assets/provider-logos/google.svg';
import kimi from '../ui/src/assets/provider-logos/kimi-for-coding.svg';
import lmstudio from '../ui/src/assets/provider-logos/lmstudio.svg';
import magpie from '../ui/src/assets/provider-logos/magpie.svg';
import meta from '../ui/src/assets/provider-logos/meta.svg';
import minimaxCN from '../ui/src/assets/provider-logos/minimax-cn-coding-plan.svg';
import minimax from '../ui/src/assets/provider-logos/minimax-coding-plan.svg';
import nano from '../ui/src/assets/provider-logos/nano-gpt.svg';
import ollama from '../ui/src/assets/provider-logos/ollama.svg';
import openai from '../ui/src/assets/provider-logos/openai.svg';
import opencode from '../ui/src/assets/provider-logos/opencode.svg';
import openrouter from '../ui/src/assets/provider-logos/openrouter.svg';
import wafer from './assets/provider-logos/wafer.ai.png';
import workbuddy from '../ui/src/assets/provider-logos/workbuddy.svg';
import xai from '../ui/src/assets/provider-logos/xai.svg';
import zai from '../ui/src/assets/provider-logos/zai-coding-plan.svg';
import zhipu from '../ui/src/assets/provider-logos/zhipuai-coding-plan.svg';

const assets: Record<string, typeof cursor> = { anthropic, 'bailian-coding-plan': bailian, cursor, deepseek, evroc, 'github-copilot': copilot, gocode, google, 'kimi-for-coding': kimi, lmstudio, magpie, meta, 'minimax-cn-coding-plan': minimaxCN, 'minimax-coding-plan': minimax, 'nano-gpt': nano, ollama, openai, opencode, openrouter, 'wafer.ai': wafer, workbuddy, xai, 'zai-coding-plan': zai, 'zhipuai-coding-plan': zhipu };
const aliases: Record<string, string> = { codex: 'openai', chatgpt: 'openai', claude: 'anthropic', gemini: 'google', 'evroc-ai': 'evroc', evrocai: 'evroc', 'ollama-cloud': 'ollama', 'opencode-go': 'opencode', grok: 'xai', supergrok: 'xai', zcode: 'zai-coding-plan', 'wafer-ai': 'wafer.ai', wafer: 'wafer.ai' };

/** Native equivalent of useProviderLogo's local-only resolver; same artwork, aliases and Magpie fallback. */
function source(providerID: string) {
  const fallback = providerID.toLowerCase().includes('magpie') ? ['magpie'] : [];
  const match = providerID.match(/^magpie:[^:]+:(.+)$/i);
  let brand = providerID;
  if (match) { try { brand = decodeURIComponent(match[1]); } catch { return fallback.length ? assets.magpie : undefined; } }
  const normalized = brand.toLowerCase().trim().replace(/^models\./, '').replace(/^provider\./, '').replace(/\s+/g, '-');
  const compact = normalized.replace(/[^a-z0-9_\-./:]/g, ''), primary = compact.split(/[/:]/)[0] || compact;
  const candidates = [aliases[compact], aliases[primary], compact, primary];
  for (const keyword of normalized.split(/[^a-z0-9]+/)) { const candidate = aliases[keyword] || keyword; if (assets[candidate]) candidates.push(candidate); }
  return [...new Set(candidates.filter(candidate => candidate && candidate !== 'magpie')), ...fallback].map(candidate => assets[candidate]).find(Boolean);
}

export function HeaderProviderLogo(props: { providerID: string }) {
  const failed = signal(false);
  effect(() => { props.providerID; failed.set(false); });
  return <If when={!failed() && source(props.providerID)} else={<Icon name="stack" size={16} />}><Image src={source(props.providerID)!} accessible={false} style={{ width: 16, height: 16, objectFit: 'contain', tintColor: source(props.providerID) === wafer ? undefined : token('foreground') }} onError={() => failed.set(true)} /></If>;
}
