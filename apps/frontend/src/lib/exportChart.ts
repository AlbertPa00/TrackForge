// 027/028 — client-side report export. PNG: serialize the rendered SVG with
// computed styles inlined (svgs use class-based colors), rasterize via canvas.
import { ACCENT } from './palette.js';
function inlineStyles(svg: SVGSVGElement) {
  const els = svg.querySelectorAll('*');
  els.forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.fill && cs.fill !== 'none') el.setAttribute('fill', cs.fill);
    if (cs.stroke && cs.stroke !== 'none') el.setAttribute('stroke', cs.stroke);
    if (cs.fontSize) el.setAttribute('font-size', cs.fontSize);
    if (cs.fontFamily) el.setAttribute('font-family', cs.fontFamily);
    if (cs.strokeWidth && cs.strokeWidth !== '1px') el.setAttribute('stroke-width', cs.strokeWidth);
  });
}

export async function exportSvgAsPng(svg: SVGSVGElement, filename: string) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(clone);
  const box = svg.viewBox.baseVal;
  const w = box.width || svg.clientWidth || 640;
  const h = box.height || svg.clientHeight || 320;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  const src = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG render failed'));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = ACCENT.white;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const a = document.createElement('a');
    a.download = `${filename}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Find the first <svg> inside the closest report section and export it. */
export function exportSectionPng(from: HTMLElement, filename: string) {
  const section = from.closest('section');
  const svg = section?.querySelector('svg');
  if (!svg) return;
  void exportSvgAsPng(svg, filename);
}
