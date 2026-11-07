import { list, record, text, type Attachment, type Row } from './model';

/** Editing is a durable draft transfer + DELETE, never a fictional PATCH text. */
export function inboxDraft(item: Row): { text: string; files: Attachment[] } {
  const payload = record(item.payload);
  if (typeof payload.text !== 'string') throw new Error('Invalid queued input');
  if (list(payload.agents).length || list(payload.skills).length || Object.keys(record(payload.metadata)).length) throw new Error('此队列包含尚不支持编辑的结构化附件；可取消或立即发送');
  if (payload.files !== undefined && !Array.isArray(payload.files)) throw new Error('Invalid queued attachment list');
  const files = list(payload.files).map(file => {
    const source = record(file.source);
    const uri = text(file.uri) || (source.type === 'uri' ? text(source.uri) : '');
    if (!uri || /^data:/i.test(uri)) throw new Error('此附件缺少可恢复的文件引用，不能安全编辑队列');
    return { uri, name: text(file.name), mime: text(file.mime) || 'application/octet-stream' };
  });
  return { text: payload.text, files };
}
