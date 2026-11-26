import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSudoGroupMembership,
  parseVerifyProbeOutput,
  buildSshPoolKey,
} from './sshManager';

test('hasSudoGroupMembership returns true for root regardless of groups output', () => {
  assert.equal(hasSudoGroupMembership('root', 'root'), true);
});

test('hasSudoGroupMembership detects sudo group accurately without substring false positives', () => {
  assert.equal(hasSudoGroupMembership('ubuntu', 'ubuntu adm cdrom sudo dip plugdev'), true);
  assert.equal(hasSudoGroupMembership('testuser', 'sudo'), true);
  assert.equal(hasSudoGroupMembership('guest', 'guest sudoers users'), false);
  assert.equal(hasSudoGroupMembership('guest', 'guest www-data'), false);
  assert.equal(hasSudoGroupMembership('guest', ''), false);
});

test('parseVerifyProbeOutput parses combined single-round-trip probe accurately', () => {
  const stdout = `
---OS---
PRETTY_NAME="Ubuntu 22.04.4 LTS"
---NGINX---
/usr/sbin/nginx
---GROUPS---
testuser adm sudo
---VERSION---
nginx version: nginx/1.24.0 (Ubuntu)
`;
  const ok = parseVerifyProbeOutput('testuser', stdout);
  assert.equal(ok.ok, true);
  assert.equal(ok.osType, 'Ubuntu 22.04.4 LTS');
  assert.equal(ok.nginxBin, '/usr/sbin/nginx');
  assert.equal(ok.nginxVersion, '1.24.0');

  const noSudo = parseVerifyProbeOutput(
    'guest',
    stdout.replace('testuser adm sudo', 'guest www-data')
  );
  assert.equal(noSudo.ok, false);
  assert.ok(noSudo.error?.includes('不属于 sudo 组'));

  const noNginx = parseVerifyProbeOutput(
    'root',
    stdout.replace('nginx version: nginx/1.24.0 (Ubuntu)', 'sh: nginx: not found')
  );
  assert.equal(noNginx.ok, false);
  assert.ok(noNginx.error?.includes('未检测到可用的 Nginx'));
});

test('buildSshPoolKey isolates different credentials and avoids leaking raw passwords', () => {
  const k1 = buildSshPoolKey({ host: '10.0.0.1', port: 22, username: 'u1', password: 'secret-a' });
  const k2 = buildSshPoolKey({ host: '10.0.0.1', port: 22, username: 'u1', password: 'secret-b' });
  const k3 = buildSshPoolKey({ host: '10.0.0.1', port: 22, username: 'u1', password: 'secret-a' });
  assert.equal(k1, k3);
  assert.notEqual(k1, k2);
  assert.equal(k1.includes('secret-a'), false);
});

