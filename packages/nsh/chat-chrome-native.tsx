import { nativeComponent } from 'nsh';

export const NativeChatHeaderCollapse = nativeComponent<{ progress: number; duration: number; active: boolean }, Record<string, never>>(
  'yuri.chat.headerCollapse', { props: ['progress', 'duration', 'active'] },
);
