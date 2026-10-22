import { describe, expect, it } from "vitest";
import { isSafeImageSrc, markdownUrlTransform } from "../markdownSafety";

describe("markdown image safety", () => {
  it("allows inline raster/SVG data URIs only", () => {
    expect(isSafeImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeImageSrc("data:image/svg+xml,%3Csvg%2F%3E")).toBe(true);
    expect(isSafeImageSrc("DATA:image/JPEG;base64,AAAA")).toBe(true);
  });

  it("blocks remote, protocol-relative, relative and other schemes", () => {
    for (const src of [
      "https://tracker.example/pixel.png",
      "http://tracker.example/pixel.png",
      "//tracker.example/pixel.png",
      "./local.png",
      "/assets/local.png",
      "file:///etc/passwd",
      "blob:http://127.0.0.1:5173/1234",
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:application/javascript,alert(1)",
      "",
      undefined,
      null,
    ]) {
      expect(isSafeImageSrc(src), String(src)).toBe(false);
    }
  });

  it("urlTransform blanks unsafe image sources and keeps safe ones", () => {
    expect(markdownUrlTransform("https://tracker.example/p.png", "src")).toBe("");
    expect(markdownUrlTransform("./p.png", "src")).toBe("");
    expect(markdownUrlTransform("data:image/png;base64,AAAA", "src")).toBe("data:image/png;base64,AAAA");
  });

  it("urlTransform keeps links as links and still strips dangerous schemes", () => {
    expect(markdownUrlTransform("https://example.com/docs", "href")).toBe("https://example.com/docs");
    expect(markdownUrlTransform("mailto:a@example.com", "href")).toBe("mailto:a@example.com");
    expect(markdownUrlTransform("javascript:alert(1)", "href")).toBe("");
    expect(markdownUrlTransform("data:text/html;base64,AAAA", "href")).toBe("");
  });
});
