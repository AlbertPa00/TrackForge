/** UB-017 — Jira "Diagram" view: status boxes grouped by category column with
 *  transition arrows. Render-only; edits happen in the text editor (which the
 *  diagram mirrors live since it reads the same draft state). */
import { ACCENT, SVG } from '../lib/palette.js';

interface DiagramStatus {
  id: string;
  name: string;
  categoryKey: string;
  isInitial: boolean;
}
interface DiagramTransition {
  name: string;
  fromStatusId: string | null;
  toStatusId: string;
}

const COLS: { key: string; label: string; x: number }[] = [
  { key: 'new', label: 'To Do', x: 24 },
  { key: 'indeterminate', label: 'In Progress', x: 344 },
  { key: 'done', label: 'Done', x: 664 },
];
const BOX_W = 220;
const BOX_H = 44;
const ROW_GAP = 64;
const PAD_TOP = 48;

const CAT_FILL: Record<string, string> = {
  new: SVG.subtle,
  indeterminate: ACCENT.blue,
  done: ACCENT.green,
};

export default function WorkflowDiagram({
  statuses,
  transitions,
}: {
  statuses: DiagramStatus[];
  transitions: DiagramTransition[];
}) {
  // Lay statuses into category columns, top-down.
  const pos = new Map<string, { x: number; y: number }>();
  const colRow = [0, 0, 0];
  statuses.forEach((s) => {
    const ci = Math.max(
      0,
      COLS.findIndex((c) => c.key === (s.categoryKey in CAT_FILL ? s.categoryKey : 'new'))
    );
    const ciSafe = ci === -1 ? 0 : ci;
    pos.set(s.id, { x: COLS[ciSafe].x, y: PAD_TOP + colRow[ciSafe] * ROW_GAP });
    colRow[ciSafe]++;
  });

  const height = PAD_TOP + Math.max(...colRow, 1) * ROW_GAP + 40;

  // Group parallel edges so labels don't overlap.
  const edgeKey = (t: DiagramTransition, i: number) => `${t.fromStatusId}->${t.toStatusId}:${i}`;

  return (
    <div className="mb-6 overflow-x-auto rounded-[3px] border border-atl-n-30 bg-atl-paper">
      <svg
        role="img"
        aria-label="Workflow diagram"
        width={COLS[2].x + BOX_W + 24}
        height={height}
        className="block"
      >
        <defs>
          <marker id="tf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill={SVG.subtle} />
          </marker>
        </defs>

        {COLS.map((c) => (
          <text key={c.key} x={c.x + 4} y={22} fontSize="11" fontWeight={600} fill={SVG.subtle}>
            {c.label.toUpperCase()}
          </text>
        ))}

        {transitions.map((t, i) => {
          const p = pos.get(t.toStatusId);
          if (!p) return null;
          if (t.fromStatusId === null) {
            // Global ("All") transition — dashed badge into the target's left edge.
            const tx = p.x - 14;
            const ty = p.y + BOX_H / 2;
            return (
              <g key={edgeKey(t, i)}>
                <line x1={tx - 26} y1={ty} x2={p.x} y2={ty} stroke={SVG.n80} strokeDasharray="4 3" markerEnd="url(#tf-arrow)" />
                <circle cx={tx - 30} cy={ty} r={4} fill="none" stroke={SVG.n80} strokeDasharray="2 2" />
                <text x={tx - 40} y={ty - 8} textAnchor="end" fontSize="10" fill={SVG.subtle}>
                  {t.name}
                </text>
              </g>
            );
          }
          const q = pos.get(t.fromStatusId);
          if (!q) return null;
          const x1 = q.x + BOX_W / 2;
          const y1 = q.y + BOX_H / 2;
          const x2 = p.x + BOX_W / 2;
          const y2 = p.y + BOX_H / 2;
          let d: string;
          let lx: number;
          let ly: number;
          if (t.fromStatusId === t.toStatusId) {
            // Self-loop: arc out the right side of the box.
            const r = q.x + BOX_W;
            d = `M ${r} ${q.y + 8} C ${r + 34} ${q.y + 8}, ${r + 34} ${q.y + BOX_H - 8}, ${r} ${q.y + BOX_H - 8}`;
            lx = r + 38;
            ly = y1;
          } else if (Math.abs(x2 - x1) < 8) {
            // Same column — arc out to the right.
            const r = Math.max(x1, x2) + BOX_W / 2 + 30;
            d = `M ${x1 + BOX_W / 2} ${y1} C ${r} ${y1}, ${r} ${y2}, ${x2 + BOX_W / 2} ${y2}`;
            lx = r + 6;
            ly = (y1 + y2) / 2;
          } else {
            const sign = x2 > x1 ? 1 : -1;
            const sx = x1 + sign * (BOX_W / 2);
            const ex = x2 - sign * (BOX_W / 2);
            const sag = x2 > x1 ? -28 : 34; // forward edges arc up, "reopen" edges sag below
            d = `M ${sx} ${y1} C ${sx + sign * 60} ${y1 + sag}, ${ex - sign * 60} ${y2 + sag}, ${ex} ${y2}`;
            lx = (sx + ex) / 2;
            ly = (y1 + y2) / 2 + sag;
          }
          return (
            <g key={edgeKey(t, i)}>
              <path d={d} fill="none" stroke={SVG.n80} strokeWidth={1.4} markerEnd="url(#tf-arrow)" />
              <rect x={lx - t.name.length * 3.4 - 4} y={ly - 9} width={t.name.length * 6.8 + 8} height={15} rx={3} fill="white" stroke={SVG.n40} />
              <text x={lx} y={ly + 2.5} textAnchor="middle" fontSize="10" fill={SVG.subtle}>
                {t.name}
              </text>
            </g>
          );
        })}

        {statuses.map((s) => {
          const p = pos.get(s.id)!;
          return (
            <g key={s.id}>
              <rect
                x={p.x}
                y={p.y}
                width={BOX_W}
                height={BOX_H}
                rx={4}
                fill="white"
                stroke={s.isInitial ? ACCENT.blue : SVG.n40}
                strokeWidth={s.isInitial ? 2 : 1}
              />
              <rect x={p.x} y={p.y} width={5} height={BOX_H} rx={2} fill={CAT_FILL[s.categoryKey] ?? CAT_FILL.new} />
              {s.isInitial && (
                <circle cx={p.x + 16} cy={p.y + BOX_H / 2} r={4} fill={ACCENT.blue} />
              )}
              <text x={p.x + (s.isInitial ? 28 : 18)} y={p.y + BOX_H / 2 + 4} fontSize="12" fill={SVG.text} fontWeight={500}>
                {s.name}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="border-t border-atl-n-30 px-3 py-1.5 text-[11px] text-atl-n-100">
        Diagram is read-only — switch to Text to edit statuses, transitions and rules. The blue
        border marks the initial status.
      </p>
    </div>
  );
}
