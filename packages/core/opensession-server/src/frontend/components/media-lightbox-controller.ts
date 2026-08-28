import type { WorkspaceMediaItem } from "../lib/api";
import {
  type DiagramMedia,
  diagramDataUrl,
  readDiagramSvg,
} from "../lib/diagram-media";
import type { ImageRegion } from "../lib/image-region-comment";
import type { WalkthroughMediaLabel } from "../lib/walkthrough-label";

/**
 * Imperative, render-free half of the media lightbox. Keep this module small:
 * transcript rows and composers only need to request a lightbox, and importing
 * the full animated host from each of those leaves made Bun's isolated tests
 * compile the entire application graph repeatedly.
 */

export interface ImageRegionAnnotation {
  id: string;
  region: ImageRegion;
  text: string;
}

export interface LightboxItem {
  kind: "image" | "video" | "diagram";
  src: string;
  diagram?: DiagramMedia;
  walkthroughLabel?: WalkthroughMediaLabel;
  sessionTitle?: string;
  description?: string;
  at?: string;
  commentSessionId?: string;
  regionAnnotations?: ImageRegionAnnotation[];
  onRegionComment?: (request: {
    region: ImageRegion;
    text: string;
    keepOpen: boolean;
    existing?: ImageRegionAnnotation;
  }) => void | Promise<void>;
  onDeleteRegionComment?: (
    annotation: ImageRegionAnnotation,
  ) => void | Promise<void>;
}

export interface LightboxRequest {
  items: LightboxItem[];
  index: number;
  origin?: HTMLElement;
  startCommenting?: boolean;
}

let host: ((request: LightboxRequest) => void) | null = null;

export function registerLightboxHost(
  open: (request: LightboxRequest) => void,
): () => void {
  host = open;
  return () => {
    if (host === open) host = null;
  };
}

export function mediaElement(origin?: Element | null): HTMLElement | undefined {
  if (typeof HTMLElement === "undefined" || !(origin instanceof HTMLElement)) {
    return undefined;
  }
  if (origin.matches("img, video")) return origin;
  return origin.querySelector<HTMLElement>("img, video") || origin;
}

function commentSessionIdFor(element?: Element | null): string | undefined {
  return element?.closest<HTMLElement>("[data-lightbox-session-id]")?.dataset
    .lightboxSessionId;
}

export function openLightbox(
  items: (LightboxItem | WorkspaceMediaItem)[],
  index: number,
  origin?: Element | null,
  options: { startCommenting?: boolean } = {},
) {
  const source = mediaElement(origin);
  const fromDom = commentSessionIdFor(source);
  host?.({
    items: items.map((item) => {
      if (item.kind !== "image") return item;
      const commentSessionId =
        ("commentSessionId" in item ? item.commentSessionId : undefined) ||
        ("sessionId" in item ? item.sessionId : undefined) ||
        fromDom;
      return commentSessionId ? { ...item, commentSessionId } : item;
    }),
    index,
    origin: source,
    startCommenting: options.startCommenting,
  });
}

const GALLERY_SELECTOR = "img.md-image, video.md-video, .md-mermaid > svg";

function galleryItem(node: Element): LightboxItem | null {
  if (node.tagName === "IMG" || node.tagName === "VIDEO") {
    const media = node as HTMLImageElement | HTMLVideoElement;
    return {
      kind: node.tagName === "VIDEO" ? "video" : "image",
      src:
        node.tagName === "IMG"
          ? (media as HTMLImageElement).currentSrc || media.src
          : media.src,
      commentSessionId:
        node.tagName === "IMG" ? commentSessionIdFor(node) : undefined,
      sessionTitle: (node as HTMLImageElement).alt?.trim() || undefined,
    };
  }
  const diagram = readDiagramSvg(node.outerHTML);
  return diagram
    ? { kind: "diagram", src: diagramDataUrl(diagram.svg), diagram }
    : null;
}

export function openGalleryFrom(el: Element) {
  const shown = Array.from(document.querySelectorAll(GALLERY_SELECTOR)).flatMap(
    (node) => {
      const item = galleryItem(node);
      return item ? [{ node, item }] : [];
    },
  );
  if (shown.length === 0) return;
  openLightbox(
    shown.map((entry) => entry.item),
    Math.max(
      0,
      shown.findIndex((entry) => entry.node === el),
    ),
    el,
  );
}
