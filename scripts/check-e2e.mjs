#!/usr/bin/env node
/**
 * Fail if Playwright spec files under e2e/ do not cover every exported
 * function/class and every HTTP endpoint. A function needs a Playwright
 * test('Function: <Name> …') title; a screen needs page.goto of that path;
 * an endpoint needs request.get/post/delete of that path. Only files named
 * *.spec.ts are scanned (helpers are ignored). Run from the repo root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractEndpoints, extractFunctions, extractScreens, walk } from './check-handbook.mjs';

const ROOT = process.cwd();
const E2E_DIR = path.join(ROOT, 'e2e');

function e2eText() {
  if (!fs.existsSync(E2E_DIR)) {
    console.error('E2E MISSING: e2e/ directory does not exist');
    process.exit(1);
  }
  const files = walk(E2E_DIR, (p) => p.endsWith('.spec.ts'));
  if (files.length === 0) {
    console.error('E2E MISSING: e2e/ has no spec files');
    process.exit(1);
  }
  return files
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const text = e2eText();
const missing = [];

const screens = extractScreens();
for (const route of [...screens].sort()) {
  const html = route === '/' ? '/' : `${route}.html`;
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const gotoRe = new RegExp(`goto\\((['"\`])(${escaped}|${html.replace('.', '\\.')})\\1`);
  if (!gotoRe.test(text)) {
    missing.push(`Screen ${route} has no e2e page.goto('${route}') (or .html)`);
  }
}

const endpoints = extractEndpoints();
for (const spec of [...endpoints].sort()) {
  const [method, pathName] = spec.split(' ');
  const verb = method.toLowerCase();
  const escaped = pathName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`request\\.${verb}\\((['"\`])${escaped}\\1`);
  if (!re.test(text)) {
    missing.push(`Endpoint ${spec} has no e2e request.${verb}('${pathName}')`);
  }
}

const functions = extractFunctions(path.join(ROOT, 'src'));
for (const name of [...functions].sort()) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleRe = new RegExp(`test\\((['"\`])Function: ${escaped}\\b`);
  if (!titleRe.test(text)) {
    missing.push(`Function ${name} has no e2e test title Function: ${name}`);
  }
}

if (endpoints.size === 0 || functions.size === 0) {
  console.error(
    `E2E: discovery empty — screens=${screens.size} endpoints=${endpoints.size} functions=${functions.size}`,
  );
  process.exit(1);
}

if (missing.length) {
  console.error('E2E INCOMPLETE:');
  for (const line of missing) {
    console.error(`  - ${line}`);
  }
  process.exit(1);
}

console.log(
  `E2E complete: ${screens.size} screens, ${endpoints.size} endpoints, ${functions.size} functions.`,
);
