import { computed, Image, signal, token, View } from 'nsh';
import { getProviderLogoCandidates } from '../ui/src/lib/providerBrand';
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
import minimax from '../ui/src/assets/provider-logos/minimax-coding-plan.svg';
import minimaxCN from '../ui/src/assets/provider-logos/minimax-cn-coding-plan.svg';
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
import { Icon } from './Icon';

const artwork: Record<string, typeof openai> = { anthropic, 'bailian-coding-plan': bailian, cursor, deepseek, evroc, 'github-copilot': copilot, gocode, google, 'kimi-for-coding': kimi, lmstudio, magpie, meta, 'minimax-coding-plan': minimax, 'minimax-cn-coding-plan': minimaxCN, 'nano-gpt': nano, ollama, openai, opencode, openrouter, 'wafer.ai': wafer, workbuddy, xai, 'zai-coding-plan': zai, 'zhipuai-coding-plan': zhipu };
const available = new Set(Object.keys(artwork));

export function NativeProviderLogo(props: { providerID: string; size?: number }) {
  const source = computed(() => getProviderLogoCandidates(props.providerID, available).map(id => artwork[id]).find(Boolean));
  const failed = signal<typeof openai | null>(null);
  return <View testID={`provider-logo-${props.providerID}`} style={{ width: props.size ?? 14, height: props.size ?? 14 }}><If when={source() && failed() !== source()} else={<Icon name="stack" size={props.size ?? 14} />}><Image src={source()!} accessible={false} onError={() => failed.set(source()!)} style={{ width: props.size ?? 14, height: props.size ?? 14, objectFit: 'contain', tintColor: token('foreground') }} /></If></View>;
}
