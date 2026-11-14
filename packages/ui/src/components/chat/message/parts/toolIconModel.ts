import type { IconName } from '../../../icon/icons';

/** Platform-neutral artwork choice; renderers own the native image / SVG node. */
export function toolIconSpec(toolName: string): { name: IconName; size: number; todo?: boolean } {
    const tool = toolName.toLowerCase();
    if (['edit', 'multiedit', 'apply_patch', 'patch', 'str_replace', 'str_replace_based_edit_tool'].includes(tool)) return { name: 'pencil', size: 13 };
    if (['write', 'create', 'file_write'].includes(tool)) return { name: 'file-edit', size: 13 };
    if (['read', 'view', 'file_read', 'cat'].includes(tool)) return { name: 'file-text', size: 14 };
    if (['bash', 'shell', 'cmd', 'terminal'].includes(tool)) return { name: 'terminal-box', size: 14 };
    if (tool === 'execute') return { name: 'code-box', size: 14 };
    if (['list', 'ls', 'dir', 'list_files'].includes(tool)) return { name: 'folder-6', size: 14 };
    if (['search', 'grep', 'find', 'ripgrep'].includes(tool)) return { name: 'menu-search', size: 14 };
    if (tool === 'glob') return { name: 'file-search', size: 14 };
    if (['fetch', 'curl', 'wget', 'webfetch', 'browser', 'web-search', 'websearch', 'search_web', 'codesearch', 'google', 'bing', 'duckduckgo', 'perplexity'].includes(tool)) return { name: 'global', size: 14 };
    if (['todowrite', 'todoread'].includes(tool)) return { name: 'list-check-2', size: 14, todo: true };
    if (['structuredoutput', 'structured_output'].includes(tool)) return { name: 'list-check-2', size: 14 };
    if (tool === 'skill') return { name: 'book', size: 14 };
    if (['task', 'subagent'].includes(tool)) return { name: 'ai-agent', size: 14 };
    if (tool === 'question') return { name: 'survey', size: 14 };
    if (tool === 'lsp') return { name: 'scan-2', size: 14 };
    return { name: tool.startsWith('git') ? 'git-branch' : 'tools', size: 14 };
}
