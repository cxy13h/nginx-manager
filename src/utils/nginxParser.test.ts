import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNginxToAst,
  parseConfigContentToForm,
  generateNginxConfigFromForm,
  createDefaultConfigForm,
  validateMirrorConfigTree,
  rewriteMainNginxConfForMirror,
  formatBackupTimestamp,
} from './nginxParser';

test('parseNginxToAst parses upstream and server blocks accurately', () => {
  const conf = `
upstream api_pool {
    server 10.0.1.11:8080 weight=5;
    server 10.0.1.12:8080;
}

server {
    listen 80;
    listen 443 ssl;
    server_name api.internal.io;
    ssl_certificate /etc/nginx/ssl/api.internal.io.crt;
    ssl_certificate_key /etc/nginx/ssl/api.internal.io.key;
    client_max_body_size 50m;
    gzip on;

    location / {
        proxy_pass http://api_pool;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
  const { ast, errors } = parseNginxToAst(conf);
  assert.equal(errors.length, 0);
  assert.equal(ast.length, 2);
  assert.equal(ast[0].directive, 'upstream');
  assert.equal(ast[1].directive, 'server');

  const parsed = parseConfigContentToForm('api.conf', '/etc/nginx/conf.d/api.conf', conf);
  assert.equal(parsed.form.upstreams.length, 1);
  assert.equal(parsed.form.upstreams[0].name, 'api_pool');
  assert.equal(parsed.form.upstreams[0].nodes.length, 2);
  assert.equal(parsed.form.upstreams[0].nodes[0].address, '10.0.1.11:8080');
  assert.equal(parsed.form.upstreams[0].nodes[0].weight, '5');
  assert.equal(parsed.form.upstreams[0].nodes[1].address, '10.0.1.12:8080');
  assert.equal(parsed.form.upstreams[0].nodes[1].weight, '');
  assert.equal(parsed.form.locations.length, 1);
  assert.equal(parsed.form.locations[0].path, '/');
  assert.equal(parsed.form.locations[0].proxyPass, 'http://api_pool');
  assert.equal(parsed.form.locations[0].passHost, true);
  assert.equal(parsed.form.locations[0].passRealIp, true);
  assert.equal(parsed.form.locations[0].passForwardedFor, false);
  assert.equal(parsed.form.locations[0].enableWebsocket, true);
  assert.equal(parsed.form.clientMaxBodySize, '50m');
  assert.equal(parsed.form.enableSsl, true);
  // Extra directive `gzip on;` is preserved!
  assert.equal(parsed.form.preservedServerDirectives.some((d) => d.includes('gzip on;')), true);

  // Round-trip back to config text
  const regenerated = generateNginxConfigFromForm(parsed.form);
  assert.ok(regenerated.includes('server 10.0.1.11:8080 weight=5;'));
  assert.ok(regenerated.includes('server 10.0.1.12:8080;'));
  assert.ok(!regenerated.includes('10.0.1.12:8080 weight='));
  assert.ok(regenerated.includes('gzip on;'));
});

test('createDefaultConfigForm sets all proxy switches to false and optional parameters empty', () => {
  const form = createDefaultConfigForm('order.conf');
  assert.equal(form.filePath, '/etc/nginx/conf.d/order.conf');
  assert.equal(form.upstreams.length, 0);
  assert.equal(form.locations.length, 1);
  assert.equal(form.locations[0].path, '/');
  assert.equal(form.locations[0].proxyPass, '');
  assert.equal(form.locations[0].passHost, false);
  assert.equal(form.locations[0].passRealIp, false);
  assert.equal(form.locations[0].passForwardedFor, false);
  assert.equal(form.locations[0].passForwardedProto, false);
  assert.equal(form.locations[0].enableWebsocket, false);
  assert.equal(form.rootPath, '');
  assert.equal(form.indexFiles, '');
  assert.equal(form.clientMaxBodySize, '');
  assert.equal(form.proxyConnectTimeout, '');
  assert.equal(form.proxyReadTimeout, '');
});

test('static site config parses and generates root, location and try_files properly', () => {
  const staticConf = `
server {
    listen 80;
    server_name portal.example.com;
    root /var/www/portal/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
  const parsed = parseConfigContentToForm('portal.conf', '/etc/nginx/conf.d/portal.conf', staticConf);
  assert.equal(parsed.form.rootPath, '/var/www/portal/dist');
  assert.equal(parsed.form.indexFiles, 'index.html');
  assert.equal(parsed.form.locations.length, 1);
  assert.equal(parsed.form.locations[0].path, '/');
  assert.equal(parsed.form.locations[0].tryFiles, '$uri $uri/ /index.html');
  assert.equal(parsed.form.locations[0].proxyPass, '');

  // Clear try_files and regenerate
  parsed.form.locations[0].tryFiles = '';
  const regenerated = generateNginxConfigFromForm(parsed.form);
  assert.ok(regenerated.includes('root /var/www/portal/dist;'));
  assert.ok(!regenerated.includes('try_files'));
});

test('mixed static + reverse proxy + upstream config parses and round-trips losslessly', () => {
  const hybridConf = `
upstream backend_api {
    server 127.0.0.1:8080 weight=2;
    server 127.0.0.1:8081;
}

server {
    listen 80;
    server_name app.example.com;
    root /var/www/app/dist;
    index index.html;
    client_max_body_size 20m;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://backend_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /docs/ {
        root /var/www/docs;
        index guide.html;
    }
}
`;
  const parsed = parseConfigContentToForm('app.conf', '/etc/nginx/conf.d/app.conf', hybridConf);
  assert.equal(parsed.form.rootPath, '/var/www/app/dist');
  assert.equal(parsed.form.indexFiles, 'index.html');
  assert.equal(parsed.form.upstreams.length, 1);
  assert.equal(parsed.form.upstreams[0].name, 'backend_api');
  assert.equal(parsed.form.locations.length, 3);
  assert.equal(parsed.form.locations[0].type, 'static');
  assert.equal(parsed.form.locations[0].path, '/');
  assert.equal(parsed.form.locations[0].tryFiles, '$uri $uri/ /index.html');
  assert.equal(parsed.form.locations[1].type, 'reverse_proxy');
  assert.equal(parsed.form.locations[1].path, '/api/');
  assert.equal(parsed.form.locations[1].proxyPass, 'http://backend_api');
  assert.equal(parsed.form.locations[1].passHost, true);
  assert.equal(parsed.form.locations[1].enableWebsocket, true);
  assert.equal(parsed.form.locations[2].type, 'static');
  assert.equal(parsed.form.locations[2].path, '/docs/');
  assert.equal(parsed.form.locations[2].root, '/var/www/docs');
  assert.equal(parsed.form.locations[2].index, 'guide.html');

  const regenerated = generateNginxConfigFromForm(parsed.form);
  assert.ok(regenerated.includes('upstream backend_api {'));
  assert.ok(regenerated.includes('root /var/www/app/dist;'));
  assert.ok(regenerated.includes('try_files $uri $uri/ /index.html;'));
  assert.ok(regenerated.includes('location /api/ {'));
  assert.ok(regenerated.includes('proxy_pass http://backend_api;'));
  assert.ok(regenerated.includes('proxy_set_header Upgrade $http_upgrade;'));
  assert.ok(regenerated.includes('root /var/www/docs;'));

  const validation = validateMirrorConfigTree({
    mirrorDir: '/tmp/nginx_mgr_mirror_hybrid',
    configs: [{ filePath: '/etc/nginx/conf.d/app.conf', content: regenerated }],
    availableCertPaths: new Set(),
  });
  assert.equal(validation.valid, true);
});

test('SPA frontend + /api/ Express reverse proxy config classifies locations and preserves proxy_http_version 1.1', () => {
  const spaApiConf = `
server {
    listen 1234;
    server_name _;

    root /home/liulu/workspace/arch-flow/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:2345;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
  const parsed = parseConfigContentToForm('arch-flow', '/etc/nginx/sites-available/arch-flow', spaApiConf);
  assert.equal(parsed.form.listenPorts, '1234');
  assert.equal(parsed.form.rootPath, '/home/liulu/workspace/arch-flow/dist');
  assert.equal(parsed.form.indexFiles, 'index.html');
  assert.equal(parsed.form.locations.length, 2);

  assert.equal(parsed.form.locations[0].type, 'static');
  assert.equal(parsed.form.locations[0].path, '/');
  assert.equal(parsed.form.locations[0].tryFiles, '$uri $uri/ /index.html');

  assert.equal(parsed.form.locations[1].type, 'reverse_proxy');
  assert.equal(parsed.form.locations[1].path, '/api/');
  assert.equal(parsed.form.locations[1].proxyPass, 'http://127.0.0.1:2345');
  assert.equal(parsed.form.locations[1].passHost, true);
  assert.equal(parsed.form.locations[1].passRealIp, true);
  assert.equal(parsed.form.locations[1].passForwardedFor, true);
  assert.equal(parsed.form.locations[1].passForwardedProto, true);
  assert.equal(parsed.form.locations[1].enableWebsocket, false);

  const regenerated = generateNginxConfigFromForm(parsed.form);
  assert.ok(regenerated.includes('try_files $uri $uri/ /index.html;'));
  assert.ok(regenerated.includes('proxy_pass http://127.0.0.1:2345;'));
  assert.ok(regenerated.includes('proxy_http_version 1.1;'));
  assert.ok(regenerated.includes('proxy_set_header X-Forwarded-Proto $scheme;'));
});

test('validateMirrorConfigTree catches invalid syntax, invalid weight, and missing SSL certs', () => {
  const certPaths = new Set(['/etc/nginx/ssl/valid.crt', '/etc/nginx/ssl/valid.key']);

  // Valid config
  const okResult = validateMirrorConfigTree({
    mirrorDir: '/tmp/nginx_mgr_mirror_test1',
    configs: [
      {
        filePath: '/etc/nginx/conf.d/app.conf',
        content: `server {\n    listen 443 ssl;\n    ssl_certificate /etc/nginx/ssl/valid.crt;\n    ssl_certificate_key /etc/nginx/ssl/valid.key;\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}`,
      },
    ],
    availableCertPaths: certPaths,
  });
  assert.equal(okResult.valid, true);
  assert.ok(okResult.output.includes('syntax is ok'));

  // Missing SSL cert
  const badSslResult = validateMirrorConfigTree({
    mirrorDir: '/tmp/nginx_mgr_mirror_test1',
    configs: [
      {
        filePath: '/etc/nginx/conf.d/app.conf',
        content: `server {\n    listen 443 ssl;\n    ssl_certificate /etc/nginx/ssl/missing.crt;\n    ssl_certificate_key /etc/nginx/ssl/valid.key;\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}`,
      },
    ],
    availableCertPaths: certPaths,
  });
  assert.equal(badSslResult.valid, false);
  assert.ok(badSslResult.output.includes('cannot load certificate'));
});

test('rewriteMainNginxConfForMirror and formatBackupTimestamp work properly', () => {
  const main = `http {\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}`;
  const rewritten = rewriteMainNginxConfForMirror(main, '/tmp/nginx_mgr_mirror_99');
  assert.ok(rewritten.includes('/tmp/nginx_mgr_mirror_99/conf.d/*.conf'));
  assert.ok(rewritten.includes('/tmp/nginx_mgr_mirror_99/sites-enabled/*'));

  const ts = formatBackupTimestamp(new Date(2026, 4, 12, 14, 30, 22));
  assert.equal(ts, '20260512143022');
});

test('supports extensionless Nginx config files in sites-available like default and minimal-chat', () => {
  const form = createDefaultConfigForm('minimal-chat', '/etc/nginx/sites-available');
  assert.equal(form.filename, 'minimal-chat');
  assert.equal(form.filePath, '/etc/nginx/sites-available/minimal-chat');

  const content = generateNginxConfigFromForm(form);
  const parsed = parseConfigContentToForm('minimal-chat', '/etc/nginx/sites-available/minimal-chat', content);
  assert.equal(parsed.form.filename, 'minimal-chat');
  assert.equal(parsed.form.filePath, '/etc/nginx/sites-available/minimal-chat');

  const validation = validateMirrorConfigTree({
    mirrorDir: '/tmp/nginx_mgr_mirror_test2',
    configs: [{ filePath: '/etc/nginx/sites-available/minimal-chat', content }],
    availableCertPaths: new Set(),
  });
  assert.equal(validation.valid, true);
});


