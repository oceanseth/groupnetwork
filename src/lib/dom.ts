/**
 * Minimal rendering helpers.
 *
 * This is a social network, so almost every string on screen came from another
 * member. The `html` tagged template escapes every interpolation by default and
 * makes the unsafe case something you have to type on purpose (`raw`) — the
 * opposite default from innerHTML, which is how XSS gets in.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** A string that has already been escaped and may be inserted verbatim. */
class RawHtml {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

/** Mark a fragment as pre-escaped. Only ever call this on markup you built. */
export const raw = (value: string) => new RawHtml(value);

function interpolate(value: unknown): string {
  if (value instanceof RawHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += interpolate(values[i]) + strings[i + 1];
  }
  return new RawHtml(out);
}

/** Render into a container. Accepts only `html`/`raw` output, never a bare string. */
export function render(target: Element | null, content: RawHtml) {
  if (target) target.innerHTML = content.value;
}

export const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
  root.querySelector<T>(selector);

export const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(selector));

/**
 * Delegated event binding. Views re-render wholesale, so binding to a stable
 * container beats re-attaching listeners to elements that no longer exist.
 */
export function on<K extends keyof HTMLElementEventMap>(
  root: Element | Document,
  event: K,
  selector: string,
  handler: (ev: HTMLElementEventMap[K], target: HTMLElement) => void,
) {
  root.addEventListener(event, (ev) => {
    const match = (ev.target as HTMLElement | null)?.closest(selector);
    if (match && root.contains(match)) handler(ev as HTMLElementEventMap[K], match as HTMLElement);
  });
}

/** Body text with line breaks preserved and links made clickable, safely. */
export function formatBody(body: string): RawHtml {
  const escaped = escapeHtml(body);
  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
  return raw(linked.replace(/\n/g, '<br>'));
}

export type { RawHtml };
