import path from 'path';

export const DEFAULT_EXTRA_CONFIG_PATHS = ['/etc/nginx/sites-available/*'];

const IGNORED_INCLUDE_TOKENS = [
  'mime.types',
  'fastcgi_params',
  'uwsgi_params',
  'scgi_params',
  'proxy_params',
  'snippets/',
  'modules-enabled/',
];

/**
 * Parse active (non-commented) `include` directives from nginx.conf.
 * Always reflects the actual content of nginx.conf.
 */
export function extractIncludePathsFromNginxConf(mainConf: string): string[] {
  const results: string[] = [];
  for (const rawLine of mainConf.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^include\s+([^;\s]+)\s*;/);
    if (!match?.[1]) continue;
    const inc = match[1].trim();
    if (IGNORED_INCLUDE_TOKENS.some((tok) => inc.includes(tok))) continue;
    if (!results.includes(inc)) {
      results.push(inc);
    }
  }
  return results;
}

/**
 * Convert a glob pattern or directory path like:
 * - `/etc/nginx/conf.d/*.conf` -> `/etc/nginx/conf.d`
 * - `/etc/nginx/sites-available/*` -> `/etc/nginx/sites-available`
 * - `/etc/nginx/sites-available/` -> `/etc/nginx/sites-available`
 */
export function patternToBaseDir(pattern: string): string {
  const clean = pattern.trim().replace(/\/+$/, '');
  if (!clean) return '';
  const base = path.posix.basename(clean);
  if (base.includes('*') || base.includes('?') || base.endsWith('.conf')) {
    return path.posix.dirname(clean);
  }
  return clean;
}

/**
 * Extract `{ baseDir, glob }` from an include/extra path pattern.
 */
export function patternToFileGlob(pattern: string): { baseDir: string; glob: string } {
  const clean = pattern.trim().replace(/\/+$/, '');
  if (!clean) return { baseDir: '', glob: '*' };
  const base = path.posix.basename(clean);
  if (base.includes('*') || base.includes('?')) {
    return { baseDir: path.posix.dirname(clean), glob: base };
  }
  if (base.endsWith('.conf')) {
    return { baseDir: path.posix.dirname(clean), glob: base };
  }
  return { baseDir: clean, glob: '*' };
}

/**
 * Collect unique selectable directory paths from both nginx.conf includes and extra managed paths.
 */
export function collectManagedDirectories(
  nginxIncludePatterns: string[],
  extraConfigPaths: string[]
): string[] {
  const dirs: string[] = [];
  for (const pat of [...nginxIncludePatterns, ...extraConfigPaths]) {
    const dir = patternToBaseDir(pat);
    if (dir && !dirs.includes(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Map an absolute remote config path into a relative path inside the mirror directory.
 * Paths under `/etc/nginx/` map directly (e.g. `sites-available/minimal-chat`).
 * External paths map under `_ext/...`.
 */
export function toMirrorRelativePath(absPath: string): string {
  const normalized = path.posix.normalize(absPath.trim());
  if (normalized === '/etc/nginx') return '';
  if (normalized.startsWith('/etc/nginx/')) {
    return normalized.slice('/etc/nginx/'.length);
  }
  return `_ext/${normalized.replace(/^\/+/, '')}`;
}

/**
 * Normalize user-supplied extra path inputs into clean non-empty unique entries.
 */
export function normalizeExtraConfigPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const clean = raw.trim();
    if (!clean) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}
