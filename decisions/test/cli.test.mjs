import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

const CLI = join(import.meta.dirname, '..', 'cli.mjs');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'ok');
const DIR = 'docs/decisions';
let repo, base;

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const run = (...args) => {
  const env = { ...process.env, GH_TOKEN: '', GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '' };
  return spawnSync('node', [CLI, ...args, '--dir', DIR, '--prefix', 'fixture'], { cwd: repo, encoding: 'utf8', env });
};
const check = (baseRef = 'main') => run('check', '--base', base, '--base-ref', baseRef, '--default-branch', 'main');
const reindex = () => assert.equal(run('index').status, 0);

// Each test gets a fresh git repo whose base commit is the passing fixture.
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'decisions-'));
  cpSync(FIXTURE, join(repo, DIR), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('the fixture passes', () => {
  const r = check();
  assert.equal(r.status, 0, r.stdout);
});

test('a changed accepted decision fails, naming file and field', () => {
  appendFileSync(join(repo, DIR, '0001-een-eerste-besluit.md'), '\nNog een zin.\n');
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error file=docs\/decisions\/0001-een-eerste-besluit.md,title=inhoud::/);
});

test('a renamed accepted decision fails', () => {
  renameSync(join(repo, DIR, '0003-een-afgewezen-besluit.md'), join(repo, DIR, '0003-ander.md'));
  renameSync(join(repo, DIR, '0001-een-eerste-besluit.md'), join(repo, DIR, '0001-ander.md'));
  reindex();
  assert.match(check().stdout, /0001-een-eerste-besluit.md,title=bestand::/);
});

test('proposed to accepted is allowed', () => {
  const f = join(repo, DIR, '0004-nieuw.md');
  writeFileSync(f, '---\nstatus: voorgesteld\ndatum: 2026-10-04\nbesluitnemers: [A]\nraakt: [x]\n---\n\n# 0004: Nieuw\n');
  reindex();
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'voorstel');
  base = git('rev-parse', 'HEAD');
  writeFileSync(f, '---\nstatus: geaccepteerd\ndatum: 2026-10-04\nbesluitnemers: [A]\nraakt: [x]\n---\n\n# 0004: Nieuw\n');
  reindex();
  assert.equal(check().status, 0);
});

test('an ADR change outside the default branch fails', () => {
  writeFileSync(join(repo, DIR, '0004-nieuw.md'), '---\nstatus: voorgesteld\ndatum: 2026-10-04\nbesluitnemers: [A]\nraakt: [x]\n---\n\n# 0004: Nieuw\n');
  reindex();
  assert.equal(check('main').status, 0);
  assert.match(check('feature/x').stdout, /0004-nieuw.md,title=doelbranch::/);
});

test('a stale or missing index fails', () => {
  writeFileSync(join(repo, DIR, '0004-nieuw.md'), '---\nstatus: voorgesteld\ndatum: 2026-10-04\nbesluitnemers: [A]\nraakt: [x]\n---\n\n# 0004: Nieuw\n');
  assert.match(check().stdout, /index.md,title=index::is verouderd/);
  rmSync(join(repo, DIR, 'index.md'));
  assert.match(check().stdout, /index.md,title=index::ontbreekt/);
});

test('a duplicate number and a dangling vervangt fail', () => {
  writeFileSync(join(repo, DIR, '0002-dubbel.md'), '---\nstatus: voorgesteld\ndatum: 2026-10-04\nbesluitnemers: [A]\nraakt: [x]\nvervangt: [fixture/0099]\n---\n\n# 0002: Dubbel\n');
  reindex();
  const r = check();
  assert.match(r.stdout, /0002-dubbel.md,title=nummer::/);
  assert.match(r.stdout, /0002-een-tweede-besluit.md,title=nummer::/);
  assert.match(r.stdout, /0002-dubbel.md,title=vervangt\[0\]::fixture\/0099 bestaat niet/);
});
