import { memo, type DragEvent } from 'react';
import type { AgentActivity, CardConfig, Issue } from '../api/client.js';
import AgentBadge from './AgentBadge.js';
import IssueTypeIcon from './IssueTypeIcon.js';
import IssueKey from './IssueKey.js';
import PriorityIcon from './PriorityIcon.js';
import UserAvatar from './UserAvatar.js';
import { AttachmentIcon, CommentIcon, FlagIcon, LinkIcon } from './icons.js';
import IssueActionsMenu from './IssueActionsMenu.js';
import OverflowText from './OverflowText.js';

/** Jira color-edge: first matching rule colors the card's left edge. */
function ruleColor(issue: Issue, colors?: CardConfig['colors']): string | undefined {
  if (!colors) return undefined;
  for (const [key, color] of Object.entries(colors)) {
    // rules as "field:value" keys — priority:Highest, issuetype:Bug, status:Done
    const [field, ...rest] = key.split(':');
    const value = rest.join(':');
    if (!field || !value) continue;
    const actual =
      field === 'priority'
        ? issue.fields.priority?.name
        : field === 'status'
          ? issue.fields.status?.name
          : field === 'issuetype'
            ? issue.fields.issuetype?.name
            : undefined;
    if (actual && actual.toLowerCase() === value.toLowerCase()) return color;
  }
  return undefined;
}

/** Jira dots: 1 per day in column, capped at 4. */
function daysInColumn(issue: Issue): number {
  const raw = issue.fields.statuschangedate;
  if (!raw || typeof raw !== 'string') return 0;
  return Math.floor((Date.now() - Date.parse(raw)) / 86400000);
}

const FIELD = (issue: Issue, k: string) => issue.fields[k as keyof Issue['fields']];

type BoardCardProps = {
  issue: Issue;
  dragging?: boolean;
  /** False when the viewer can neither transition nor rank issues. */
  draggable?: boolean;
  /** Permission map forwarded to the ⋯ menu. */
  can?: { flag?: boolean; link?: boolean; clone?: boolean; move?: boolean; convert?: boolean; delete?: boolean };
  cardConfig?: CardConfig;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onClick: (e: React.MouseEvent) => void;
  /** 058 US5 — live agent presence for this card (page-fetched, SSE-updated). */
  agentActivity?: AgentActivity;
};

function BoardCard({
  issue,
  dragging,
  draggable = true,
  can,
  cardConfig,
  onDragStart,
  onDragEnd,
  onClick,
  agentActivity,
}: BoardCardProps) {
  const f = issue.fields;
  const flagged = Boolean(FIELD(issue, 'flagged'));
  const comments = (f.comment as { total?: number } | undefined)?.total ?? 0;
  const attachments = (f.attachmentCount as number | undefined) ?? 0;
  const links = (f.issuelinkCount as number | undefined) ?? 0;
  const days = cardConfig?.daysInColumn ? daysInColumn(issue) : 0;
  const indicators = cardConfig?.indicators;
  const edge = ruleColor(issue, cardConfig?.colors);
  const showIndicators =
    (indicators?.flag !== false && flagged) ||
    (indicators?.comments && comments > 0) ||
    (indicators?.attachments && attachments > 0) ||
    (indicators?.links && links > 0);
  const hasSubtasks = ((FIELD(issue, 'subtasks') as unknown[] | undefined)?.length ?? 0) > 0;
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`group relative bg-atl-paper rounded-[3px] shadow-[0_1px_1px_rgba(9,30,66,0.25),0_0_1px_rgba(9,30,66,0.31)] p-2.5 hover:bg-atl-n-10 select-none ${
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${dragging ? 'opacity-50' : ''}`}
      style={edge ? { borderLeft: `4px solid ${edge}`, paddingLeft: 7 } : undefined}
    >
      <OverflowText
        as="p"
        text={f.summary}
        className="text-sm text-atl-n-800 leading-snug mb-2 line-clamp-3"
      />
      {days > 0 && (
        <div className="mb-2 flex gap-0.5" title={`${days} day${days === 1 ? '' : 's'} in this column`}>
          {Array.from({ length: Math.min(4, days) }).map((_, i) => (
            <span key={i} className={`w-1.5 h-1.5 rounded-full ${days > 3 ? 'bg-atl-r-500' : 'bg-atl-n-40'}`} />
          ))}
          {days > 4 && <span className="text-[9px] text-atl-r-500 leading-none">+</span>}
        </div>
      )}
      {showIndicators && (
        <div className="mb-2 flex items-center gap-2 text-[10px] text-atl-n-200">
          {flagged && indicators?.flag !== false && (
            <FlagIcon size={12} className="text-atl-r-500" title="Flagged" />
          )}
          {indicators?.comments && comments > 0 && (
            <span className="inline-flex items-center gap-0.5" title={`${comments} comments`}>
              <CommentIcon size={12} /> {comments}
            </span>
          )}
          {indicators?.attachments && attachments > 0 && (
            <span className="inline-flex items-center gap-0.5" title={`${attachments} attachments`}>
              <AttachmentIcon size={12} /> {attachments}
            </span>
          )}
          {indicators?.links && links > 0 && (
            <span className="inline-flex items-center gap-0.5" title={`${links} issue links`}>
              <LinkIcon size={12} /> {links}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex" title={f.issuetype.name}>
            <IssueTypeIcon name={f.issuetype.name} hierarchyLevel={f.issuetype.hierarchyLevel} />
          </span>
          <IssueKey
            issueKey={issue.key}
            categoryKey={f.status.statusCategory.key}
            className="text-xs font-medium text-atl-n-300"
          />
          <span className="inline-flex" title={`Priority: ${f.priority.name}`}>
            <PriorityIcon name={f.priority.name} />
          </span>
          <AgentBadge issueKey={issue.key} activity={agentActivity} />
          {f.story_points != null && (
            <span
              title={`${f.story_points} story points`}
              className="w-5 h-4 rounded-full bg-atl-n-30 text-[10px] font-semibold text-atl-n-600 flex items-center justify-center"
            >
              {f.story_points}
            </span>
          )}
        </span>
        <UserAvatar displayName={f.assignee?.displayName} size={22} />
      </div>
      <div
        className="absolute right-1 top-1 z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <IssueActionsMenu
          compact
          issueKey={issue.key}
          hasSubtasks={hasSubtasks}
          flagged={flagged}
          issuetypeName={f.issuetype.name}
          issuetypeSubtask={f.issuetype.subtask}
          projectKey={f.project.key}
          can={can}
        />
      </div>
    </div>
  );
}

// Handler props are inline closures in the board's render loop — fresh refs
// every render, but they only capture `issue` (compared) and stable setters,
// so ignoring them in the comparator is safe and lets unchanged cards skip
// re-render during drag-over state churn on a 200-card board.
export default memo(
  BoardCard,
  (prev, next) =>
    prev.issue === next.issue &&
    prev.dragging === next.dragging &&
    prev.draggable === next.draggable &&
    prev.can === next.can &&
    prev.cardConfig === next.cardConfig &&
    prev.agentActivity === next.agentActivity
);
