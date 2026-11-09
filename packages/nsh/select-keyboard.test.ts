import { expect, test, vi } from 'vitest';
import { createSelectKeyboard, type SelectKeyboardItem } from './select-keyboard';

test('keyboard skips disabled rows, wraps, pages and chooses only an enabled item', () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({ value: `${index}`, title: `Choice ${index}`, disabled: index === 1 }));
  const focus = vi.fn(), choose = vi.fn(), items = vi.fn(() => rows);
  const keyboard = createSelectKeyboard({ items, selected: () => '0', focus, choose });
  expect(items).not.toHaveBeenCalled();
  keyboard.sync(); keyboard.move('down'); keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('2');
  keyboard.move('home'); keyboard.move('up'); keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('299');
  keyboard.move('home'); keyboard.move('pagedown'); keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('11');
  keyboard.move('end'); keyboard.move('pageup'); keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('289');
});

test('filter replacement, empty data and disabled replacement cannot select a stale row', () => {
  let rows: SelectKeyboardItem[] = [{ value: 'a', title: 'Alpha' }, { value: 'b', title: 'Beta' }];
  const choose = vi.fn(), focus = vi.fn();
  const keyboard = createSelectKeyboard({ items: () => rows, selected: () => 'b', choose, focus });
  keyboard.sync(); rows = [{ value: 'a', title: 'Alpha' }]; keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('a');
  choose.mockClear(); rows = [{ value: 'a', title: 'Alpha', disabled: true }]; keyboard.choose(); expect(choose).not.toHaveBeenCalled();
  rows = []; keyboard.move('down'); keyboard.type('a'); keyboard.choose(); expect(choose).not.toHaveBeenCalled();
});

test('typeahead supports prefixes, repeated-letter cycling and timeout without a timer', () => {
  let time = 0;
  const choose = vi.fn(), rows = [{ value: 'a', title: 'Apple' }, { value: 'b', title: 'Apricot' }, { value: 'c', title: 'Banana', disabled: true }, { value: 'd', title: 'Berry' }];
  const keyboard = createSelectKeyboard({ items: () => rows, selected: () => 'a', focus: () => {}, choose }, () => time);
  keyboard.type('a'); keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('b');
  keyboard.type('a'); keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('a');
  time = 1000; keyboard.type('b'); keyboard.type('e'); keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('d');
});

test('a ranked-query reset focuses the first enabled match once, not the retained nonmatching row', () => {
  let rows = [{ value: 'local', title: 'Local' }, { value: 'remote', title: 'origin/main' }];
  const focus = vi.fn(), choose = vi.fn();
  const keyboard = createSelectKeyboard({ items: () => rows, selected: () => 'local', focus, choose });
  keyboard.sync(); rows = [rows[1], rows[0]]; focus.mockClear();
  keyboard.sync(true); expect(focus).toHaveBeenCalledExactlyOnceWith('remote', 0);
  keyboard.choose(); expect(choose).toHaveBeenCalledExactlyOnceWith('remote');
});
