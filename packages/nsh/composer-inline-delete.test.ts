import { describe, expect, it } from 'vitest';
import { editNativeReferences, insertNativeReference, normalizeNativeReferenceDeletion, type ReferenceDocument, type ReferenceKind } from './composer-references';

const kinds: ReferenceKind[] = ['skill', 'file', 'directory', 'agent', 'session'];
const document = (kind: ReferenceKind, label = 'review'): ReferenceDocument => {
  const value = insertNativeReference({ text: '前 ', references: [] }, { kind, value: kind, label });
  return { ...value, text: value.text + '后' };
};
describe('native input atomic chip deletion', () => {
  for (const kind of kinds) it(`${kind}: one backspace removes all text and its sidecar, retaining the suffix`, () => {
    const original = document(kind);
    const ref = original.references[0];
    const edit = normalizeNativeReferenceDeletion(original, original.text.slice(0, ref.end - 1) + original.text.slice(ref.end));
    expect(edit).toEqual({ text: '前  后', caret: 2 });
    expect(editNativeReferences(original, edit!.text)).toEqual({ text: '前  后', references: [] });
    expect(original.references).toHaveLength(1);
  });
  it('also expands a partial selection and a grapheme deletion inside labels with spaces or emoji', () => {
    const original = document('session', '上一个 会话 🧑‍💻');
    const ref = original.references[0];
    expect(normalizeNativeReferenceDeletion(original, original.text.slice(0, ref.end - '🧑‍💻'.length) + original.text.slice(ref.end)))
      .toEqual({ text: '前  后', caret: 2 });
    expect(normalizeNativeReferenceDeletion(original, original.text.slice(0, ref.start + 2) + original.text.slice(ref.start + 4)))
      .toEqual({ text: '前  后', caret: 2 });
  });
  it('deletes only the affected chip and rebases a surviving chip without changing its identity', () => {
    const first = insertNativeReference({ text: '前 ', references: [] }, { kind: 'skill', value: 'first', label: 'review' });
    const both = insertNativeReference(first, { kind: 'file', value: '/work/file.txt', label: 'file.txt' });
    const edit = normalizeNativeReferenceDeletion(both, both.text.slice(0, first.references[0].end - 1) + both.text.slice(first.references[0].end))!;
    const next = editNativeReferences(both, edit.text);
    expect(next.references).toEqual([{ ...both.references[1], start: 3, end: 12 }]);
    expect(edit.caret).toBe(2);
  });
  it('leaves ordinary characters, trailing whitespace, insertion, replacement and already whole deletions to the Input', () => {
    const value = document('skill');
    expect(normalizeNativeReferenceDeletion(value, value.text.slice(0, -1))).toBeNull();
    expect(normalizeNativeReferenceDeletion(value, '前 @review后')).toBeNull();
    expect(normalizeNativeReferenceDeletion(value, '前 @reviewx 后')).toBeNull();
    expect(normalizeNativeReferenceDeletion(value, '前 @rex 后')).toBeNull();
    expect(normalizeNativeReferenceDeletion(value, '前  后')).toBeNull();
    expect(normalizeNativeReferenceDeletion({ text: '前 @review 后', references: [] }, '前 @revie 后')).toBeNull();
  });
  it('does no reference enumeration for 50 ordinary insertions', () => {
    const value = document('skill');
    let reads = 0;
    const refs = new Proxy(value.references, { get(target, key, receiver) { if (key === Symbol.iterator) reads++; return Reflect.get(target, key, receiver); } });
    for (let index = 0; index < 50; index++) expect(normalizeNativeReferenceDeletion({ text: value.text, references: refs }, value.text + String(index))).toBeNull();
    expect(reads).toBe(0);
  });
});
