import { defaultUrlTransform } from "react-markdown";

/**
 * Markdown rendered in the dashboard comes from the analyzed project (README
 * and other .md files) and from LLM-written graph text, so it is untrusted.
 * Remote images are a tracking/exfiltration channel (and the page's CSP would
 * block them anyway), so only inline raster/SVG data URIs are rendered;
 * everything else is replaced by a placeholder. Links stay links.
 */
const INLINE_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

export function isSafeImageSrc(src: unknown): src is string {
  return typeof src === "string" && INLINE_IMAGE_RE.test(src.trim());
}

/**
 * `urlTransform` for react-markdown: keeps the default link sanitising
 * (http/https/mailto/relative only) and additionally lets inline image data
 * URIs through for `src` (the default drops `data:`), blanking any other
 * image source.
 */
export function markdownUrlTransform(url: string, key: string): string {
  if (key === "src") return isSafeImageSrc(url) ? url.trim() : "";
  return defaultUrlTransform(url);
}
