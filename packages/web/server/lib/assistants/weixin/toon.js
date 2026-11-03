// Small JSON-only TOON encoder for bounded channel metadata. No key folding or
// type coercion: external strings must never become structure or literal values.
const primitive = (value) => value === null || typeof value !== 'object';
const scalar = (value) => {
  if (typeof value !== 'string') return JSON.stringify(value);
  value = value.toWellFormed();
  if (value && value.trim() === value && !/^(?:true|false|null)$/.test(value)
    && !/^[+-]?(?:\d|\.\d)/.test(value) && !/^[-#\uFEFF]/.test(value)
    && !/[:,"\\\[\]{}\x00-\x1f]/.test(value)) return value;
  return `"${value.replace(/["\\\x00-\x1f]/g, (char) => ({ '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[char]
    || `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
};
const keyName = (key) => /^[A-Za-z_][\w.-]*$/.test(key) ? key : `"${key.toWellFormed().replace(/["\\\x00-\x1f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

export function encodeWeixinTOON(value) {
  const lines = [];
  const emit = (key, data, depth) => {
    const pad = '  '.repeat(depth);
    if (Array.isArray(data)) {
      if (!data.length) { lines.push(`${pad}${key ? `${key}: []` : '[0]:'}`); return; }
      if (data.every(primitive)) { lines.push(`${pad}${key}[${data.length}]: ${data.map(scalar).join(',')}`); return; }
      const fields = data[0] && !Array.isArray(data[0]) && !primitive(data[0]) ? Object.keys(data[0]) : [];
      if (fields.length && data.every((row) => row && !Array.isArray(row) && !primitive(row)
        && Object.keys(row).length === fields.length && fields.every((field) => Object.hasOwn(row, field) && primitive(row[field])))) {
        lines.push(`${pad}${key}[${data.length}]{${fields.map(keyName).join(',')}}:`);
        for (const row of data) lines.push(`${pad}  ${fields.map((field) => scalar(row[field])).join(',')}`);
        return;
      }
      lines.push(`${pad}${key}[${data.length}]:`);
      for (const item of data) {
        const start = lines.length;
        if (primitive(item)) lines.push(`${pad}  - ${scalar(item)}`);
        else if (Array.isArray(item)) {
          emit('', item, depth + 2);
          lines[start] = `${pad}  - ${lines[start].trimStart()}`;
        } else {
          for (const [field, child] of Object.entries(item)) emit(keyName(field), child, depth + 2);
          if (lines.length === start) lines.push(`${pad}  -`);
          else lines[start] = `${pad}  - ${lines[start].trimStart()}`;
        }
      }
    } else if (!primitive(data)) {
      lines.push(`${pad}${key}:`);
      for (const [field, child] of Object.entries(data)) emit(keyName(field), child, depth + 1);
    } else lines.push(`${pad}${key}: ${scalar(data)}`);
  };
  for (const [key, child] of Object.entries(value)) emit(keyName(key), child, 0);
  return lines.join('\n');
}
