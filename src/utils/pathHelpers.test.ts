import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIncludePathsFromNginxConf,
  patternToBaseDir,
  patternToFileGlob,
  collectManagedDirectories,
  toMirrorRelativePath,
  normalizeExtraConfigPaths,
} from './pathHelpers';

test('extractIncludePathsFromNginxConf reads active includes and ignores comments and mime.types', () => {
  const conf = `
user www-data;
http {
    include /etc/nginx/mime.types;
    # include /etc/nginx/disabled/*.conf;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
    include /etc/nginx/custom-vhosts/*.conf;
}
`;
  assert.deepEqual(extractIncludePathsFromNginxConf(conf), [
    '/etc/nginx/conf.d/*.conf',
    '/etc/nginx/sites-enabled/*',
    '/etc/nginx/custom-vhosts/*.conf',
  ]);
});

test('patternToBaseDir and patternToFileGlob handle globs, directories, and trailing slashes', () => {
  assert.equal(patternToBaseDir('/etc/nginx/sites-available/*'), '/etc/nginx/sites-available');
  assert.equal(patternToBaseDir('/etc/nginx/conf.d/*.conf'), '/etc/nginx/conf.d');
  assert.equal(patternToBaseDir('/etc/nginx/sites-available/'), '/etc/nginx/sites-available');

  assert.deepEqual(patternToFileGlob('/etc/nginx/conf.d/*.conf'), {
    baseDir: '/etc/nginx/conf.d',
    glob: '*.conf',
  });
  assert.deepEqual(patternToFileGlob('/etc/nginx/sites-available/*'), {
    baseDir: '/etc/nginx/sites-available',
    glob: '*',
  });
  assert.deepEqual(patternToFileGlob('/etc/nginx/sites-available'), {
    baseDir: '/etc/nginx/sites-available',
    glob: '*',
  });
});

test('collectManagedDirectories deduplicates across nginx.conf includes and extra paths', () => {
  const dirs = collectManagedDirectories(
    ['/etc/nginx/conf.d/*.conf', '/etc/nginx/sites-enabled/*'],
    ['/etc/nginx/sites-available/*', '/etc/nginx/sites-enabled/*', '/opt/nginx/sites/*']
  );
  assert.deepEqual(dirs, [
    '/etc/nginx/conf.d',
    '/etc/nginx/sites-enabled',
    '/etc/nginx/sites-available',
    '/opt/nginx/sites',
  ]);
});

test('toMirrorRelativePath handles /etc/nginx and external paths cleanly', () => {
  assert.equal(
    toMirrorRelativePath('/etc/nginx/sites-available/minimal-chat'),
    'sites-available/minimal-chat'
  );
  assert.equal(toMirrorRelativePath('/opt/nginx/sites/app'), '_ext/opt/nginx/sites/app');
});

test('normalizeExtraConfigPaths trims and deduplicates', () => {
  assert.deepEqual(
    normalizeExtraConfigPaths([' /etc/nginx/sites-available/* ', '', '/etc/nginx/sites-available/*']),
    ['/etc/nginx/sites-available/*']
  );
});
