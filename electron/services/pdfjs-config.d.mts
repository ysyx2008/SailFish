export function resolvePdfjsAssetUrls(): { cMapUrl: string; standardFontDataUrl: string }

export function buildPdfDocumentInit(
  data: Uint8Array | Buffer,
  extra?: Record<string, unknown>
): Record<string, unknown>
