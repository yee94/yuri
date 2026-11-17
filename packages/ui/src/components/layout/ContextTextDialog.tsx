import React from 'react';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import './context-window.css';
import {
  PIECE_ROLE_KEYS,
  itemName,
  itemTag,
  partLabel,
  splitPath,
} from './contextWindowLabels';
import {
  type ContextItem,
  type ContextPart,
  type ContextPartKind,
  type ContextPiece,
  formatCompactTokens,
} from './contextWindowMap';

const TEXT_STEP = 20000;
const ITEM_STEP = 100;

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
};

export const ContextItemLabel: React.FC<{ item: ContextItem }> = ({ item }) => {
  const { t } = useI18n();
  const name = itemName(t, item);
  if (item.kind !== 'file' || !name.includes('/')) {
    return <span className="yuri-ctx-name" title={name}><b>{name}</b></span>;
  }
  const { base, dir } = splitPath(name);
  return <span className="yuri-ctx-name" title={name}><b>{base}</b><small>{dir}</small></span>;
};

const LongText: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useI18n();
  const [shown, setShown] = React.useState(TEXT_STEP);
  const left = text.length - shown;
  return (
    <div className="yuri-ctx-text-box">
      <pre className="yuri-ctx-text">{text.slice(0, shown)}</pre>
      {left > 0 ? (
        <button type="button" className="yuri-ctx-more" onClick={() => setShown((current) => current + TEXT_STEP)}>
          {t('contextSidebar.window.text.showMore', { count: left.toLocaleString() })}
        </button>
      ) : null}
    </div>
  );
};

const Piece: React.FC<{ piece: ContextPiece }> = ({ piece }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const text = React.useMemo(() => stringify(piece.value), [piece.value]);
  const copy = useEvent(async () => {
    const result = await copyTextToClipboard(text);
    if (!result.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  });
  return (
    <div className="yuri-ctx-piece">
      <div className="yuri-ctx-piece-head">
        <span className="yuri-ctx-role">{t(PIECE_ROLE_KEYS[piece.role])}</span>
        {piece.name ? <code className="yuri-ctx-piece-name">{piece.name}</code> : null}
        {text ? (
          <button
            type="button"
            className="yuri-ctx-copy"
            onClick={copy}
            aria-label={copied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copy')}
            title={copied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copy')}
          >
            <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
          </button>
        ) : null}
      </div>
      {text ? <LongText text={text} /> : <div className="yuri-ctx-piece-note">{t('contextSidebar.window.text.empty')}</div>}
    </div>
  );
};

const Entry: React.FC<{ item: ContextItem; kind: ContextPartKind; defaultOpen: boolean }> = ({ item, kind, defaultOpen }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(defaultOpen);
  const tag = itemTag(item);
  return (
    <div className={cn('yuri-ctx-vi', open && 'is-open')}>
      <button type="button" className="yuri-ctx-vi-head" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="yuri-ctx-vi-tw"><Icon name="arrow-down-s" className="size-3" /></span>
        <ContextItemLabel item={item} />
        {item.count > 1 && item.kind !== 'turn' ? <span className="yuri-ctx-x">×{item.count}</span> : null}
        {tag ? <code className="yuri-ctx-tag">{tag}</code> : null}
        <span className="yuri-ctx-v">{formatCompactTokens(item.tokens)}</span>
      </button>
      {open ? (
        <div className="yuri-ctx-vi-text">
          {item.pieces.length > 0
            ? item.pieces.map((piece, index) => <Piece key={index} piece={piece} />)
            : (
              <div className="yuri-ctx-piece-note">
                {kind === 'system' ? t('contextSidebar.window.text.baselineUnavailable') : t('contextSidebar.window.text.empty')}
              </div>
            )}
        </div>
      ) : null}
    </div>
  );
};

export type ContextTextTarget = { kind: ContextPartKind; itemId: string | null };

type ContextTextDialogProps = {
  target: ContextTextTarget | null;
  parts: ContextPart[];
  onClose: () => void;
};

export const ContextTextDialog: React.FC<ContextTextDialogProps> = ({ target, parts, onClose }) => {
  const { t } = useI18n();
  // Switching to "all of the part" is local to the open dialog.
  const [showAllFor, setShowAllFor] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState(ITEM_STEP);
  const part = target ? parts.find((entry) => entry.kind === target.kind) ?? null : null;
  const targetKey = target ? `${target.kind}:${target.itemId ?? ''}` : null;
  const picked = part && target?.itemId && showAllFor !== targetKey
    ? part.items.find((item) => item.id === target.itemId) ?? null
    : null;
  const items = part?.items ?? [];
  const title = part ? (picked ? `${partLabel(t, part.kind)} · ${itemName(t, picked)}` : partLabel(t, part.kind)) : '';
  const total = picked ? picked.tokens : items.reduce((sum, item) => sum + item.tokens, 0);

  const handleOpenChange = useEvent((open: boolean) => {
    if (open) return;
    setShowAllFor(null);
    setShown(ITEM_STEP);
    onClose();
  });
  const showAll = useEvent(() => setShowAllFor(targetKey));

  return (
    <Dialog open={target !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="yuri-ctx-dialog max-w-[880px] w-[min(880px,calc(100vw-2rem))]">
        <div className="yuri-ctx-dialog-head">
          {part ? <span className={cn('yuri-ctx-dot', `yuri-ctx-k-${part.kind}`)} /> : null}
          <DialogTitle className="leading-snug">{title}</DialogTitle>
          <span className="yuri-ctx-dialog-total">{formatCompactTokens(total)} {t('contextSidebar.window.tokens')}</span>
        </div>
        <div className="yuri-ctx-dialog-body">
          <DialogDescription className="yuri-ctx-dialog-note">{t('contextSidebar.window.text.note')}</DialogDescription>
          {part ? (
            picked
              ? <Entry key={picked.id} item={picked} kind={part.kind} defaultOpen />
              : items.slice(0, shown).map((item) => <Entry key={item.id} item={item} kind={part.kind} defaultOpen={items.length === 1} />)
          ) : null}
          {part && !picked && items.length > shown ? (
            <button type="button" className="yuri-ctx-more" onClick={() => setShown((current) => current + ITEM_STEP)}>
              {t('contextSidebar.window.text.showMoreItems', { count: items.length - shown })}
            </button>
          ) : null}
        </div>
        {picked && items.length > 1 ? (
          <div className="yuri-ctx-dialog-foot">
            <Button size="sm" onClick={showAll}>
              {t('contextSidebar.window.text.allOf', { part: partLabel(t, part!.kind), count: items.length })}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
