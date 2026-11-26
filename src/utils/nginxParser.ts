export interface CrossplaneDirective {
  directive: string;
  line: number;
  args: string[];
  block?: CrossplaneDirective[];
}

export interface UpstreamNode {
  id: string;
  address: string;
  weight: string; // empty string means default round-robin (no weight= parameter)
}

export interface UpstreamBlock {
  id: string;
  name: string;
  nodes: UpstreamNode[];
}

export type LocationType = 'static' | 'reverse_proxy';

export interface LocationRule {
  id: string;
  type: LocationType;
  path: string;
  root: string; // optional location-level root
  index: string; // optional location-level index
  tryFiles: string; // empty string means no try_files directive
  proxyPass: string; // empty string means no proxy_pass directive
  passHost: boolean;
  passRealIp: boolean;
  passForwardedFor: boolean;
  passForwardedProto: boolean;
  enableWebsocket: boolean;
  extraDirectives?: string[];
}

export type ConfigSyncStatus = 'synced' | 'modified' | 'new' | 'deleted';

export interface NginxConfigForm {
  filename: string;
  filePath: string;
  listenPorts: string; // e.g. "80" or "80, 443"
  enableSsl: boolean;
  serverName: string; // e.g. "api.example.com" or ""
  sslCertificate: string;
  sslCertificateKey: string;

  // Optional server-level directives
  rootPath: string;
  indexFiles: string;
  clientMaxBodySize: string;
  proxyConnectTimeout: string;
  proxyReadTimeout: string;

  // Optional upstream pools
  upstreams: UpstreamBlock[];

  // Unified location rules (each location can configure static, reverse proxy, or both)
  locations: LocationRule[];

  // Preserved custom directives for lossless round-trip merging
  preservedTopDirectives: string[];
  preservedServerDirectives: string[];
}

export interface ParsedNginxConfigSummary {
  filename: string;
  filePath: string;
  listenPorts: string[];
  serverName: string; // "-" if empty
  syncStatus: ConfigSyncStatus;
  rawContent: string;
  form: NginxConfigForm;
  updatedAt: string;
}

export interface NginxTestResult {
  valid: boolean;
  command: string;
  output: string;
  errorLine?: number;
  errorFile?: string;
}

/**
 * Tokenize and parse Nginx configuration text into a Crossplane-compatible AST.
 */
export function parseNginxToAst(source: string): {
  ast: CrossplaneDirective[];
  errors: { line: number; message: string }[];
} {
  const errors: { line: number; message: string }[] = [];
  const tokens: { value: string; line: number; type: 'word' | 'lbrace' | 'rbrace' | 'semi' | 'comment' }[] = [];

  let i = 0;
  let line = 1;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comment
    if (ch === '#') {
      let commentText = '';
      while (i < len && source[i] !== '\n') {
        commentText += source[i];
        i++;
      }
      tokens.push({ value: commentText.trim(), line, type: 'comment' });
      continue;
    }

    if (ch === '{') {
      tokens.push({ value: '{', line, type: 'lbrace' });
      i++;
      continue;
    }

    if (ch === '}') {
      tokens.push({ value: '}', line, type: 'rbrace' });
      i++;
      continue;
    }

    if (ch === ';') {
      tokens.push({ value: ';', line, type: 'semi' });
      i++;
      continue;
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      let word = quote;
      i++;
      while (i < len && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < len) {
          word += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '\n') line++;
        word += source[i];
        i++;
      }
      if (i < len && source[i] === quote) {
        word += quote;
        i++;
      } else {
        errors.push({ line: startLine, message: `Unclosed quoted string starting at line ${startLine}` });
      }
      tokens.push({ value: word, line: startLine, type: 'word' });
      continue;
    }

    // Regular word token
    let word = '';
    const startLine = line;
    while (i < len && !/[\s{};#]/.test(source[i])) {
      word += source[i];
      i++;
    }
    if (word.length > 0) {
      tokens.push({ value: word, line: startLine, type: 'word' });
    }
  }

  let pos = 0;

  function parseBlock(isRoot: boolean): CrossplaneDirective[] {
    const directives: CrossplaneDirective[] = [];

    while (pos < tokens.length) {
      const tok = tokens[pos];

      if (tok.type === 'comment') {
        pos++;
        continue;
      }

      if (tok.type === 'rbrace') {
        if (isRoot) {
          errors.push({ line: tok.line, message: `unexpected "}" at line ${tok.line}` });
          pos++;
          continue;
        }
        pos++; // consume '}'
        return directives;
      }

      if (tok.type === 'lbrace' || tok.type === 'semi') {
        errors.push({ line: tok.line, message: `unexpected "${tok.value}" at line ${tok.line}` });
        pos++;
        continue;
      }

      // Must be a directive name
      const directiveName = tok.value;
      const directiveLine = tok.line;
      pos++;

      const args: string[] = [];
      while (pos < tokens.length) {
        const nextTok = tokens[pos];
        if (nextTok.type === 'comment') {
          pos++;
          continue;
        }
        if (nextTok.type === 'semi') {
          pos++; // consume ';'
          directives.push({
            directive: directiveName,
            line: directiveLine,
            args,
          });
          break;
        }
        if (nextTok.type === 'lbrace') {
          pos++; // consume '{'
          const childBlock = parseBlock(false);
          directives.push({
            directive: directiveName,
            line: directiveLine,
            args,
            block: childBlock,
          });
          break;
        }
        if (nextTok.type === 'rbrace') {
          errors.push({
            line: nextTok.line,
            message: `directive "${directiveName}" at line ${directiveLine} is not terminated by ";" before "}"`,
          });
          break;
        }
        args.push(nextTok.value);
        pos++;
      }

      if (pos >= tokens.length && directives[directives.length - 1]?.line !== directiveLine) {
        errors.push({
          line: directiveLine,
          message: `unexpected end of file, expecting ";" or "}" for directive "${directiveName}" at line ${directiveLine}`,
        });
      }
    }

    if (!isRoot) {
      const lastLine = tokens.length > 0 ? tokens[tokens.length - 1].line : 1;
      errors.push({ line: lastLine, message: `unexpected end of file, expecting "}"` });
    }

    return directives;
  }

  const ast = parseBlock(true);
  return { ast, errors };
}

