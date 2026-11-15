import type { QueryClient } from '@tanstack/react-query';
import {
  addWatcher,
  assignIssue,
  executeTransition,
  fetchTransitions,
  fetchMyself,
  removeWatcher,
  unvoteIssue,
  voteIssue,
  type Myself,
} from '../api/client.js';
import { markIssueWrite } from './issueWrites.js';

/**
 * 058 US3 — deterministic local commands for the unified palette. These never
 * touch the AI provider: they run identically whether or not Copilot is
 * configured. Anything prefixed `ai:` bypasses this registry and goes to the
 * planner (handled by CommandPalette).
 */
export interface CommandCtx {
  navigate: (to: string) => void;
  qc: QueryClient;
  /** Issue in context — /browse/:key or the open drawer's ?selectedIssue=. */
  issueKey?: string;
  projectKey?: string;
  me?: Myself;
  openCreate: () => void;
}

export interface LocalCommand {
  id: string;
  title: string;
  /** Right-aligned hint text (target page, shortcut meaning). */
  hint?: string;
  keywords?: string[];
  /** Extra tokens the user must have typed for this command to apply. */
  when?: (ctx: CommandCtx) => boolean;
  /** May return a status line shown inside the palette. `input` is the raw
   *  query text so commands like "move TF-1 to done" can parse the tail. */
  run: (ctx: CommandCtx, input?: string) => void | Promise<string | void>;
}

const nav = (
  id: string,
  title: string,
  to: string | ((c: CommandCtx) => string),
  hint: string,
  keywords: string[] = []
): LocalCommand => ({
  id,
  title,
  hint,
  keywords,
  run: (c) => {
    c.navigate(typeof to === 'string' ? to : to(c));
  },
});

function afterIssueWrite(qc: QueryClient, issueKey: string): void {
  markIssueWrite(issueKey);
  void qc.invalidateQueries({ queryKey: ['issue', issueKey] });
  void qc.invalidateQueries({ queryKey: ['issues'] });
  void qc.invalidateQueries({ queryKey: ['board-issues'] });
  void qc.invalidateQueries({ queryKey: ['backlog'] });
  void qc.invalidateQueries({ queryKey: ['sprint-issues'] });
}

