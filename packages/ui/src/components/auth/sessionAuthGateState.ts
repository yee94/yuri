export type GateState = 'pending' | 'authenticated' | 'locked' | 'pairing-expired' | 'relay-auth-error' | 'error' | 'rate-limited';

export const resolveStatusCheckFailureState = (options: {
  shouldUseDesktopShellPasswordLogin?: boolean;
}): Exclude<GateState, 'pending' | 'authenticated' | 'rate-limited'> => {
  if (options.shouldUseDesktopShellPasswordLogin) {
    return 'locked';
  }

  return 'error';
};
