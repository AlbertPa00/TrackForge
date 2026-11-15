// 027/028 — per-report export control: CSV via the report endpoint (?format=csv,
// session-cookie download), PNG via client-side SVG raster. Put inside a
// <section> — the PNG export grabs that section's first <svg>.
import { exportSectionPng } from '../lib/exportChart.js';

const BTN = 'h-7 px-2 rounded-[3px] text-xs font-medium text-atl-n-500 hover:bg-atl-n-20 border border-atl-n-40 bg-atl-paper';

export default function ExportMenu({ csvPath, name, chart = true }: { csvPath?: string; name: string; chart?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {csvPath && (
        <a
          className={BTN + ' inline-flex items-center no-underline'}
          href={`/api/internal/reports${csvPath}${csvPath.includes('?') ? '&' : '?'}format=csv`}
          download
        >
          CSV
        </a>
      )}
      {chart && (
        <button
          type="button"
          className={BTN}
          title="Export chart as PNG"
          onClick={(e) => exportSectionPng(e.currentTarget, name)}
        >
          PNG
        </button>
      )}
    </span>
  );
}
