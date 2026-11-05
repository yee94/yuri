import { Button } from '@/components/ui/button';
import { CommitInput } from './CommitInput';
import { AIHighlightsBox } from './AIHighlightsBox';
import { useDeviceInfo } from '@/lib/device';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type CommitAction = 'commit' | 'commitAndPush' | null;

interface CommitSectionProps {
  compact?: boolean;
  stagedCount: number;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  generatedHighlights: string[];
  onInsertHighlights: (highlights: string[]) => void;
  onGenerateMessage: () => void;
  isGeneratingMessage: boolean;
  onCommit: () => void;
  onCommitAndPush: () => void;
  commitAction: CommitAction;
  hasPendingIndexMutation?: boolean;
  gitmojiEnabled: boolean;
  onOpenGitmojiPicker: () => void;
}

export const CommitSection: React.FC<CommitSectionProps> = ({
  compact = false,
  stagedCount,
  commitMessage,
  onCommitMessageChange,
  generatedHighlights,
  onInsertHighlights,
  onGenerateMessage,
  isGeneratingMessage,
  onCommit,
  onCommitAndPush,
  commitAction,
  hasPendingIndexMutation = false,
  gitmojiEnabled,
  onOpenGitmojiPicker,
}) => {
  const { t } = useI18n();
  const hasStagedFiles = stagedCount > 0;
  const canCommit = commitMessage.trim() && hasStagedFiles && commitAction === null && !hasPendingIndexMutation;
  const { isMobile, hasTouchInput } = useDeviceInfo();

  const containerClassName = 'shrink-0 border-0 bg-transparent rounded-none';
  const headerClassName = cn('flex w-full items-baseline gap-2 px-0 pb-1', compact ? 'pt-0' : 'pt-2');
  const contentClassName = cn('flex flex-col px-0', compact ? 'gap-1.5 pb-1' : 'gap-3 pt-1 pb-3');
  const iconClassName = compact ? 'size-3.5' : 'size-4';

  return (
    <section className={containerClassName} data-git-commit-section>
      <div className={headerClassName}>
        <h3 className={cn('shrink-0 font-semibold text-foreground', compact ? 'text-xs leading-4' : 'typography-ui-header')}>{t('gitView.commit.title')}</h3>
        {!hasStagedFiles ? (
          <span className={cn('min-w-0 truncate text-muted-foreground', compact ? 'text-[0.6875rem] leading-4' : 'typography-meta')}>
            {t('gitView.commit.stageFilesHint')}
          </span>
        ) : null}
      </div>

      <div className={contentClassName}>
        <AIHighlightsBox
          highlights={generatedHighlights}
          onInsert={onInsertHighlights}
        />

        <CommitInput
          value={commitMessage}
          onChange={onCommitMessageChange}
          placeholder={t('gitView.commit.messagePlaceholder')}
          disabled={commitAction !== null}
          hasTouchInput={hasTouchInput}
          isMobile={isMobile}
          compact={compact}
        />

        <div className={cn('@container/commit-actions flex items-center min-w-0', compact ? 'gap-1' : 'gap-2')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  variant={compact ? 'ghost' : 'outline'}
                  size={compact ? 'xs' : 'sm'}
                  onClick={onGenerateMessage}
                  disabled={
                    isGeneratingMessage ||
                    commitAction !== null ||
                    hasPendingIndexMutation ||
                    stagedCount === 0
                  }
                  type="button"
                  aria-label={t('gitView.commit.generateAria')}
                  className={cn('commit-actions__btn', compact && 'text-xs')}
                >
                  {isGeneratingMessage ? (
                    <Icon name="loader-4" className={cn(iconClassName, 'animate-spin')} />
                  ) : (
                    <Icon name="ai-generate-2" className={cn(iconClassName, 'text-primary')} />
                  )}
                  <span className="commit-actions__label">{t('gitView.commit.generate')}</span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{t('gitView.commit.generateAria')}</p>
            </TooltipContent>
          </Tooltip>

          {gitmojiEnabled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  onClick={onOpenGitmojiPicker}
                  aria-label={t('gitView.commit.addGitmoji')}
                  className={cn('shrink-0 p-0 text-muted-foreground', compact ? 'w-6' : 'size-7')}
                >
                  <Icon name="emotion-happy" className={iconClassName} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{t('gitView.commit.addGitmoji')}</p>
              </TooltipContent>
            </Tooltip>
          ) : null}

          <div className="flex-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  size={compact ? 'xs' : 'sm'}
                  variant={compact ? 'default' : 'outline'}
                  onClick={onCommit}
                  disabled={!canCommit || isGeneratingMessage}
                  className={cn('commit-actions__btn whitespace-nowrap', compact && 'text-xs')}
                  aria-label={t('gitView.commit.commitAria')}
                >
                  {commitAction === 'commit' ? (
                    <>
                      <Icon name="loader-4" className={cn(iconClassName, 'animate-spin')} />
                      <span className="commit-actions__label">{t('gitView.commit.committing')}</span>
                    </>
                  ) : (
                    <>
                      <Icon name="git-commit" className={iconClassName} />
                      <span className="commit-actions__label">{t('gitView.commit.commit')}</span>
                    </>
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{t('gitView.commit.commitAria')}</p>
            </TooltipContent>
          </Tooltip>

          {isMobile ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onCommitAndPush()}
                    disabled={!canCommit || isGeneratingMessage}
                    className="h-7 w-7 p-0"
                    aria-label={t('gitView.commit.pushAria')}
                  >
                    {commitAction === 'commitAndPush' ? (
                      <Icon name="loader-4" className="size-4 animate-spin" />
                    ) : (
                      <Icon name="arrow-up" className="size-3.5" />
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{t('gitView.commit.push')}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0">
                  <Button
                    size={compact ? 'xs' : 'sm'}
                    variant="default"
                    onClick={() => onCommitAndPush()}
                    disabled={!canCommit || isGeneratingMessage}
                    className={cn('commit-actions__btn', compact && 'text-xs')}
                    aria-label={t('gitView.commit.pushAria')}
                  >
                    {commitAction === 'commitAndPush' ? (
                      <>
                        <Icon name="loader-4" className={cn(iconClassName, 'animate-spin')} />
                        <span className="commit-actions__label commit-actions__label--push">{t('gitView.commit.pushing')}</span>
                      </>
                    ) : (
                      <>
                        <Icon name="arrow-up" className="size-3.5" />
                        <span className="commit-actions__label commit-actions__label--push">{t('gitView.commit.push')}</span>
                      </>
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{t('gitView.commit.pushAria')}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </section>
  );
};
