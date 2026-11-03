import wechatLogo from '@/assets/brand/channels/wechat.svg';
import wecomLogo from '@/assets/brand/channels/wecom.svg';
import feishuLogo from '@/assets/brand/channels/feishu.svg';
import dingtalkLogo from '@/assets/brand/channels/dingtalk.svg';
import type { I18nKey } from '@/lib/i18n';
import type { AssistantChannelProvider } from '@/queries/assistantChannelQueries';

export type AssistantChannelID = 'wechat' | AssistantChannelProvider;

export type AssistantChannelEntry = {
  id: AssistantChannelID;
  nameKey: I18nKey;
  summaryKey: I18nKey;
  logo: string;
};

/**
 * Brand marks live in `assets/brand/channels` with their upstream source and
 * license. Only these assets may carry brand color; the surrounding tiles use
 * semantic theme tokens.
 */
export const assistantChannelEntries: readonly AssistantChannelEntry[] = [
  { id: 'wechat', nameKey: 'assistants.weixin.title', summaryKey: 'assistants.channels.wechat.summary', logo: wechatLogo },
  { id: 'wecom', nameKey: 'assistants.channels.wecom.title', summaryKey: 'assistants.channels.wecom.summary', logo: wecomLogo },
  { id: 'feishu', nameKey: 'assistants.channels.feishu.title', summaryKey: 'assistants.channels.feishu.summary', logo: feishuLogo },
  { id: 'dingtalk', nameKey: 'assistants.channels.dingtalk.title', summaryKey: 'assistants.channels.dingtalk.summary', logo: dingtalkLogo },
];
