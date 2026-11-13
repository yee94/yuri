import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMessageTimeFocused } from './messageTimeFocus';

/** Icon-only message-footer actions — ~14px glyphs in 24px hit; medium stroke. */
export const MESSAGE_ACTION_ICON_BUTTON_CLASS =
    'size-6! p-0 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50';
export const MESSAGE_ACTION_ICON_CLASS = 'size-3.5!';
export const MESSAGE_ACTION_ICON_WEIGHT = 'medium' as const;
export const MESSAGE_ACTION_GROUP_CLASS = 'flex items-center gap-2';
const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
/**
 * 底栏整行：操作组 | 耗时组 — 组内 gap-2，组间 gap-3，颜色同一档.
 * 操作组首项是 size-6 图标按钮，14px 字形居中内缩 5px，-ml 抵消后与正文左对齐（桌面/移动同一套）.
 */
const MESSAGE_FOOTER_ACTION_GROUP_CLASS = `${MESSAGE_ACTION_GROUP_CLASS} -ml-[5px]`;
const MESSAGE_FOOTER_ROW_CLASS = 'mt-2.5 mb-3 flex flex-wrap items-center gap-3';
const MESSAGE_FOOTER_ROW_MOBILE_CLASS = 'mt-1.5 mb-2 flex flex-wrap items-center gap-3';
const MESSAGE_FOOTER_META_GROUP_CLASS = 'flex w-max max-w-full flex-none flex-wrap items-center gap-2 text-muted-foreground';
/** Duration / timestamp — 与操作图标同色；字略小，行高贴齐图标高度保持垂直对齐. */
const MESSAGE_FOOTER_META_TEXT_CLASS = 'h-3.5 items-center gap-1 text-[11px] leading-none tabular-nums text-muted-foreground';
export const MESSAGE_FOOTER_META_CLASS = `inline-flex ${MESSAGE_FOOTER_META_TEXT_CLASS}`;
export const MESSAGE_FOOTER_META_ICON_CLASS = 'size-3.5!';

/** Desktop hover; mobile only after the message row is tapped. */
const AssistantAbsoluteTime = ({ messageId, label, focusReveal }: { messageId: string; label: string; focusReveal: boolean }) => {
    const focused = useMessageTimeFocused(messageId, focusReveal);
    return <span
        className={cn(MESSAGE_FOOTER_META_TEXT_CLASS, 'whitespace-nowrap', focusReveal
            ? (focused ? 'inline-flex' : 'hidden') : 'hidden yuri-message-hover-time')}
        data-message-time=""
        data-message-time-visible={focusReveal ? (focused ? 'true' : 'false') : undefined}
    >{label}</span>;
};

const AssistantTpsMeta = ({ label }: { label: string }) => {
    const { t } = useI18n();
    return <Tooltip>
        <TooltipTrigger asChild>
            <span className={MESSAGE_FOOTER_META_CLASS} aria-label={t('chat.messageBody.meta.tpsAria', { rate: label })}>
                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="pulse" className={MESSAGE_FOOTER_META_ICON_CLASS} />
                <span className="message-footer__label">{label}</span>
            </span>
        </TooltipTrigger>
        <TooltipContent>{t('chat.messageBody.meta.tpsTooltip')}</TooltipContent>
    </Tooltip>;
};

export const AssistantMessageFooter = React.memo(function AssistantMessageFooter({
    messageId, isMobile, actions, tps, duration, timestamp, activity, trailing, animateReveal = false,
}: {
    messageId: string;
    isMobile: boolean;
    actions?: React.ReactNode;
    tps?: string | null;
    duration?: string | null;
    timestamp?: string | null;
    activity?: React.ReactNode;
    trailing?: React.ReactNode;
    animateReveal?: boolean;
}) {
    const reducedMotion = useReducedMotion();
    // Every completion state shares the same footprint, including textless/interrupted replies.
    return <motion.div className={isMobile ? MESSAGE_FOOTER_ROW_MOBILE_CLASS : MESSAGE_FOOTER_ROW_CLASS}
        initial={animateReveal && !reducedMotion ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.2, ease: 'easeOut' }}
        data-message-footer="true" style={MESSAGE_FOOTER_CONTAINER_STYLE}>
        {actions ? <div className={MESSAGE_FOOTER_ACTION_GROUP_CLASS} data-message-action-group="true">{actions}</div> : null}
        {(tps || duration || timestamp || activity) ? <div className={MESSAGE_FOOTER_META_GROUP_CLASS}>
            {(tps || duration) ? <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                {tps ? <AssistantTpsMeta label={tps} /> : null}
                {duration ? <Tooltip>
                    <TooltipTrigger asChild>
                        <span className={MESSAGE_FOOTER_META_CLASS}>
                            <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="hourglass" className={MESSAGE_FOOTER_META_ICON_CLASS} />
                            <span className="message-footer__label">{duration}</span>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>{duration}</TooltipContent>
                </Tooltip> : null}
            </div> : null}
            {activity}
            {timestamp ? <AssistantAbsoluteTime messageId={messageId} label={timestamp} focusReveal={isMobile} /> : null}
        </div> : null}
        {trailing}
    </motion.div>;
});
