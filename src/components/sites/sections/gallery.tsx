/**
 * Gallery section — responsive image grid. Accepts either
 * `{ src, alt? }` objects or raw string URLs (both shapes are supported
 * in SiteBrief.sections[].images). No click-through instrumentation —
 * analytics is emitted by the final deployed template, not the preview.
 */

import type { BriefSection } from "@/lib/sites";

type ImageShape = { src: string; alt?: string };

function normalize(entry: string | ImageShape | undefined): ImageShape | null {
  if (!entry) return null;
  if (typeof entry === "string") {
    return entry ? { src: entry } : null;
  }
  if (typeof entry === "object" && typeof entry.src === "string" && entry.src) {
    return { src: entry.src, alt: entry.alt };
  }
  return null;
}

export interface GallerySectionProps {
  section: BriefSection;
}

export function GallerySection({ section }: GallerySectionProps) {
  const { heading, images } = section;
  const normalized = (images ?? [])
    .map(normalize)
    .filter((i): i is ImageShape => i !== null);

  return (
    <section
      data-testid="gallery-section"
      data-section-type="gallery"
      className="mx-auto w-full max-w-6xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-5 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}

      {normalized.length === 0 ? (
        <div
          data-testid="gallery-empty"
          className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500"
        >
          No images yet — drop images in the editor to populate the gallery.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {normalized.map((img, idx) => (
            <div
              key={`${img.src}-${idx}`}
              data-testid="gallery-item"
              className="overflow-hidden rounded-md bg-neutral-100"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.src}
                alt={img.alt ?? ""}
                className="h-60 w-full object-cover"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default GallerySection;
