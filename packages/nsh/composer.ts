import { nativeMagicDefaults } from './settings-magic-defaults';
import { parseMagicOverrides } from './settings-magic-state';
import { slashCommand, type Attachment, type CompiledSubmission } from './model';
import { contactDescriptor } from './attachments';
import { compileNativeReferences, hydrateNativeReferenceSessions, sameReferenceScope, type NativeSessionReferenceContext, type ReferenceScope, type ScopedReferenceDocument } from './composer-references';

export const magicCommands = [
  { name: 'explore', prompt: 'session.explore' },
  { name: 'summary', prompt: 'session.summary' },
  { name: 'workspace-review', prompt: 'session.review' },
  { name: 'craft-goal', prompt: 'session.craftGoal' },
  { name: 'catch-up', prompt: 'session.catchup' },
  { name: 'debug', prompt: 'session.debug' },
  { name: 'weigh', prompt: 'session.weigh' },
] as const;

export function magicCommand(value: string) {
  const invocation = slashCommand(value.replace(/^([\s]*)\/\u2003/, '$1/'));
  if (!invocation) return undefined;
  const definition = magicCommands.find(item => item.name === invocation.name.toLowerCase());
  return definition ? { ...definition, argument: invocation.text.trim() } : undefined;
}

export function renderNativeTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : '');
}

/** Runs only on submission, never on the text-echo path. No global override cache across Hosts. */
export async function compileNativePrompt(
  input: { text: string; files: Attachment[]; references?: ScopedReferenceDocument; scope?: ReferenceScope; isCurrentScope?: () => boolean },
  send: (path: string) => Promise<unknown>,
): Promise<CompiledSubmission> {
  const scope = input.scope && { ...input.scope };
  const references = input.references && { ...input.references, scope: { ...input.references.scope }, references: input.references.references.map(reference => ({ ...reference, ...(reference.scope ? { scope: { ...reference.scope } } : {}) })) };
  let contexts: NativeSessionReferenceContext[] | undefined;
  const finish = (compiledText?: string): CompiledSubmission => {
    if (input.isCurrentScope && !input.isCurrentScope()) throw new Error('native-reference-scope-changed');
    if (references && (!scope || references.text !== input.text || !sameReferenceScope(references.scope, scope))) throw new Error('native-reference-snapshot-mismatch');
    if (!references?.references.length) return { text: compiledText ?? input.text, files: input.files };
    if (!scope) throw new Error('native-reference-snapshot-mismatch');
    const compiled = compileNativeReferences(references, scope, compiledText, contexts);
    const files = [...input.files, ...(compiled.files ?? [])];
    const key = (file: NonNullable<CompiledSubmission['files']>[number]) => file.kind === 'contact' ? JSON.stringify([file.hostID, file.assistantID, contactDescriptor(file)]) : file.uri;
    return { ...compiled, files: files.filter((file, index) => files.findIndex(other => key(other) === key(file)) === index) };
  };
  // Validate before any network read; a cross-Host draft must never reach admission.
  if (references) finish();
  if (references && scope) contexts = await hydrateNativeReferenceSessions(references, scope, send, input.isCurrentScope);
  const command = magicCommand(input.text);
  if (!command) return finish();
  if (input.isCurrentScope && !input.isCurrentScope()) throw new Error('native-reference-scope-changed');
  // Unlike silently substituting defaults after a network error, a failed read
  // leaves the original draft intact so a saved custom prompt cannot be lost.
  const overrides = parseMagicOverrides(await send('/api/magic-prompts'));
  const template = (suffix: string) => {
    const id = `${command.prompt}.${suffix}`;
    return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : nativeMagicDefaults[id];
  };
  const variables: Record<string, string> = command.name === 'summary' ? {
    topic_line: command.argument ? ` focused on: ${command.argument}` : '',
    topic_block: command.argument ? `The user asked you to focus this summary on: ${command.argument}. Prioritize that topic; mention unrelated threads only in passing.` : '',
  } : command.name === 'craft-goal' ? {
    idea_block: command.argument ? `\n\nHere is my initial idea:\n${command.argument}` : '',
  } : {};
  const visible = renderNativeTemplate(template('visible'), variables);
  const instructions = renderNativeTemplate(template('instructions'), variables);
  // OpenCode 2 admission flattens Web's visible + synthetic text parts to this
  // exact string (ui/src/lib/opencode/client.ts), not a fictional metadata field.
  return finish([visible, instructions].filter(part => part.trim()).join('\n'));
}
