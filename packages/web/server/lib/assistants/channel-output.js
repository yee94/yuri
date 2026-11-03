import { createHash } from 'node:crypto';
import { parseMarkdown } from 'chat';

const digest = (value) => createHash('sha256').update(value).digest('hex');
export const channelImageFailure = (language) => String(language).startsWith('zh')
  ? '图片未能发送，请在 Yuri 中查看原图。'
  : 'The image could not be sent. View the original in Yuri.';

/** Project only published output; code examples and ordinary links are not media. */
function outputParts(message) {
  const result = [];
  const parts = message.parts?.length ? message.parts : [{ type: 'text', text: message.text ?? '' }];
  for (const part of parts) {
    if (part.type === 'file' && part.mime?.startsWith('image/')) {
      result.push({ type: 'image', source: part });
      continue;
    }
    if (part.type !== 'text' || !part.text?.trim() || part.text.trim().startsWith('oc.settle.')) continue;
    if (!part.text.includes('![')) {
      result.push({ type: 'text', text: part.text.trim() });
      continue;
    }
    const tree = parseMarkdown(part.text);
    const definitions = new Map(tree.children.filter((node) => node.type === 'definition').map((node) => [node.identifier, node.url]));
    const spans = [];
    const walk = (node) => {
      const url = node.type === 'image' ? node.url : node.type === 'imageReference' ? definitions.get(node.identifier) : null;
      if (url) spans.push({ start: node.position.start.offset, end: node.position.end.offset, url });
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    const used = new Set(spans.map((span) => span.url));
    for (const node of tree.children) {
      if (node.type === 'definition' && used.has(node.url)) spans.push({ start: node.position.start.offset, end: node.position.end.offset });
    }
    spans.sort((a, b) => a.start - b.start);
    let offset = 0;
    for (const span of spans) {
      if (span.start < offset) continue;
      const text = part.text.slice(offset, span.start).trim();
      if (text) result.push({ type: 'text', text });
      if (span.url) result.push({ type: 'image', source: { url: span.url } });
      offset = span.end;
    }
    const text = part.text.slice(offset).trim();
    if (text) result.push({ type: 'text', text });
  }
  return result;
}

/** Snapshot images into the existing attachment store before advancing the feed. */
export async function prepareChannelOutput(message, { service, assistantID, generation, language, failureText, signal, assertCurrent }) {
  const deliveries = [];
  const parts = message.status === 'error' ? [{ type: 'text', text: failureText }] : outputParts(message);
  let images = 0;
  let imageBytes = 0;
  for (const part of parts) {
    signal?.throwIfAborted();
    assertCurrent();
    if (part.type === 'image') {
      images += 1;
      try {
        if (images > 8) throw new Error('image_limit');
        const image = await service.prepareChannelImage(assistantID, part.source, {
          generation, signal, uploadID: `channel-${digest(`${generation}:${message.messageID}:${deliveries.length}`)}`,
        });
        imageBytes += image.size ?? 0;
        if (imageBytes > 50 * 1024 * 1024) throw new Error('image_budget');
        assertCurrent();
        deliveries.push({ text: '', image });
      } catch {
        assertCurrent();
        signal?.throwIfAborted();
        deliveries.push({ text: channelImageFailure(language) });
      }
      continue;
    }
    const chars = Array.from(part.text ?? '');
    for (let index = 0; index < chars.length; index += 3500) deliveries.push({ text: chars.slice(index, index + 3500).join('') });
  }
  return deliveries;
}

export async function readChannelDeliveryImage(service, assistantID, image, signal) {
  if (!image) return undefined;
  signal?.throwIfAborted();
  const { buffer, mime, filename } = await service.getAssistantContactAttachment(assistantID, image.attachmentID);
  signal?.throwIfAborted();
  return { buffer, mime, filename: filename || 'image.png' };
}
