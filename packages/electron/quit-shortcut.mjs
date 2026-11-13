export const QUIT_SHORTCUT_INTERVAL_MS = 2000;

export const createQuitShortcut = ({ quit, showHint, hideHint, now = () => performance.now() }) => {
  let pending = null;
  let timer = null;
  let quitting = false;

  const cancel = (owner) => {
    if (owner !== undefined && pending?.owner !== owner) return;
    clearTimeout(timer);
    timer = null;
    const previous = pending;
    pending = null;
    if (previous) hideHint(previous.owner);
  };

  const request = (owner) => {
    if (quitting) return;
    const timestamp = now();
    if (pending && pending.owner === owner && timestamp < pending.deadline) {
      cancel();
      quitting = true;
      quit();
      return;
    }
    cancel();
    pending = { owner, deadline: timestamp + QUIT_SHORTCUT_INTERVAL_MS };
    timer = setTimeout(() => cancel(), QUIT_SHORTCUT_INTERVAL_MS);
    showHint(owner);
  };

  const handleInput = (event, input, owner) => {
    const isQuitKey = input.code === 'KeyQ' || input.key?.toLowerCase() === 'q';
    if (isQuitKey && input.meta && !input.alt && !input.control && !input.shift && !input.isComposing) {
      event.preventDefault();
      if (input.type === 'keyDown' && !input.isAutoRepeat) request(owner);
      return;
    }
    if (input.type === 'keyDown' && input.key !== 'Meta') cancel();
  };

  return { request, handleInput, cancel };
};
