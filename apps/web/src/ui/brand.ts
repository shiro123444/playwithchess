import markSource from './brand-mark.svg?raw';
import markHref from './brand-mark.svg';

/**
 * The brand mark: a board line dissolving into a move.
 *
 * The old wordmark was the character 弈, which carried the meaning but tied the
 * identity to one glyph in one font, and left the tab icon to the browser. This
 * mark abstracts it into the two things the game is actually made of — the
 * lattice and a piece arriving at a point — so it reads at 16 px as a favicon,
 * at 40 px in the header, and as a watermark without a second drawing.
 *
 * The drawing lives in `brand-mark.svg` and is used twice: once as a static
 * asset for the favicon (a hashed, cacheable URL) and once as inline markup for
 * the header, where inlining lets it inherit the header's own scale and keeps
 * the gradients sharp at any DPI.
 */

export type BrandSize = 'header' | 'icon';

let inlined = 0;

/** Build the mark as a live element for the header. */
export function createBrandMark(size: BrandSize = 'header', title = '弈 · 三维中国象棋'): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = markSource.trim();
  const element = template.content.firstElementChild as SVGSVGElement;
  element.setAttribute('class', `brand-mark brand-mark-${size}`);
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', title);
  element.querySelector('title')?.remove();
  // A second inline copy (a dialog, a preview) would share gradient ids and
  // silently borrow the first copy's paint; suffix them instead.
  if (inlined++ > 0) {
    const suffix = `-${inlined}`;
    for (const node of element.querySelectorAll('[id]')) node.id += suffix;
    for (const node of element.querySelectorAll('[fill],[stroke]')) {
      for (const attribute of ['fill', 'stroke']) {
        const value = node.getAttribute(attribute);
        if (value?.includes('url(')) node.setAttribute(attribute, value.replaceAll(')', `${suffix})`));
      }
    }
  }
  return element;
}

/** Hashed URL of the static asset, for `<link rel="icon">`. */
export function brandIconHref(): string {
  return markHref;
}