/**
 * Serialize a CrossplaneDirective back to clean formatted Nginx directive text.
 */
export function serializeDirective(node: CrossplaneDirective, indent = ''): string {
  const argsStr = node.args.length > 0 ? ' ' + node.args.join(' ') : '';
  if (node.block) {
    const inner = node.block.map((child) => serializeDirective(child, indent + '    ')).join('\n');
    return `${indent}${node.directive}${argsStr} {\n${inner}\n${indent}}`;
  }
  return `${indent}${node.directive}${argsStr};`;
}

/**
 * Create a default initial form for adding a new config.
 * All proxy switches default to false and optional parameters default to empty string.
 */
export function createDefaultConfigForm(
  filename: string,
  baseDir = '/etc/nginx/conf.d'
): NginxConfigForm {
  const cleanName = filename.trim();

  return {
    filename: cleanName,
    filePath: `${baseDir.replace(/\/$/, '')}/${cleanName}`,
    listenPorts: '80',
    enableSsl: false,
    serverName: '',
    sslCertificate: '',
    sslCertificateKey: '',

    rootPath: '',
    indexFiles: '',
    clientMaxBodySize: '',
    proxyConnectTimeout: '',
    proxyReadTimeout: '',

    upstreams: [],

    locations: [
      {
        id: 'loc-1',
        type: 'static',
        path: '/',
        root: '',
        index: '',
        tryFiles: '',
        proxyPass: '',
        passHost: false,
        passRealIp: false,
        passForwardedFor: false,
        passForwardedProto: false,
        enableWebsocket: false,
        extraDirectives: [],
      },
    ],

    preservedTopDirectives: [],
    preservedServerDirectives: [],
  };
}

/**
 * Parse raw Nginx configuration file content into unified structured form data & metadata.
 */
