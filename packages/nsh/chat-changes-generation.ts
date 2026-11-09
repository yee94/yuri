import { changeGroups, type ChangesReader } from './chat-changes-model';
import { nativeMagicDefaults } from './settings-magic-defaults';
import { parseMagicOverrides } from './settings-magic-state';

type Call = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export type ChangesGenerationContext = { sessionID?: string; preferredProviderID?: string; preferredModelID?: string };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const aside = 'This is an auxiliary structured generation request (git copy). Use the active session context plus the materials below. Answer with the required JSON only. Do not call any tools and do not take any actions. Model and instructions follow the session.generate session contract.';

/** Sheet-owned input survives reader replacement without retaining request authority. */
export function createChangesDraft() {
  let state = { message: '', highlights: [] as string[] }, revision = 0;
  return {
    state: () => state,
    revision: () => revision,
    replace(message: string, highlights: string[]) { revision++; state = { message, highlights }; },
  };
}

/** Event-only native adapter for gitApi.generateCommitMessage. No chat sends or session creation. */
export function createChangesGeneration(reader: ChangesReader, call: Call, current = reader.current, notify: () => void = () => {}, context: () => ChangesGenerationContext = () => ({}), draft = createChangesDraft()) {
  let state = { pending: false, error: '' }, serial = 0, alive = true;
  const update = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; notify(); };
  const paths = () => changeGroups(reader.state().snapshot).find(group => group.staged)?.files.map(file => file.path).sort() ?? [];
  const ready = () => alive && current() && reader.source.kind === 'workspace' && !!reader.source.directory.trim() && !reader.state().loading && !reader.state().error && !state.pending && paths().length > 0;
  return {
    state: () => ({ ...draft.state(), ...state }),
    edit(message: string) { if (!alive) return; draft.replace(message, draft.state().highlights); notify(); },
    clear() { if (!alive) return; draft.replace('', []); notify(); },
    insertHighlights() {
      if (!alive || !current() || state.pending) return;
      const value = draft.state(), highlights = value.highlights.map(text => text.trim()).filter(Boolean);
      draft.replace([value.message.trim(), highlights.join('\n')].filter(Boolean).join('\n\n'), []); notify();
    },
    async generate() {
      if (!ready()) return false;
      const attempt = ++serial, edits = draft.revision(), selected = paths(), selection = JSON.stringify(selected), captured = { ...context() }, directory = reader.source.directory;
      let selectionSnapshot = reader.state().snapshot;
      const valid = () => alive && current() && attempt === serial;
      const assertCurrent = () => {
        const next = context();
        if (!valid() || reader.source.directory !== directory || next.sessionID !== captured.sessionID || next.preferredProviderID !== captured.preferredProviderID || next.preferredModelID !== captured.preferredModelID) throw new Error('gitView.toast.generateCommitMessageFailed');
        // Await boundaries are frequent; only a new status authority can change staged membership.
        if (reader.state().snapshot !== selectionSnapshot) {
          if (JSON.stringify(paths()) !== selection) throw new Error('gitView.toast.generateCommitMessageFailed');
          selectionSnapshot = reader.state().snapshot;
        }
      };
      update({ pending: true, error: '' });
      try {
        const overrides = parseMagicOverrides(await call('/api/magic-prompts')); assertCurrent();
        const template = (id: string) => Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : nativeMagicDefaults[id];
        const system = template('git.commit.generate.visible');
        const instructions = template('git.commit.generate.instructions').replace(/\{\{\s*selected_files\s*\}\}/g, selected.map(path => `- ${path}`).join('\n'));
        let text = '', included = 0, truncated = false;
        // Same 30-file / 120k material budget as Web; sequential pairs bound native HTTP fanout to two.
        for (const path of selected.slice(0, 30)) {
          assertCurrent();
          const chunks = await Promise.all([true, false].map(async staged => {
            try {
              const value = object(await call(`/api/git/diff?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}&staged=${staged}`));
              return typeof value.diff === 'string' ? value.diff : '';
            } catch { return ''; }
          }));
          assertCurrent();
          const chunk = chunks.filter(value => value.trim()).join('\n') || `--- ${path} (no textual diff available)`;
          const separator = text ? '\n\n' : '';
          if (text.length + separator.length + chunk.length > 120_000) { text += '\n[remaining diffs truncated by char budget — not a full selected-set dump]'; truncated = true; break; }
          text += separator + chunk; included++;
        }
        const omitted = selected.length - included;
        if (selected.length > 30) text += `\n[${selected.length - 30} more selected files omitted by file budget — not included]`;
        const budget = `Diff budget: included ${included} of ${selected.length} selected files; fileLimit=30; charLimit=120000; truncatedByCharLimit=${truncated ? 'yes' : 'no'}; omittedFiles=${omitted}.` + (omitted || truncated ? ' Materials are partial under this budget — do not invent diffs for omitted or truncated files; base the message only on provided material.' : ' Materials cover the full selected set within the budget.');
        const prompt = [instructions, budget, 'Diffs of the selected files (budget-aligned; see note above):', text].join('\n\n');
        assertCurrent();
        let result: unknown;
        try {
          result = await call('/api/small-model/generate', 'POST', { purpose: 'commit', system, prompt, directory, ...(captured.preferredProviderID ? { preferredProviderID: captured.preferredProviderID } : {}), ...(captured.preferredModelID ? { preferredModelID: captured.preferredModelID } : {}) });
        } catch (cause) {
          assertCurrent();
          if (object(cause).status !== 404 || !captured.sessionID) throw cause;
          // Official v2 session.generate carries sessionID in its path and prompt in its body.
          result = await call(`/api/session/${encodeURIComponent(captured.sessionID)}/generate?directory=${encodeURIComponent(directory)}`, 'POST', { prompt: [aside, system.trim(), prompt.trim()].filter(Boolean).join('\n\n') });
        }
        assertCurrent();
        const raw = object(result).text;
        if (typeof raw !== 'string') throw new Error('gitView.toast.generateCommitMessageFailed');
        const candidate = (raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw).trim();
        let structured: Record<string, unknown> = {};
        const start = candidate.indexOf('{');
        for (let end = candidate.length; start >= 0 && end > start; end--) {
          if (candidate[end - 1] !== '}') continue;
          try { structured = object(JSON.parse(candidate.slice(start, end))); break; } catch { /* Model prose may follow JSON. */ }
        }
        const subject = typeof structured.subject === 'string' ? structured.subject.trim() : '';
        if (!subject) throw new Error('gitView.toast.generateCommitMessageFailed');
        const highlights = Array.isArray(structured.highlights) ? structured.highlights.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean).slice(0, 3) : [];
        if (edits !== draft.revision()) return false;
        draft.replace(subject, highlights); notify(); return true;
      } catch (cause) { if (valid()) update({ error: cause instanceof Error ? cause.message : String(cause) }); return false; }
      finally { if (valid()) update({ pending: false }); }
    },
    cancel() { alive = false; serial++; update({ pending: false }); },
  };
}
