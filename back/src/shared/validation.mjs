import { AppError } from './errors.mjs';

export function validateUrl(value, baseUrl) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 8192 ||
    !/^https?:\/\//i.test(value) ||
    /[^\x21-\x7e]|\\/.test(value)
  ) {
    throw new AppError(400, 'invalid_url');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(400, 'invalid_url');
  }
  const hostname = (url) => url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    hostname(parsed) === hostname(new URL(baseUrl))
  ) {
    throw new AppError(400, 'invalid_url');
  }
  return value;
}

export function parseBody(event) {
  const body = event.body ?? '';
  if (typeof body !== 'string') throw new AppError(400, 'invalid_json');
  // Reject oversized input before allocating a decoded copy.
  if (Buffer.byteLength(body, 'utf8') > (event.isBase64Encoded ? 21848 : 16384)) {
    throw new AppError(413, 'payload_too_large');
  }
  const bytes = Buffer.from(body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length > 16384) throw new AppError(413, 'payload_too_large');
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new AppError(400, 'invalid_json');
  }
}
