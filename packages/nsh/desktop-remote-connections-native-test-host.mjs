// Synthetic metadata-only Host. Shared by contract tests and the real NSH UI
// fixture; never imported by production and never touches SSH, Vault or disk.
export const nativeSshCapabilities = Object.freeze({ version: 1, connections: { supported: true, phase: 'ready', maxPending: 16 }, sync: { supported: false } });
export const nativeSshInstance = Object.freeze({ id: 'fixture', label: 'Fixture SSH', host: 'ssh.example.invalid', user: 'fixture', port: 22, remotePort: 3210, localPort: 0, managed: true });
export const nativeSshError = message => Object.assign(new Error(message), { code: 'ERR_NSH_HOST_ERROR' });
export class StrictNativeSshHost {
  calls = [];
  capability = nativeSshCapabilities;
  capabilityError;
  capabilityGate;
  operationGate;
  operationError;
  result;
  connected = true;
  loseNextSave = false;
  failNextRead = false;
  withheld;
  value = { revision: 1, saving: false, instances: [nativeSshInstance], statuses: [], receipts: [] };
  attempts = 0;
  available() { return this.connected; }
  exact(input, keys) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) throw nativeSshError('ssh_invalid');
  }
  identifier(input) { if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input)) throw nativeSshError('ssh_invalid'); }
  number(input, min) { if (!Number.isSafeInteger(input) || input < min || input > 9_007_199_254_740_000) throw nativeSshError('ssh_invalid'); }
  async call(name, input, options) {
    const fields = {
      'desktop.ssh.capabilities': [], 'desktop.ssh.read': [],
      'desktop.ssh.save': ['requestID', 'revision', 'instance'], 'desktop.ssh.remove': ['requestID', 'revision', 'id'],
      'desktop.ssh.start': ['requestID', 'id', 'intent'], 'desktop.ssh.cancel': ['id', 'attempt'],
    };
    if (!Object.hasOwn(fields, name)) throw new Error('unregistered_native_method');
    this.exact(input, fields[name]); this.exact(options, ['timeout']);
    if (options.timeout !== (name === 'desktop.ssh.capabilities' ? 5000 : 30000)) throw new Error('wrong_timeout');
    this.calls.push({ name, input: JSON.parse(JSON.stringify(input)) });
    if (name === 'desktop.ssh.capabilities') {
      await this.capabilityGate;
      if (this.capabilityError) throw this.capabilityError;
      return this.capability;
    }
    if ('requestID' in input) this.identifier(input.requestID);
    if ('id' in input) this.identifier(input.id);
    if ('revision' in input) { this.number(input.revision, 0); if (input.revision !== this.value.revision) throw nativeSshError('ssh_stale'); }
    if ('attempt' in input) this.number(input.attempt, 1);
    if (name === 'desktop.ssh.save') {
      this.exact(input.instance, ['id', 'label', 'host', 'user', 'port', 'remotePort', 'localPort', 'managed']);
      this.identifier(input.instance.id);
      for (const [field, max] of [['label', 240], ['host', 253], ['user', 64]]) {
        const value = input.instance[field];
        const bytes = typeof value === 'string' ? [...value].reduce((count, character) => { const code = character.codePointAt(0); return count + (code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4); }, 0) : 0;
        if (typeof value !== 'string' || !value || bytes > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw nativeSshError('ssh_invalid');
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(input.instance.host) || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(input.instance.user) || typeof input.instance.managed !== 'boolean') throw nativeSshError('ssh_invalid');
      for (const field of ['port', 'remotePort', 'localPort']) { this.number(input.instance[field], field === 'localPort' ? 0 : 1); if (input.instance[field] > 65535) throw nativeSshError('ssh_invalid'); }
    }
    if (name === 'desktop.ssh.start' && !['connect', 'check', 'restore'].includes(input.intent)) throw nativeSshError('ssh_invalid');
    await this.operationGate;
    if (this.operationError) throw this.operationError;
    if (this.result !== undefined) return this.result;
    if (name === 'desktop.ssh.read') {
      if (this.failNextRead) { this.failNextRead = false; throw nativeSshError('ssh_storage'); }
      return this.value;
    }
    if (name === 'desktop.ssh.save') {
      const next = { ...this.value, revision: this.value.revision + 1, receipts: [...this.value.receipts, input.requestID], instances: this.value.instances.some(row => row.id === input.instance.id) ? this.value.instances.map(row => row.id === input.instance.id ? input.instance : row) : [...this.value.instances, input.instance] };
      if (this.loseNextSave) { this.loseNextSave = false; this.withheld = next; throw new Error('lost_ack'); }
      this.value = next;
    }
    if (name === 'desktop.ssh.remove') this.value = { ...this.value, revision: this.value.revision + 1, receipts: [...this.value.receipts, input.requestID], instances: this.value.instances.filter(row => row.id !== input.id), statuses: this.value.statuses.filter(row => row.id !== input.id) };
    if (name === 'desktop.ssh.start') {
      if (!this.value.instances.some(row => row.id === input.id)) throw nativeSshError('ssh_stale');
      const phase = input.intent === 'check' ? 'checked' : 'ready';
      this.value = { ...this.value, receipts: [...this.value.receipts, input.requestID], statuses: [...this.value.statuses.filter(row => row.id !== input.id), { id: input.id, attempt: ++this.attempts, requestID: input.requestID, phase, error: null, retry: 0, running: false, connectionID: phase === 'ready' ? 'fixture-connection' : null }] };
    }
    if (name === 'desktop.ssh.cancel') {
      if (!this.value.statuses.some(row => row.id === input.id && row.attempt === input.attempt)) throw nativeSshError('ssh_stale');
      this.value = { ...this.value, statuses: this.value.statuses.map(row => row.id === input.id ? { ...row, phase: 'idle', connectionID: null } : row) };
    }
    return this.value;
  }
}