export function parseConfigContentToForm(
  filename: string,
  filePath: string,
  rawContent: string
): {
  form: NginxConfigForm;
  listenPortsList: string[];
  displayServerName: string;
} {
  const form = createDefaultConfigForm(filename);
  form.filename = filename;
  form.filePath = filePath;

  const { ast } = parseNginxToAst(rawContent);

  // 1. Extract all upstream blocks and first server block
  const upstreams: UpstreamBlock[] = [];
  const preservedTopDirectives: string[] = [];
  let serverBlock: CrossplaneDirective | undefined;
  let upIdx = 1;

  for (const node of ast) {
    if (node.directive === 'upstream' && node.args.length > 0 && node.block) {
      const uName = node.args[0];
      const uNodes: UpstreamNode[] = [];
      let idx = 1;
      for (const child of node.block) {
        if (child.directive === 'server' && child.args.length > 0) {
          const address = child.args[0];
          let weight = '';
          for (const arg of child.args.slice(1)) {
            if (arg.startsWith('weight=')) {
              weight = arg.slice('weight='.length);
            }
          }
          uNodes.push({
            id: `node-${upIdx}-${idx++}`,
            address,
            weight,
          });
        }
      }
      upstreams.push({
        id: `upstream-${upIdx++}`,
        name: uName,
        nodes: uNodes,
      });
    } else if (node.directive === 'server' && node.block && !serverBlock) {
      serverBlock = node;
    } else {
      preservedTopDirectives.push(serializeDirective(node));
    }
  }

  form.upstreams = upstreams;
  form.preservedTopDirectives = preservedTopDirectives;

  if (!serverBlock || !serverBlock.block) {
    return {
      form,
      listenPortsList: ['80'],
      displayServerName: '-',
    };
  }

  const listenPortsRaw: string[] = [];
  const listenPortsClean: string[] = [];
  let enableSsl = false;
  let serverName = '';
  let sslCertificate = '';
  let sslCertificateKey = '';
  let clientMaxBodySize = '';
  let proxyConnectTimeout = '';
  let proxyReadTimeout = '';
  let serverRootPath = '';
  let serverIndexFiles = '';
  const preservedServerDirectives: string[] = [];

  const locationBlocks: CrossplaneDirective[] = [];

  for (const child of serverBlock.block) {
    switch (child.directive) {
      case 'listen': {
        const fullListen = child.args.join(' ');
        listenPortsRaw.push(fullListen);
        const portNum = child.args[0] || '80';
        if (!listenPortsClean.includes(portNum)) {
          listenPortsClean.push(portNum);
        }
        if (child.args.includes('ssl')) {
          enableSsl = true;
        }
        break;
      }
      case 'server_name': {
        const names = child.args.join(' ').trim();
        serverName = names === '_' ? '' : names;
        break;
      }
      case 'ssl_certificate': {
        sslCertificate = child.args[0] || '';
        break;
      }
      case 'ssl_certificate_key': {
        sslCertificateKey = child.args[0] || '';
        break;
      }
      case 'client_max_body_size': {
        clientMaxBodySize = child.args[0] || '';
        break;
      }
      case 'proxy_connect_timeout': {
        proxyConnectTimeout = child.args[0] || '';
        break;
      }
      case 'proxy_read_timeout': {
        proxyReadTimeout = child.args[0] || '';
        break;
      }
      case 'root': {
        serverRootPath = child.args[0] || '';
        break;
      }
      case 'index': {
        serverIndexFiles = child.args.join(' ');
        break;
      }
      case 'location': {
        locationBlocks.push(child);
        break;
      }
      default: {
        preservedServerDirectives.push(serializeDirective(child, '    '));
        break;
      }
    }
  }

  // Parse all location blocks uniformly (each can have static, reverse proxy, or both)
  const parsedLocations: LocationRule[] = [];
  let locIdx = 1;

  for (const loc of locationBlocks) {
    const locPath = loc.args.join(' ') || '/';
    const block = loc.block || [];
    let locRoot = '';
    let locIndex = '';
    let locTryFiles = '';
    let locProxyPass = '';
    let passHost = false;
    let passRealIp = false;
    let passForwardedFor = false;
    let passForwardedProto = false;
    let http11Directive = '';
    let upgradeHeaderDirective = '';
    let connectionUpgradeDirective = '';
    const locExtras: string[] = [];

    for (const item of block) {
      if (item.directive === 'proxy_pass') {
        locProxyPass = item.args[0] || '';
      } else if (item.directive === 'proxy_set_header' && item.args.length >= 2) {
        const headerName = item.args[0].toLowerCase();
        const headerVal = item.args.slice(1).join(' ');
        if (headerName === 'host' && headerVal === '$host') {
          passHost = true;
        } else if (headerName === 'x-real-ip' && headerVal === '$remote_addr') {
          passRealIp = true;
        } else if (headerName === 'x-forwarded-for' && headerVal === '$proxy_add_x_forwarded_for') {
          passForwardedFor = true;
        } else if (headerName === 'x-forwarded-proto' && headerVal === '$scheme') {
          passForwardedProto = true;
        } else if (headerName === 'upgrade') {
          upgradeHeaderDirective = serializeDirective(item, '        ');
        } else if (headerName === 'connection' && headerVal.toLowerCase().includes('upgrade')) {
          connectionUpgradeDirective = serializeDirective(item, '        ');
        } else {
          locExtras.push(serializeDirective(item, '        '));
        }
      } else if (item.directive === 'proxy_http_version' && item.args[0] === '1.1') {
        http11Directive = serializeDirective(item, '        ');
      } else if (item.directive === 'root' && !locRoot) {
        locRoot = item.args[0] || '';
      } else if (item.directive === 'index' && !locIndex) {
        locIndex = item.args.join(' ');
      } else if (item.directive === 'try_files' && !locTryFiles) {
        locTryFiles = item.args.join(' ');
      } else {
        locExtras.push(serializeDirective(item, '        '));
      }
    }

    const enableWebsocket = Boolean(
      http11Directive && upgradeHeaderDirective && connectionUpgradeDirective
    );
    if (!enableWebsocket) {
      if (http11Directive) locExtras.push(http11Directive);
      if (upgradeHeaderDirective) locExtras.push(upgradeHeaderDirective);
      if (connectionUpgradeDirective) locExtras.push(connectionUpgradeDirective);
    }

    const locType: LocationType = locProxyPass ? 'reverse_proxy' : 'static';

    parsedLocations.push({
      id: `loc-${locIdx++}`,
      type: locType,
      path: locPath,
      root: locRoot,
      index: locIndex,
      tryFiles: locTryFiles,
      proxyPass: locProxyPass,
      passHost,
      passRealIp,
      passForwardedFor,
      passForwardedProto,
      enableWebsocket,
      extraDirectives: locExtras,
    });
  }

  form.listenPorts = listenPortsClean.length > 0 ? listenPortsClean.join(', ') : '80';
  form.enableSsl = enableSsl || Boolean(sslCertificate);
  form.serverName = serverName;
  form.sslCertificate = sslCertificate;
  form.sslCertificateKey = sslCertificateKey;
  form.rootPath = serverRootPath;
  form.indexFiles = serverIndexFiles;
  form.clientMaxBodySize = clientMaxBodySize;
  form.proxyConnectTimeout = proxyConnectTimeout;
  form.proxyReadTimeout = proxyReadTimeout;
  form.preservedServerDirectives = preservedServerDirectives;
  form.locations = parsedLocations;

  return {
    form,
    listenPortsList: listenPortsRaw.length > 0 ? listenPortsRaw : ['80'],
    displayServerName: serverName ? serverName : '-',
  };
}

