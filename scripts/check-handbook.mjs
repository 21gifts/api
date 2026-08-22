#!/usr/bin/env node
/**
 * Fail if docs/handbook does not document every exported function/class and
 * every UI screen. Run from the repo root. No extra packages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const HANDBOOK_DIR = path.join(ROOT, 'docs', 'handbook');

function walk(dir, pred, acc = []) {
  if (!fs.existsSync(dir)) {
    return acc;
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (
        ent.name === 'node_modules' ||
        ent.name === '__tests__' ||
        ent.name === 'dist' ||
        ent.name === '.next' ||
        ent.name === 'coverage'
      ) {
        continue;
      }
      walk(p, pred, acc);
    } else if (pred(p)) {
      acc.push(p);
    }
  }
  return acc;
}

function handbookText() {
  const files = walk(HANDBOOK_DIR, (p) => p.endsWith('.md'));
  if (files.length === 0) {
    console.error('HANDBOOK MISSING: docs/handbook/ has no markdown files');
    process.exit(1);
  }
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

function extractFunctions(srcRoot) {
  const names = new Set();
  if (!fs.existsSync(srcRoot)) {
    return names;
  }
  const files = walk(
    srcRoot,
    (p) =>
      /\.(ts|tsx)$/.test(p) &&
      !p.includes(`${path.sep}__tests__${path.sep}`) &&
      !p.endsWith('.d.ts') &&
      !p.endsWith('.test.ts') &&
      !p.endsWith('.test.tsx'),
  );
  const reFn = /^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/gm;
  const reDefault = /^export\s+default\s+(async\s+)?function\s+([A-Za-z0-9_]+)/gm;
  const reConstFn =
    /^export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(async\s*)?(\(|function|create[<(\s]|new\s)/gm;
  const reClass = /^export\s+class\s+([A-Za-z0-9_]+)/gm;
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    let m;
    reFn.lastIndex = 0;
    while ((m = reFn.exec(t))) {
      names.add(m[2]);
    }
    reDefault.lastIndex = 0;
    while ((m = reDefault.exec(t))) {
      names.add(m[2]);
    }
    reConstFn.lastIndex = 0;
    while ((m = reConstFn.exec(t))) {
      names.add(m[1]);
    }
    reClass.lastIndex = 0;
    while ((m = reClass.exec(t))) {
      names.add(m[1]);
    }
  }
  return names;
}

function extractScreens() {
  const screens = new Set();
  const appDir = path.join(ROOT, 'src', 'app');
  if (fs.existsSync(appDir)) {
    const pages = walk(
      appDir,
      (p) => p.endsWith(`${path.sep}page.tsx`) || p.endsWith(`${path.sep}page.ts`),
    );
    for (const p of pages) {
      const rel = path.relative(appDir, path.dirname(p)).replace(/\\/g, '/');
      const route = rel === '' || rel === '.' ? '/' : `/${rel}`;
      screens.add(route);
    }
  }
  for (const name of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
    if (!name.endsWith('.html')) {
      continue;
    }
    if (name === 'index.html') {
      screens.add('/');
    } else if (name === '404.html') {
      screens.add('/404');
    } else {
      screens.add(`/${name.replace(/\.html$/, '')}`);
    }
  }
  return screens;
}

function extractEndpoints() {
  const endpoints = new Set();
  const server = path.join(ROOT, 'src', 'server.ts');
  const routeDir = path.join(ROOT, 'src', 'routes');
  if (!fs.existsSync(server)) {
    return endpoints;
  }
  if (!fs.existsSync(routeDir)) {
    console.error('HANDBOOK: src/server.ts exists but src/routes/ is missing');
    process.exit(1);
  }
  const mountByFile = {
    'health.ts': '/healthz',
    'info.ts': '/info',
    'auth.ts': '/auth',
    'me.ts': '/me',
    'lightning-address.ts': '/lightning-address',
    'brand.ts': '',
  };
  const methodRe = /\.(get|post|delete|put|patch)\((['"])(\/[-A-Za-z0-9_/]*)\2/g;
  for (const file of fs.readdirSync(routeDir).filter((n) => n.endsWith('.ts'))) {
    const mount = Object.hasOwn(mountByFile, file)
      ? mountByFile[file]
      : `/${file.replace(/\.ts$/, '')}`;
    const t = fs.readFileSync(path.join(routeDir, file), 'utf8');
    let m;
    methodRe.lastIndex = 0;
    while ((m = methodRe.exec(t))) {
      const method = m[1].toUpperCase();
      const sub = m[3] === '/' ? '' : m[3];
      const full = `${mount}${sub}` || '/';
      endpoints.add(`${method} ${full}`);
    }
  }
  if (fs.existsSync(path.join(routeDir, 'brand.ts'))) {
    endpoints.add('GET /favicon.ico');
    endpoints.add('GET /favicon.svg');
    endpoints.add('GET /apple-touch-icon.png');
  }
  if (endpoints.size === 0) {
    console.error('HANDBOOK: src/server.ts present but no HTTP endpoints discovered');
    process.exit(1);
  }
  return endpoints;
}

function headingRe(kind, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^## ${kind}: ${esc}\\s*$`, 'm');
}

function sectionBody(text, kind, name) {
  const marker = `## ${kind}: ${name}`;
  let from = 0;
  while (from <= text.length) {
    const idx = text.indexOf(marker, from);
    if (idx < 0) {
      return '';
    }
    const atLine = idx === 0 || text[idx - 1] === '\n';
    const after = text[idx + marker.length];
    if (atLine && (after === undefined || after === '\n' || after === '\r')) {
      const start = idx + marker.length;
      const rest = text.slice(start).replace(/^\r?\n/, '');
      const next = rest.search(/\n## /);
      return next < 0 ? rest : rest.slice(0, next);
    }
    from = idx + marker.length;
  }
  return '';
}

function sectionComplete(body) {
  const bullets = (body.match(/^- \*\*/gm) || []).length;
  return bullets >= 3 && body.trim().length >= 80;
}

export { extractScreens, extractEndpoints, walk };

const isMain = import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const text = handbookText();
  const missing = [];

  const fns = extractFunctions(path.join(ROOT, 'src'));
  for (const n of [...fns].sort()) {
    if (!headingRe('Function', n).test(text)) {
      missing.push(`Function: ${n} (missing ## Function: ${n})`);
    } else if (!sectionComplete(sectionBody(text, 'Function', n))) {
      missing.push(`Function: ${n} (incomplete — need ≥3 "- **…**" bullets and ≥80 characters)`);
    }
  }

  const screens = extractScreens();
  for (const n of [...screens].sort()) {
    if (!headingRe('Screen', n).test(text)) {
      missing.push(`Screen: ${n} (missing ## Screen: ${n})`);
    } else if (!sectionComplete(sectionBody(text, 'Screen', n))) {
      missing.push(`Screen: ${n} (incomplete)`);
    }
  }

  const endpoints = extractEndpoints();
  for (const n of [...endpoints].sort()) {
    if (!headingRe('Endpoint', n).test(text)) {
      missing.push(`Endpoint: ${n} (missing ## Endpoint: ${n})`);
    } else if (!sectionComplete(sectionBody(text, 'Endpoint', n))) {
      missing.push(`Endpoint: ${n} (incomplete)`);
    }
  }

  if (missing.length) {
    console.error('HANDBOOK INCOMPLETE:');
    for (const line of missing) {
      console.error(`  - ${line}`);
    }
    process.exit(1);
  }

  console.log(
    `Handbook complete: ${fns.size} functions, ${screens.size} screens, ${endpoints.size} endpoints.`,
  );
}
