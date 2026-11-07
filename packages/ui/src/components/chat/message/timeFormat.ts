import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { formatMessageTimestampForLocale } from '../../../lib/time-format-core';

const isValidTimestamp = (timestamp: number): boolean => {
    return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime());
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

export { formatTurnDuration } from './turnDurationFormat';

/** Assistant footer clock: local `YYYY-MM-DD HH:mm`, independent of the 12h/24h preference. */
export const formatAbsoluteMessageTimestamp = (timestamp: number): string => {
    if (!isValidTimestamp(timestamp)) {
        return '';
    }

    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

export const formatTimestampForDisplay = (timestamp: number, timeFormatPreference: TimeFormatPreference): string => {
    const locale = getCurrentIntlLocale();
    const dictionary = useI18nStore.getState().dictionary;
    return formatMessageTimestampForLocale(timestamp, timeFormatPreference, locale, time => formatMessage(dictionary, 'common.date.yesterdayWithTime', { time }));
};
