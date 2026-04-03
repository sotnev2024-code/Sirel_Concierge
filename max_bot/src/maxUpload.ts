import type { Api } from '@maxhub/max-bot-api';

const MAX_FILE_UPLOAD_TIMEOUT_MS = 20000;

export type MaxFileAttachJson = { type: 'file'; payload: { token: string } };

function tokenFromMaxUploadBody(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const o = data as Record<string, unknown>;
  for (const key of ['token', 'file_token', 'access_token'] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  if (o.body && typeof o.body === 'object') return tokenFromMaxUploadBody(o.body);
  return undefined;
}

/** Multipart с явным именем файла (иначе Max показывает «ломанный» тип без .pdf / .xlsx). */
export async function uploadMaxFileWithFilename(
  api: Api,
  buffer: Buffer,
  filename: string,
): Promise<MaxFileAttachJson> {
  const { url: uploadUrl } = await api.raw.uploads.getUploadUrl({ type: 'file' });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MAX_FILE_UPLOAD_TIMEOUT_MS);
  try {
    const formData = new FormData();
    formData.append('data', new Blob([buffer]), filename);
    const res = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Max file upload HTTP ${res.status}: ${errText}`);
    }
    const body: unknown = await res.json();
    const token = tokenFromMaxUploadBody(body);
    if (!token) throw new Error('Max file upload: no token in response');
    return { type: 'file', payload: { token } };
  } finally {
    clearTimeout(timer);
  }
}
