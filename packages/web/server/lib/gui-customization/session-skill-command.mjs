export const sessionSkillCommand = (executable, script, encoded, operation) => {
  const args = [executable, script, encoded, operation];
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  if (process.platform !== 'win32') return `ELECTRON_RUN_AS_NODE=1 ${args.map(quote).join(' ')}`;
  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const ps = `$env:ELECTRON_RUN_AS_NODE='1'; & ${args.map(psQuote).join(' ')}`;
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
};
