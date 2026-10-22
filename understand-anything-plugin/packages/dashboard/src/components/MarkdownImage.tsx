import { isSafeImageSrc } from "../utils/markdownSafety";

/**
 * `img` renderer for react-markdown. Inline data-URI images render normally;
 * anything else (remote, relative, file:) becomes a text placeholder so the
 * page never requests an image from another host.
 */
export default function MarkdownImage({ src, alt }: { src?: unknown; alt?: string }) {
  if (isSafeImageSrc(src)) {
    return (
      <img src={src} alt={alt} className="max-w-full rounded-lg border border-border-subtle my-2" />
    );
  }
  return (
    <span className="inline-block text-xs italic text-text-muted border border-dashed border-border-subtle rounded px-1.5 py-0.5 my-1">
      [image not loaded{alt ? `: ${alt}` : ""}]
    </span>
  );
}
