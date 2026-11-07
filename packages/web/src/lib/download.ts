import { accessToken } from './auth';

/** Downloads an authorized file: fetch with the token, then save it under the server's file name. */
export async function download(path: string): Promise<{ fileName: string; size: number }> {
  const response = await fetch(`/api/v1${path}`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Download failed (${response.status}).`);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const fileName =
    decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] ?? '') ||
    /filename="([^"]+)"/.exec(disposition)?.[1] ||
    'export';
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { fileName, size: blob.size };
}
