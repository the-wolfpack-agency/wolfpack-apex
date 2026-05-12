/**
 * Client-side QR download helpers.
 *
 * Given a QR SVG string + a slug, save it to disk in any of the
 * formats the team actually needs for printing and digital share:
 *
 *   .svg  — vector, scales to any size; best for print files
 *   .png  — transparent-friendly raster; best for slides + web
 *   .jpg  — compressed raster with a white background; best for
 *           email and platforms that reject PNG transparency
 *   .pdf  — single-page Letter PDF with the QR centered; best for
 *           handouts, business cards, and one-off prints
 *
 * Pure client-side. Uses Canvas for raster conversion and a tiny
 * inline PDF 1.4 builder for the PDF format. No new npm deps.
 */

export type QrFormat = "svg" | "png" | "jpg" | "pdf";

export const QR_FORMATS: { label: string; value: QrFormat }[] = [
  { label: "SVG (vector)", value: "svg" },
  { label: "PNG (transparent)", value: "png" },
  { label: "JPG (white background)", value: "jpg" },
  { label: "PDF (printable Letter page)", value: "pdf" },
];

export const QR_RASTER_SIZES = [256, 512, 1024, 2048] as const;
export type QrRasterSize = (typeof QR_RASTER_SIZES)[number];

export interface DownloadArgs {
  svg: string;
  slug: string;
  format: QrFormat;
  /** Pixel side for PNG/JPG. Default 1024. Ignored for SVG and PDF. */
  size?: QrRasterSize;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function downloadQr(args: DownloadArgs): Promise<void> {
  if (typeof window === "undefined") return;
  const filename = `qr-${args.slug}.${args.format}`;
  switch (args.format) {
    case "svg":
      return saveBlob(
        new Blob([args.svg], { type: "image/svg+xml" }),
        filename,
      );
    case "png": {
      const blob = await rasterize(args.svg, args.size ?? 1024, "image/png");
      return saveBlob(blob, filename);
    }
    case "jpg": {
      const blob = await rasterize(args.svg, args.size ?? 1024, "image/jpeg");
      return saveBlob(blob, filename);
    }
    case "pdf": {
      const jpeg = await rasterize(args.svg, 1024, "image/jpeg");
      const pdf = await buildPdf(jpeg, args.slug);
      return saveBlob(pdf, filename);
    }
  }
}

/* ------------------------------------------------------------------ */
/* SVG → raster                                                        */
/* ------------------------------------------------------------------ */

async function rasterize(
  svg: string,
  size: number,
  mime: "image/png" | "image/jpeg",
): Promise<Blob> {
  /* Force a fixed render size onto the SVG so the canvas is always
     `size x size`, regardless of how the SVG was authored. */
  const sized = svg.replace(
    /<svg([^>]*)>/,
    `<svg$1 width="${size}" height="${size}">`,
  );
  const blobUrl = URL.createObjectURL(
    new Blob([sized], { type: "image/svg+xml" }),
  );
  try {
    const img = await loadImage(blobUrl);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas-2d unavailable");
    /* JPEG has no alpha channel; pre-fill white so the QR doesn't
       come out on a black background. PNG keeps the transparent bg. */
    if (mime === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
    }
    ctx.drawImage(img, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob null"))),
        mime,
        mime === "image/jpeg" ? 0.95 : undefined,
      );
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("svg image decode failed"));
    img.src = src;
  });
}

/* ------------------------------------------------------------------ */
/* JPEG → minimal single-page PDF (8.5" x 11" Letter)                  */
/* ------------------------------------------------------------------ */

/**
 * Build a one-page PDF (Letter, 612x792 points) with the QR centered
 * at 4" x 4" and the slug as a small caption. Hand-rolled per the
 * PDF 1.4 spec; saves us from pulling in a 50KB+ PDF library.
 */
async function buildPdf(jpeg: Blob, slug: string): Promise<Blob> {
  const jpegBytes = new Uint8Array(await jpeg.arrayBuffer());
  const pageW = 612;
  const pageH = 792;
  const qrSide = 288; // 4 inches
  const qrX = (pageW - qrSide) / 2;
  const qrY = (pageH - qrSide) / 2;

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  const push = (s: string | Uint8Array) => {
    const bytes = typeof s === "string" ? enc.encode(s) : s;
    chunks.push(bytes);
    cursor += bytes.length;
  };
  const startObj = (n: number) => {
    offsets[n] = cursor;
    push(`${n} 0 obj\n`);
  };
  const endObj = () => push(`\nendobj\n`);

  push("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");

  /* 1: Catalog */
  startObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>");
  endObj();

  /* 2: Pages */
  startObj(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  endObj();

  /* 3: Page (references Im0 + F1) */
  startObj(3);
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> ` +
      `/Contents 4 0 R >>`,
  );
  endObj();

  /* 4: Content stream — draw the image + caption */
  const safeSlug = slug.replace(/[()\\]/g, "");
  const stream =
    `q\n${qrSide} 0 0 ${qrSide} ${qrX} ${qrY} cm\n/Im0 Do\nQ\n` +
    `BT /F1 10 Tf ${qrX} ${qrY - 18} Td (qr-${safeSlug}) Tj ET\n`;
  const streamBytes = enc.encode(stream);
  startObj(4);
  push(`<< /Length ${streamBytes.length} >>\nstream\n`);
  push(streamBytes);
  push(`\nendstream`);
  endObj();

  /* 5: Image XObject — embed JPEG bytes via /DCTDecode */
  startObj(5);
  push(
    `<< /Type /XObject /Subtype /Image /Width 1024 /Height 1024 ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
  );
  push(jpegBytes);
  push(`\nendstream`);
  endObj();

  /* 6: Helvetica font for the caption */
  startObj(6);
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  endObj();

  /* xref */
  const xrefStart = cursor;
  push(`xref\n0 7\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i <= 6; i++) {
    push(`${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  /* Flatten chunks. */
  const total = chunks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of chunks) {
    out.set(b, off);
    off += b.length;
  }
   
  return new Blob([out as any], { type: "application/pdf" });
}

/* ------------------------------------------------------------------ */
/* Save helper                                                         */
/* ------------------------------------------------------------------ */

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
