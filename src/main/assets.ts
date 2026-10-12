import { promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { net, type WebContents } from 'electron';
import { IMAGE_TYPES } from './assetNames';

// Bigger files stay linked rather than bloating the export (and the IPC
// message) with a base64 copy.
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  ogv: 'video/ogg',
  webm: 'video/webm',
};

const FONT_TYPES: Record<string, string> = {
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function typeOf(filePath: string, types: Record<string, string>): string | undefined {
  return types[extname(filePath).slice(1).toLowerCase()];
}

/**
 * The file a mditor://local/<path> URL (the document's images and media, as
 * the preview loads them) names. Null for a Windows network path
 * (\\host\share): reading one has Windows connect to that host and sign in.
 */
export function mditorPath(url: URL): string | null {
  const filePath = decodeURIComponent(url.pathname);
  if (process.platform !== 'win32') return filePath;
  if (/^[\\/]{2}/.test(filePath)) return null;
  return /^\/[a-z]:/i.test(filePath) ? filePath.slice(1) : filePath;
}

async function readFileCapped(filePath: string): Promise<Buffer | null> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return null;
  return fs.readFile(filePath);
}

function dataUrl(type: string, data: Buffer | null): string | null {
  return data ? `data:${type};base64,${data.toString('base64')}` : null;
}

/**
 * Read a file the renderer wants embedded in an export, as a data: URL. Only
 * two kinds of URL are served: the document's images and media as the
 * preview loads them (mditor://), and the app's own bundled assets, such as
 * KaTeX's fonts, under the page's own location (file: when packaged, the dev
 * server in development). Anything else, an unexpected file type, a missing
 * or oversized file resolves to null, and the caller keeps its link.
 */
export async function readAssetDataUrl(
  sender: Pick<WebContents, 'getURL'>,
  url: unknown,
): Promise<string | null> {
  if (typeof url !== 'string') return null;
  try {
    const target = new URL(url);
    if (target.protocol === 'mditor:') {
      const filePath = mditorPath(target);
      if (filePath === null) return null;
      const type = typeOf(filePath, MEDIA_TYPES);
      return type ? dataUrl(type, await readFileCapped(filePath)) : null;
    }

    // URL parsing has already folded any `..`, so a prefix check keeps this
    // inside the app's own directory (or dev server).
    const appRoot = new URL('.', sender.getURL());
    if (target.protocol !== appRoot.protocol || !target.href.startsWith(appRoot.href)) return null;
    const type = typeOf(target.pathname, MEDIA_TYPES) ?? typeOf(target.pathname, FONT_TYPES);
    if (!type) return null;
    if (target.protocol === 'file:') return dataUrl(type, await readFileCapped(fileURLToPath(target)));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    const response = await net.fetch(target.href);
    // The dev server answers a missing file with its index.html.
    if (!response.ok || /^text\/html/i.test(response.headers.get('content-type') ?? '')) {
      return null;
    }
    const data = Buffer.from(await response.arrayBuffer());
    return data.length > MAX_ASSET_BYTES ? null : dataUrl(type, data);
  } catch {
    return null;
  }
}
