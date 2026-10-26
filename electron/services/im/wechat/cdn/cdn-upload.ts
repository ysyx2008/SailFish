import { encryptAesEcb } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";
import { logger } from "../util/logger.js";
import { redactUrl } from "../util/redact.js";

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3;

/** Minimum wall-clock timeout per upload attempt. */
const UPLOAD_TIMEOUT_MIN_MS = 60_000;
/** Extra timeout budget per 64 KB of ciphertext (upload + server processing). */
const UPLOAD_TIMEOUT_PER_64K_MS = 5_000;
/** Response wait slack after the full body is sent. */
const UPLOAD_TIMEOUT_RESPONSE_MS = 30_000;

function uploadAttemptTimeoutMs(ciphertextSize: number): number {
  const chunks = Math.max(1, Math.ceil(ciphertextSize / (64 * 1024)));
  return Math.max(
    UPLOAD_TIMEOUT_MIN_MS,
    chunks * UPLOAD_TIMEOUT_PER_64K_MS + UPLOAD_TIMEOUT_RESPONSE_MS,
  );
}

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 * Retries up to UPLOAD_MAX_RETRIES times on server errors; client errors (4xx) abort immediately.
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  /** From getUploadUrl.upload_full_url; POST target when set (takes precedence over uploadParam). */
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(`${label}: CDN upload URL missing (need upload_full_url or upload_param)`);
  }
  logger.debug(`${label}: CDN POST url=${redactUrl(cdnUrl)} ciphertextSize=${ciphertext.length}`);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const timeoutMs = uploadAttemptTimeoutMs(ciphertext.length);
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: ciphertext,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        logger.error(
          `${label}: CDN client error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const bodySnippet = (await res.text()).slice(0, 200);
        const errMsg =
          res.headers.get("x-error-message") ??
          (bodySnippet ? `status ${res.status} body=${bodySnippet}` : `status ${res.status}`);
        logger.error(
          `${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        logger.error(`${label}: CDN response missing x-encrypted-param header attempt=${attempt}`);
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      logger.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      const cause =
        (err as NodeJS.ErrnoException).cause ?? (err as NodeJS.ErrnoException).code ?? "";
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.error(
          `${label}: attempt ${attempt} failed, retrying... url=${redactUrl(cdnUrl)} error=${String(err)}${cause ? ` cause=${cause}` : ""}`,
        );
      } else {
        logger.error(
          `${label}: all ${UPLOAD_MAX_RETRIES} attempts failed url=${redactUrl(cdnUrl)} error=${String(err)}${cause ? ` cause=${cause}` : ""}`,
        );
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}