export function localCommands(ctx: CommandCtx): LocalCommand[] {
  const p = ctx.projectKey ? `/projects/${ctx.projectKey}` : '';
  return [
    nav('your-work', 'Go to Your work', '/your-work', 'Your work', ['home', 'my']),
    nav('issues', 'Go to Issue navigator', '/issues', 'Search', ['search', 'find', 'jql']),
    nav('projects', 'Go to Projects', '/projects', 'Directory', ['all projects']),
    nav('dashboards', 'Go to Dashboards', '/dashboards', 'Gadgets', ['dash', 'gadgets']),
    nav('filters', 'Go to Filters', '/filters', 'Saved filters', ['saved']),
    nav('approvals', 'Go to Approvals', '/approvals', 'AI approvals', ['approve', 'queue']),
    nav('docs', 'Open documentation', '/docs', 'Help', ['help', 'guide']),
    nav('board', 'Go to Board', p ? `${p}/board` : '/projects', 'Board', ['kanban', 'scrum']),
    nav('backlog', 'Go to Backlog', p ? `${p}/backlog` : '/projects', 'Backlog', ['list', 'sprints']),
    nav('timeline', 'Go to Timeline', p ? `${p}/timeline` : '/projects', 'Roadmap', ['roadmap', 'gantt', 'plan']),
    nav('reports', 'Go to Reports', p ? `${p}/reports` : '/projects', 'Reports', ['charts', 'burndown']),
    nav('releases', 'Go to Releases', p ? `${p}/releases` : '/projects', 'Versions', ['versions']),
    {
      id: 'create-issue',
      title: 'Create issue…',
      hint: 'Dialog',
      keywords: ['new', 'add issue', 'ticket'],
      run: (c) => c.openCreate(),
    },
    {
      id: 'open-issue',
      title: `Open ${ctx.issueKey}`,
      hint: 'Full page',
      keywords: ['browse', 'view'],
      when: (c) => Boolean(c.issueKey),
      run: (c) => c.navigate(`/browse/${ctx.issueKey}`),
    },
    {
      id: 'assign-me',
      title: `Assign ${ctx.issueKey} to me`,
      hint: 'Assignee',
      keywords: ['assign', 'take', 'mine', 'self'],
      when: (c) => Boolean(c.issueKey && c.me),
      run: async (c) => {
        await assignIssue(ctx.issueKey!, ctx.me!.accountId);
        afterIssueWrite(c.qc, ctx.issueKey!);
        return `${ctx.issueKey} assigned to you`;
      },
    },
    {
      id: 'unassign',
      title: `Unassign ${ctx.issueKey}`,
      hint: 'Assignee',
      keywords: ['unassign', 'clear assignee', 'nobody'],
      when: (c) => Boolean(c.issueKey),
      run: async (c) => {
        await assignIssue(ctx.issueKey!, null);
        afterIssueWrite(c.qc, ctx.issueKey!);
        return `${ctx.issueKey} unassigned`;
      },
    },
    {
      id: 'watch',
      title: `Watch ${ctx.issueKey}`,
      hint: 'Notifications',
      keywords: ['watch', 'follow', 'subscribe'],
      when: (c) => Boolean(c.issueKey),
      run: async (c) => {
        await addWatcher(ctx.issueKey!);
        afterIssueWrite(c.qc, ctx.issueKey!);
        return `Watching ${ctx.issueKey}`;
      },
    },
    {
      id: 'unwatch',
      title: `Stop watching ${ctx.issueKey}`,
      hint: 'Notifications',
      keywords: ['unwatch', 'unfollow'],
      when: (c) => Boolean(c.issueKey),
      run: async (c) => {
        await removeWatcher(ctx.issueKey!);
        afterIssueWrite(c.qc, ctx.issueKey!);
        return `Stopped watching ${ctx.issueKey}`;
      },
    },
    {
      id: 'vote',
      title: `Vote for ${ctx.issueKey}`,
      hint: 'Vote',
      keywords: ['vote', '+1', 'upvote'],
      when: (c) => Boolean(c.issueKey),
      run: async (c) => {
        await voteIssue(ctx.issueKey!);
        afterIssueWrite(c.qc, ctx.issueKey!);
        return `Voted on ${ctx.issueKey}`;
      },
    },
    {
      id: 'unvote',
      title: `Remove vote on ${ctx.issueKey}`,
      hint: 'Vote',
      keywords: ['unvote', '-1'],
      when: (c) => Boolean(c.issueKey),
      run: async (c) => {
        await unvoteIssue(ctx.issueKey!);
        afterIssueWrite(c.qc, ctx.issueKey!);
        return `Removed vote on ${ctx.issueKey}`;
      },
    },
    {
      id: 'transition',
      title: `Move ${ctx.issueKey} to…`,
      hint: 'Type a status: "done", "in progress"',
      keywords: ['move', 'transition', 'status', 'done', 'progress', 'todo'],
      when: (c) => Boolean(c.issueKey),
      run: async (c, input) => {
        const target = (input ?? '')
          .toLowerCase()
          .replace(/\b(move|transition|status|set|to|the|issue|in)\b/g, ' ')
          .replace(/[a-z][a-z0-9]*-\d+/g, ' ')
          .trim();
        const transitions = await fetchTransitions(ctx.issueKey!);
        const t =
          transitions.find((x) => x.to.name.toLowerCase() === target) ??
          transitions.find((x) => x.to.name.toLowerCase().includes(target)) ??
          transitions.find((x) => x.name.toLowerCase().includes(target));
        if (!t) {
          const names = transitions.map((x) => x.to.name).join(', ');
          return `No matching transition${names ? ` — try: ${names}` : ''}`;
        }
        await executeTransition(ctx.issueKey!, t.id);
        afterIssueWrite(c.qc, ctx.issueKey!);
        return `${ctx.issueKey} → ${t.to.name}`;
      },
    },
  ];
}

/** Substring match across title + keywords; deterministic ordering. */
export function matchCommands(commands: LocalCommand[], input: string): LocalCommand[] {
  const q = input.trim().toLowerCase();
  if (!q) return commands;
  return commands
    .map((c) => {
      const hay = [c.title, ...(c.keywords ?? [])].map((s) => s.toLowerCase());
      const score = hay.some((h) => h.startsWith(q))
        ? 0
        : hay.some((h) => h.includes(q))
          ? 1
          : q.split(/\s+/).every((t) => hay.some((h) => h.includes(t)))
            ? 2
            : -1;
      return { c, score };
    })
    .filter((m) => m.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((m) => m.c);
}

/** 068 — is this keystroke a command or a copilot prompt? Question/analysis
 *  verbs and longer sentences are copilot intent (they were the victims of the
 *  substring-match hijack: "list sprints" used to navigate to Backlog). Short
 *  imperatives (assign/watch/move/vote) stay deterministic commands. */
const COPILOT_LEADS = new Set([
  'what',
  'whats',
  "what's",
  'who',
  'whos',
  "who's",
  'whose',
  'why',
  'how',
  'which',
  'when',
  'where',
  'show',
  'list',
  'count',
  'summarize',
  'summarise',
  'explain',
  'compare',
  'tell',
  'describe',
  'analyse',
  'analyze',
  'find',
  'search',
  'many',
  'much',
]);
export function paletteIntent(input: string): 'command' | 'copilot' {
  const q = input.trim().toLowerCase();
  if (!q) return 'command';
  const tokens = q.split(/\s+/);
  if (COPILOT_LEADS.has(tokens[0]!)) return 'copilot';
  if (tokens.length >= 5) return 'copilot';
  return 'command';
}

/** `me` for command availability; cached so the palette never blocks on it. */
export async function loadMe(qc: QueryClient): Promise<Myself | undefined> {
  return qc.fetchQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity }).catch(() => undefined);
}
