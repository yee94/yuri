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
