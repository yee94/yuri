import { computed, Image, token, View } from 'nsh';
import { getModelBrandLogoCandidates, resolveModelBrand } from '../ui/src/lib/modelBrand';
import gpt from '../ui/src/assets/model-icons/gpt.svg';
import claude from '../ui/src/assets/model-icons/claude.svg';
import gemini from '../ui/src/assets/model-icons/gemini.svg';
import gemma from '../ui/src/assets/model-icons/gemma.svg';
import grok from '../ui/src/assets/model-icons/grok.png';
import qwen from '../ui/src/assets/model-icons/qwen.svg';
import kimi from '../ui/src/assets/model-icons/kimi.svg';
import glm from '../ui/src/assets/model-icons/glm.svg';
import deepseek from '../ui/src/assets/model-icons/deepseek.svg';
import minimax from '../ui/src/assets/model-icons/minimax.svg';
import hunyuan from '../ui/src/assets/model-icons/hunyuan.svg';
import hy from '../ui/src/assets/model-icons/hy.svg';
import doubao from '../ui/src/assets/model-icons/doubao.svg';
import seed from '../ui/src/assets/model-icons/seed.svg';
import mimo from '../ui/src/assets/model-icons/mimo.svg';
import longcat from '../ui/src/assets/model-icons/longcat.svg';
import composer from '../ui/src/assets/model-icons/composer.svg';
import cursor from '../ui/src/assets/model-icons/cursor.svg';
import { Icon } from './Icon';
import { nativeAgentPaletteTokens } from './appearance';
import { nativeAgentAvatarDataUri, nativeAgentPalette } from './chat-identity-core';

const logos: Record<string, typeof gpt> = { gpt, openai: gpt, claude, anthropic: claude, gemini, google: gemini, gemma, grok, qwen, kimi, glm, deepseek, minimax, hunyuan, hy, doubao, seed, mimo, longcat, composer, cursor };

/** Same pure brand matching and original artwork as ModelLogo, without React/glob. */
export function NativeModelLogo(props: { modelID?: string | null; providerID?: string | null; size?: number }) {
  const source = computed(() => getModelBrandLogoCandidates(resolveModelBrand(props.modelID, props.providerID)).map(candidate => logos[candidate]).find(Boolean));
  return <If when={source()} else={<Icon name="brain-ai-3" size={props.size ?? 16} />}><Image src={source()!} accessible={false} style={{ width: props.size ?? 16, height: props.size ?? 16, objectFit: 'contain', tintColor: token('foreground') }} /></If>;
}

export function nativeAgentAccent(name?: string) {
  return nativeAgentPalette(name, nativeAgentPaletteTokens()).background;
}

/** Web DiceBear artwork for known Agents and child-session identities; not the Assistant contact avatar. */
export function NativeAgentAvatar(props: { name?: string; size?: number }) {
  const source = computed(() => nativeAgentAvatarDataUri(props.name, nativeAgentPaletteTokens()));
  // Every seed keeps its own generated face rather than falling back to a different Agent.
  return <View style={{ width: props.size ?? 16, height: props.size ?? 16 }}><If when={source()}><Image src={source()!} accessible={false} style={{ width: props.size ?? 16, height: props.size ?? 16, objectFit: 'contain', borderRadius: 2 }} /></If></View>;
}
