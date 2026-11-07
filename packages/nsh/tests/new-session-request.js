/** QuickJS Host fixture parser: deliberately no browser URL/URLSearchParams dependency. */
export function fixtureRequest(input) {
  const resource = input.path;
  if (typeof resource !== 'string' || !resource.startsWith('/') || resource.startsWith('//') || /[\s\\#\u0000-\u001f\u007f]/.test(resource)) throw new Error('Invalid new-session fixture resource');
  const split = resource.indexOf('?'), path = split < 0 ? resource : resource.slice(0, split), query = split < 0 ? '' : resource.slice(split + 1);
  const params = new Map(), method = input.method === undefined ? 'GET' : input.method;
  const decode = value => decodeURIComponent(value.replace(/\+/g, ' '));
  for (const field of query ? query.split('&') : []) {
    const equal = field.indexOf('=');
    if (equal < 1) throw new Error('Invalid new-session fixture query');
    const key = decode(field.slice(0, equal)), value = decode(field.slice(equal + 1));
    if (params.has(key)) throw new Error('Duplicate new-session fixture query: ' + key);
    params.set(key, value);
  }
  function expect(expectedMethod, allowed = [], required = []) {
    if (method !== expectedMethod || [...params.keys()].some(key => !allowed.includes(key)) || required.some(key => !params.get(key))) throw new Error('Unexpected new-session fixture method/query: ' + method + ' ' + resource);
    for (const key of ['directory', 'location[directory]', 'projectDirectory']) if (params.has(key) && !params.get(key).trim()) throw new Error('Invalid new-session fixture directory');
    if (params.has('limit') && !/^[1-9][0-9]{0,2}$/.test(params.get('limit'))) throw new Error('Invalid new-session fixture limit');
    if (params.has('order') && params.get('order') !== 'desc') throw new Error('Unexpected new-session fixture order');
    if (params.has('type') && !['file', 'directory'].includes(params.get('type'))) throw new Error('Unexpected new-session fixture file type');
    if (params.has('archived') && params.get('archived') !== 'false') throw new Error('Unexpected new-session fixture archived filter');
  }
  return { path, method, params, expect };
}