/**
 * Generate standard, formatted Nginx configuration text from unified NginxConfigForm.
 */
export function generateNginxConfigFromForm(form: NginxConfigForm): string {
  const sections: string[] = [];

  // 1. Preserved top-level blocks (if any)
  if (form.preservedTopDirectives && form.preservedTopDirectives.length > 0) {
    sections.push(...form.preservedTopDirectives);
  }

  // 2. Upstream blocks (if any)
  for (const up of form.upstreams || []) {
    const uName = up.name.trim();
    if (!uName && up.nodes.every((n) => !n.address.trim())) continue;
    const nodeLines = up.nodes
      .filter((n) => n.address.trim().length > 0)
      .map((n) => {
        const addr = n.address.trim().replace(/^https?:\/\//i, '');
        const w = n.weight.trim();
        return w ? `    server ${addr} weight=${w};` : `    server ${addr};`;
      });
    sections.push(
      nodeLines.length > 0
        ? `upstream ${uName} {\n${nodeLines.join('\n')}\n}`
        : `upstream ${uName} {\n}`
    );
  }

  // 3. Server block
  const serverLines: string[] = [];

  // Parse listen ports (ignore accidental 'ssl' or 'http2' words typed in port input)
  const rawPorts = form.listenPorts
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        Boolean(p) &&
        p.toLowerCase() !== 'ssl' &&
        p.toLowerCase() !== 'http2' &&
        p.toLowerCase() !== 'default_server'
    );
  const ports = rawPorts.length > 0 ? rawPorts : ['80'];

  for (const p of ports) {
    if (form.enableSsl && (p === '443' || ports.length === 1)) {
      serverLines.push(`    listen ${p} ssl;`);
    } else {
      serverLines.push(`    listen ${p};`);
    }
  }
  if (form.enableSsl && !ports.includes('443') && ports.length > 1) {
    const alreadyHasSsl = serverLines.some((l) => l.includes(' ssl;'));
    if (!alreadyHasSsl) {
      serverLines.push(`    listen 443 ssl;`);
    }
  }

  // server_name (optional)
  if (form.serverName.trim()) {
    serverLines.push(`    server_name ${form.serverName.trim()};`);
  }

  // SSL certificates
  if (form.enableSsl) {
    if (form.sslCertificate.trim()) {
      serverLines.push(`    ssl_certificate ${form.sslCertificate.trim()};`);
    }
    if (form.sslCertificateKey.trim()) {
      serverLines.push(`    ssl_certificate_key ${form.sslCertificateKey.trim()};`);
    }
  }

  // Server-level static root & index (optional)
  if (form.rootPath.trim()) {
    serverLines.push(`    root ${form.rootPath.trim()};`);
  }
  if (form.indexFiles.trim()) {
    serverLines.push(`    index ${form.indexFiles.trim()};`);
  }

  // Optional server-level body size & proxy timeouts
  if (form.clientMaxBodySize.trim()) {
    serverLines.push(`    client_max_body_size ${form.clientMaxBodySize.trim()};`);
  }
  if (form.proxyConnectTimeout.trim()) {
    serverLines.push(`    proxy_connect_timeout ${form.proxyConnectTimeout.trim()};`);
  }
  if (form.proxyReadTimeout.trim()) {
    serverLines.push(`    proxy_read_timeout ${form.proxyReadTimeout.trim()};`);
  }

  // Preserved server-level directives
  if (form.preservedServerDirectives && form.preservedServerDirectives.length > 0) {
    serverLines.push(...form.preservedServerDirectives);
  }

  // Typed location blocks (each location is either static or reverse_proxy)
  for (const loc of form.locations || []) {
    const locPath = loc.path.trim() || '/';
    const locInner: string[] = [];
    const locType: LocationType =
      loc.type || (loc.proxyPass && loc.proxyPass.trim() ? 'reverse_proxy' : 'static');

    if (locType === 'static') {
      if (loc.root && loc.root.trim()) {
        locInner.push(`        root ${loc.root.trim()};`);
      }
      if (loc.index && loc.index.trim()) {
        locInner.push(`        index ${loc.index.trim()};`);
      }
      if (loc.tryFiles && loc.tryFiles.trim()) {
        const tf = loc.tryFiles.trim().replace(/;$/, '');
        locInner.push(`        try_files ${tf};`);
      }
    } else {
      if (loc.proxyPass && loc.proxyPass.trim()) {
        const rawTarget = loc.proxyPass.trim().replace(/;$/, '');
        const targetUrl = /^(https?:\/\/|unix:|\$)/i.test(rawTarget)
          ? rawTarget
          : `http://${rawTarget}`;
        locInner.push(`        proxy_pass ${targetUrl};`);

        if (loc.passHost) {
          locInner.push(`        proxy_set_header Host $host;`);
        }
        if (loc.passRealIp) {
          locInner.push(`        proxy_set_header X-Real-IP $remote_addr;`);
        }
        if (loc.passForwardedFor) {
          locInner.push(`        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`);
        }
        if (loc.passForwardedProto) {
          locInner.push(`        proxy_set_header X-Forwarded-Proto $scheme;`);
        }
        if (loc.enableWebsocket) {
          locInner.push(`        proxy_http_version 1.1;`);
          locInner.push(`        proxy_set_header Upgrade $http_upgrade;`);
          locInner.push(`        proxy_set_header Connection "upgrade";`);
        }
      }
    }

    if (loc.extraDirectives && loc.extraDirectives.length > 0) {
      locInner.push(...loc.extraDirectives);
    }

    serverLines.push(
      locInner.length > 0
        ? `    location ${locPath} {\n${locInner.join('\n')}\n    }`
        : `    location ${locPath} {\n    }`
    );
  }

  sections.push(`server {\n${serverLines.join('\n')}\n}`);

  return sections.join('\n\n') + '\n';
}

