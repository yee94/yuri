import { View } from 'nsh';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Surface } from '../core/ui';
import type { Node } from './model';
import { ProjectCard } from './ProjectCard';
import { SessionGroup } from './SessionGroup';

const box = { borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border(), backgroundColor: 'transparent' } as const;
const groups = { paddingHorizontal: 12, paddingTop: 2, paddingBottom: 14, gap: 10 } as const;

/** Web's "Pinned / In progress" surface: pinned sessions first, then what needs attention. */
export function PinnedSurface(props: {
  pinned: () => Node[];
  inProgress: () => Node[];
  collapsed: () => boolean;
  highlight: () => string;
  onToggle: () => void;
  onSelect: (node: Node) => void;
  onPin: (node: Node) => void;
  onArchive: (node: Node) => void;
  onOpenActions: (node: Node) => void;
}) {
  return (
    <If when={props.pinned().length + props.inProgress().length > 0}>
      <Surface>
        <ProjectCard
          model={() => ({
            name: t('mobile.sessions.section.pinned'),
            icon: 'pushpin',
            count: props.pinned().length + props.inProgress().length,
            expanded: !props.collapsed(),
          })}
          onToggle={props.onToggle}
        />
        <If when={!props.collapsed()}>
          <View style={groups}>
            <If when={props.pinned().length > 0}>
              <View style={box}>
                <SessionGroup
                  scope="__pinned__"
                  nodes={props.pinned}
                  idPrefix="pinned-"

                  canReorder={() => true}
                  highlight={props.highlight}
                  onSelect={props.onSelect}
                  onPin={props.onPin}
                  onArchive={props.onArchive}
                  onOpenActions={props.onOpenActions}
                />
              </View>
            </If>
            <If when={props.inProgress().length > 0}>
              <View style={box}>
                <SessionGroup
                  scope="__progress__"
                  nodes={props.inProgress}
                  idPrefix="progress-"

                  canReorder={() => false}
                  highlight={props.highlight}
                  onSelect={props.onSelect}
                  onPin={props.onPin}
                  onArchive={props.onArchive}
                  onOpenActions={props.onOpenActions}
                />
              </View>
            </If>
          </View>
        </If>
      </Surface>
    </If>
  );
}
