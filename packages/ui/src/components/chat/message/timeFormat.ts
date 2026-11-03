import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';

const isSameDay = (left: Date, right: Date): boolean => {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
};

const isYesterday = (date: Date, now: Date): boolean => {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return isSameDay(date, yesterday);
};

const isValidTimestamp = (timestamp: number): boolean => {
    return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime());
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const formatTurnDuration = (durationMs: number): string => {
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
    const roundedSeconds = Math.round(totalSeconds);
    const days = Math.floor(roundedSeconds / 86400);
    const hours = Math.floor((roundedSeconds % 86400) / 3600);
    const minutes = Math.floor((roundedSeconds % 3600) / 60);
    const seconds = roundedSeconds % 60;
    return [days > 0 ? `${days}d` : '', hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '', seconds > 0 ? `${seconds}s` : ''].filter(Boolean).join(' ');
};

/** Assistant footer clock: local `YYYY-MM-DD HH:mm`, independent of the 12h/24h preference. */
export const formatAbsoluteMessageTimestamp = (timestamp: number): string => {
    if (!isValidTimestamp(timestamp)) {
        return '';
    }

    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

export const formatTimestampForDisplay = (timestamp: number, timeFormatPreference: TimeFormatPreference): string => {
    if (!isValidTimestamp(timestamp)) {
        return '';
    }

    const date = new Date(timestamp);
    const now = new Date();
    const timePart = formatTimeForPreference(date, timeFormatPreference);
    const locale = getCurrentIntlLocale();
    const dictionary = useI18nStore.getState().dictionary;

    if (isSameDay(date, now)) {
        return timePart;
    }

    if (isYesterday(date, now)) {
        return formatMessage(dictionary, 'common.date.yesterdayWithTime', { time: timePart });
    }

    const monthPart = date.toLocaleString(locale, { month: 'short' });
    const dayPart = date.getDate();
    const datePart = `${monthPart} ${dayPart}`;

    if (date.getFullYear() === now.getFullYear()) {
        return `${datePart}, ${timePart}`;
    }

    return `${datePart}, ${date.getFullYear()}, ${timePart}`;
};