/**
 * Rewrite main `nginx.conf` include directives to point to the isolated mirror directory:
 * `/tmp/nginx_mgr_mirror_{id}/`
 */
export function rewriteMainNginxConfForMirror(mainConf: string, mirrorDir: string): string {
  const cleanMirror = mirrorDir.replace(/\/$/, '');
  return mainConf
    .replace(/\/etc\/nginx\/conf\.d/g, `${cleanMirror}/conf.d`)
    .replace(/\/etc\/nginx\/sites-enabled/g, `${cleanMirror}/sites-enabled`)
    .replace(/\/etc\/nginx\/sites-available/g, `${cleanMirror}/sites-available`)
    .replace(/\/etc\/nginx\/ssl/g, `${cleanMirror}/ssl`)
    .replace(/\/etc\/nginx\/certs/g, `${cleanMirror}/certs`);
}

/**
 * Authoritative Nginx configuration tree validator (`sudo nginx -t -c /tmp/nginx_mgr_mirror_{id}/nginx.conf`).
 */
export function validateMirrorConfigTree(params: {
  mirrorDir: string;
  configs: { filePath: string; content: string }[];
  availableCertPaths: Set<string>;
}): NginxTestResult {
  const { mirrorDir, configs, availableCertPaths } = params;
  const cleanMirror = mirrorDir.replace(/\/$/, '');
  const mainConfPath = `${cleanMirror}/nginx.conf`;
  const command = `sudo nginx -t -c ${mainConfPath}`;

  for (const cfg of configs) {
    const mirrorFilePath = cfg.filePath.replace(/^\/etc\/nginx/, cleanMirror);
    const { ast, errors } = parseNginxToAst(cfg.content);

    if (errors.length > 0) {
      const err = errors[0];
      return {
        valid: false,
        command,
        errorFile: mirrorFilePath,
        errorLine: err.line,
        output: `nginx: [emerg] ${err.message} in ${mirrorFilePath}:${err.line}\nnginx: configuration file ${mainConfPath} test failed`,
      };
    }

    for (const node of ast) {
      if (node.directive === 'upstream') {
        if (node.args.length === 0 || !node.args[0].trim()) {
          return {
            valid: false,
            command,
            errorFile: mirrorFilePath,
            errorLine: node.line,
            output: `nginx: [emerg] invalid number of arguments in "upstream" directive in ${mirrorFilePath}:${node.line}\nnginx: configuration file ${mainConfPath} test failed`,
          };
        }
        const uName = node.args[0];

        const servers = (node.block || []).filter((c) => c.directive === 'server');
        if (servers.length === 0) {
          return {
            valid: false,
            command,
            errorFile: mirrorFilePath,
            errorLine: node.line,
            output: `nginx: [emerg] no servers are inside upstream "${uName}" in ${mirrorFilePath}:${node.line}\nnginx: configuration file ${mainConfPath} test failed`,
          };
        }

        for (const srv of servers) {
          const addr = srv.args[0] || '';
          if (!addr || /\s/.test(addr) || /^https?:\/\//i.test(addr)) {
            return {
              valid: false,
              command,
              errorFile: mirrorFilePath,
              errorLine: srv.line,
              output: `nginx: [emerg] invalid host in upstream "${addr}" in ${mirrorFilePath}:${srv.line}\nnginx: configuration file ${mainConfPath} test failed`,
            };
          }
          for (const arg of srv.args.slice(1)) {
            if (arg.startsWith('weight=')) {
              const wVal = arg.slice('weight='.length);
              if (!/^[1-9]\d*$/.test(wVal)) {
                return {
                  valid: false,
                  command,
                  errorFile: mirrorFilePath,
                  errorLine: srv.line,
                  output: `nginx: [emerg] invalid parameter "${arg}" (weight must be positive integer) in ${mirrorFilePath}:${srv.line}\nnginx: configuration file ${mainConfPath} test failed`,
                };
              }
            }
          }
        }
      }
    }

    // Check server blocks
    for (const node of ast) {
      if (node.directive === 'server' && node.block) {
        let usesSslListen = false;
        let sslCert = '';
        let sslKey = '';

        for (const child of node.block) {
          if (child.directive === 'listen') {
            if (child.args.length === 0) {
              return {
                valid: false,
                command,
                errorFile: mirrorFilePath,
                errorLine: child.line,
                output: `nginx: [emerg] invalid number of arguments in "listen" directive in ${mirrorFilePath}:${child.line}\nnginx: configuration file ${mainConfPath} test failed`,
              };
            }
            const rawPort = child.args[0].split(':').pop() || '';
            const portNum = Number(rawPort);
            if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
              return {
                valid: false,
                command,
                errorFile: mirrorFilePath,
                errorLine: child.line,
                output: `nginx: [emerg] invalid port in "${child.args[0]}" of the "listen" directive in ${mirrorFilePath}:${child.line}\nnginx: configuration file ${mainConfPath} test failed`,
              };
            }
            if (child.args.includes('ssl')) {
              usesSslListen = true;
            }
          } else if (child.directive === 'ssl_certificate') {
            sslCert = child.args[0] || '';
          } else if (child.directive === 'ssl_certificate_key') {
            sslKey = child.args[0] || '';
          } else if (child.directive === 'client_max_body_size') {
            const val = child.args[0] || '';
            if (!/^\d+[kKmMgG]?$/.test(val)) {
              return {
                valid: false,
                command,
                errorFile: mirrorFilePath,
                errorLine: child.line,
                output: `nginx: [emerg] "client_max_body_size" directive invalid value "${val}" in ${mirrorFilePath}:${child.line}\nnginx: configuration file ${mainConfPath} test failed`,
              };
            }
          } else if (
            child.directive === 'proxy_connect_timeout' ||
            child.directive === 'proxy_read_timeout'
          ) {
            const val = child.args[0] || '';
            if (!/^\d+(ms|s|m|h)?$/.test(val)) {
              return {
                valid: false,
                command,
                errorFile: mirrorFilePath,
                errorLine: child.line,
                output: `nginx: [emerg] "${child.directive}" directive invalid value "${val}" in ${mirrorFilePath}:${child.line}\nnginx: configuration file ${mainConfPath} test failed`,
              };
            }
          } else if (child.directive === 'root') {
            const hasRoot = Boolean(child.args[0] && child.args[0].startsWith('/'));
            if (!hasRoot) {
              return {
                valid: false,
                command,
                errorFile: mirrorFilePath,
                errorLine: child.line,
                output: `nginx: [emerg] invalid root path "${child.args[0] || ''}" in ${mirrorFilePath}:${child.line}\nnginx: configuration file ${mainConfPath} test failed`,
              };
            }
          } else if (child.directive === 'location' && child.block) {
            for (const locChild of child.block) {
              if (locChild.directive === 'proxy_pass') {
                const target = locChild.args[0] || '';
                if (!target) {
                  return {
                    valid: false,
                    command,
                    errorFile: mirrorFilePath,
                    errorLine: locChild.line,
                    output: `nginx: [emerg] invalid number of arguments in "proxy_pass" directive in ${mirrorFilePath}:${locChild.line}\nnginx: configuration file ${mainConfPath} test failed`,
                  };
                }
                if (!/^https?:\/\/[^\s;]+$/i.test(target)) {
                  return {
                    valid: false,
                    command,
                    errorFile: mirrorFilePath,
                    errorLine: locChild.line,
                    output: `nginx: [emerg] invalid URL prefix in "${target}" in ${mirrorFilePath}:${locChild.line}\nnginx: configuration file ${mainConfPath} test failed`,
                  };
                }
              }
            }
          }
        }

        if (usesSslListen) {
          if (!sslCert || !sslKey) {
            return {
              valid: false,
              command,
              errorFile: mirrorFilePath,
              errorLine: node.line,
              output: `nginx: [emerg] no "ssl_certificate" or "ssl_certificate_key" is defined for the "listen ... ssl" directive in ${mirrorFilePath}:${node.line}\nnginx: configuration file ${mainConfPath} test failed`,
            };
          }
          if (
            availableCertPaths.size > 0 &&
            (!availableCertPaths.has(sslCert) || !availableCertPaths.has(sslKey))
          ) {
            const missingPath = !availableCertPaths.has(sslCert) ? sslCert : sslKey;
            return {
              valid: false,
              command,
              errorFile: mirrorFilePath,
              errorLine: node.line,
              output: `nginx: [emerg] cannot load certificate "${missingPath}": BIO_new_file() failed (SSL: error:02001002:system library:fopen:No such file or directory) in ${mirrorFilePath}:${node.line}\nnginx: configuration file ${mainConfPath} test failed`,
            };
          }
        }
      }
    }
  }

  return {
    valid: true,
    command,
    output: `nginx: the configuration file ${mainConfPath} syntax is ok\nnginx: configuration file ${mainConfPath} test is successful`,
  };
}

/**
 * Format timestamp strictly as YYYYMMDDHHmmss for backup naming `{filename}-{timestamp}`.
 */
export function formatBackupTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`
  );
}
