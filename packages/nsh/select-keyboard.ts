export type SelectKeyboardItem = { value: string; title: string; disabled?: boolean };

/** Shared keyboard intent; no bindings or catalog work while a picker is closed. */
export function createSelectKeyboard(options: {
  items: () => readonly SelectKeyboardItem[];
  selected: () => string | null | undefined;
  focus: (value: string | null, index: number) => void;
  choose: (value: string) => void;
}, now = Date.now) {
  let source: readonly SelectKeyboardItem[] | undefined, highlighted: string | null = null, prefix = '', typedAt = 0;
  function focus(rows: readonly SelectKeyboardItem[], index: number) {
    highlighted = rows[index]?.value ?? null;
    options.focus(highlighted, index);
  }
  function sync() {
    const rows = options.items();
    if (rows !== source) {
      source = rows;
      const retained = rows.findIndex(row => row.value === highlighted && !row.disabled);
      const selected = rows.findIndex(row => row.value === options.selected() && !row.disabled);
      focus(rows, retained >= 0 ? retained : selected >= 0 ? selected : rows.findIndex(row => !row.disabled));
    }
    return rows;
  }
  return {
    sync,
    move(key: 'up' | 'down' | 'home' | 'end' | 'pageup' | 'pagedown') {
      const rows = sync(), enabled = rows.map((row, index) => row.disabled ? -1 : index).filter(index => index >= 0);
      if (!enabled.length) return;
      const current = enabled.findIndex(index => rows[index]!.value === highlighted);
      const next = key === 'home' ? 0 : key === 'end' ? enabled.length - 1
        : key === 'pageup' ? Math.max(0, current - 10) : key === 'pagedown' ? Math.min(enabled.length - 1, current + 10)
        : (current + (key === 'up' ? -1 : 1) + enabled.length) % enabled.length;
      prefix = ''; focus(rows, enabled[next]!);
    },
    type(character: string) {
      const rows = sync(), time = now(), letter = character.toLocaleLowerCase();
      prefix = time - typedAt > 700 ? letter : prefix + letter; typedAt = time;
      const query = [...prefix].every(value => value === letter) ? letter : prefix;
      const current = rows.findIndex(row => row.value === highlighted);
      for (let offset = query.length === 1 ? 1 : 0; offset <= rows.length; offset++) {
        const index = (Math.max(current, 0) + offset) % rows.length, row = rows[index];
        if (row && !row.disabled && row.title.toLocaleLowerCase().startsWith(query)) { focus(rows, index); return; }
      }
    },
    choose() {
      const row = sync().find(row => row.value === highlighted);
      if (row && !row.disabled) options.choose(row.value);
    },
  };
}
