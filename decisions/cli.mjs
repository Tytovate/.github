#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseArgs } from 'node:util';
import { checkVervangt, findDuplicates, isDecisionFile, parseDecision, renderIndex } from './lib.mjs';

const USAGE = `gebruik:
  decisions index --dir <map> --prefix <prefix>
  decisions check --dir <map> --prefix <prefix> [--base <sha> --base-ref <branch> --default-branch <branch>]
                  [--sources "prefix=owner/repo:map ..."]   (token via GH_TOKEN voor andere repo's)`;

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    prefix: { type: 'string' },
    base: { type: 'string' },
    'base-ref': { type: 'string' },
    'default-branch': { type: 'string' },
    sources: { type: 'string', default: '' },
  },
});
const mode = positionals[0];
if (!['index', 'check'].includes(mode) || !opt.dir || !opt.prefix) {
  console.error(USAGE);
  process.exit(2);
}
const dir = posix.normalize(opt.dir.replace(/\\/g, '/')).replace(/\/$/, '');
const prefix = opt.prefix;
const inActions = process.env.GITHUB_ACTIONS === 'true';
const indexCmd = `npx --yes -p github:Tytovate/.github decisions index --dir ${dir} --prefix ${prefix}`;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function report(level, { file, field, message }) {
  const path = file.includes('/') ? file : `${dir}/${file}`;
  if (inActions) console.log(`::${level} file=${path},title=${field}::${message}`);
  else console.log(`${level === 'error' ? 'FOUT' : 'LET OP'}  ${path}  [${field}]  ${message}`);
}

function loadDecisions() {
  if (!existsSync(dir)) {
    console.error(`map ${dir} bestaat niet`);
    process.exit(2);
  }
  return readdirSync(dir)
    .filter(isDecisionFile)
    .sort()
    .map((f) => parseDecision(f, readFileSync(join(dir, f), 'utf8'), prefix));
}

const decisions = loadDecisions();
const index = renderIndex(decisions, prefix);

if (mode === 'index') {
  writeFileSync(join(dir, 'index.md'), index);
  const errors = decisions.flatMap((d) => d.errors);
  errors.forEach((e) => report('error', e));
  console.log(`${dir}/index.md geschreven (${decisions.length} besluiten${errors.length ? `, ${errors.length} fouten hierboven` : ''})`);
  process.exit(errors.length ? 1 : 0);
}

// Known homes of other decision sets (team/0001); --sources overrides or adds.
const sources = new Map([
  ['team', { repo: 'Tytovate/tyto-docs', dir: 'decisions' }],
  ['paperclip', { repo: 'Tytovate/paperclip', dir: 'tyto-docs/adr' }],
]);
for (const line of opt.sources.split(/[\s,]+/).filter(Boolean)) {
  const m = /^([a-z0-9-]+)=([\w.-]+\/[\w.-]+):(.+)$/.exec(line);
  if (!m) {
    console.error(`ongeldige bron '${line}', verwacht prefix=owner/repo:map`);
    process.exit(2);
  }
  sources.set(m[1], { repo: m[2], dir: m[3] });
}

const token = process.env.GH_TOKEN || '';
const listings = new Map();
async function resolveForeign(id) {
  if (!token) return null;
  const [p, num] = id.split('/');
  const src = sources.get(p) ?? { repo: `Tytovate/${p}`, dir: 'docs/decisions' };
  if (!listings.has(p)) {
    const res = await fetch(`https://api.github.com/repos/${src.repo}/contents/${src.dir}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    listings.set(p, res.ok ? (await res.json()).map((e) => e.name) : `kon ${src.repo}:${src.dir} niet lezen (HTTP ${res.status})`);
  }
  const names = listings.get(p);
  return typeof names === 'string' ? names : names.some((n) => n.startsWith(`${num}-`));
}

const errors = decisions.flatMap((d) => d.errors);
errors.push(...findDuplicates(decisions));
const { errors: vErrors, unchecked } = await checkVervangt(decisions, prefix, resolveForeign);
errors.push(...vErrors);

if (opt.base) {
  // Base against the working tree plus untracked files, so a local run sees uncommitted work too.
  const changed = [git('diff', '--name-only', opt.base, '--', dir), git('ls-files', '--others', '--exclude-standard', '--', dir)]
    .join('\n').split('\n').filter(Boolean);
  if (changed.length && opt['base-ref'] && opt['default-branch'] && opt['base-ref'] !== opt['default-branch']) {
    errors.push({
      file: changed.find((f) => isDecisionFile(posix.basename(f))) ?? changed[0],
      field: 'doelbranch',
      message: `deze PR wijzigt ${dir} maar gaat naar '${opt['base-ref']}'; een ADR-PR gaat altijd naar '${opt['default-branch']}' (anders delen twee branches één nummer)`,
    });
  }
  let baseFiles = [];
  try {
    baseFiles = git('ls-tree', '--name-only', `${opt.base}:${dir}`).split('\n').filter(isDecisionFile);
  } catch {} // the map is new in this PR, so nothing on base can have changed
  for (const f of baseFiles) {
    const before = git('show', `${opt.base}:${dir}/${f}`);
    if (parseDecision(f, before, prefix).fm.status !== 'geaccepteerd') continue;
    const path = join(dir, f);
    if (!existsSync(path)) {
      errors.push({ file: f, field: 'bestand', message: 'een geaccepteerd besluit is verwijderd of hernoemd; vervang het met een nieuw besluit en vervangt:' });
    } else if (readFileSync(path, 'utf8') !== before) {
      errors.push({ file: f, field: 'inhoud', message: 'een geaccepteerd besluit verandert niet meer, ook de front matter niet; schrijf een nieuw besluit met vervangt:' });
    }
  }
}

const indexPath = join(dir, 'index.md');
if (!existsSync(indexPath)) {
  errors.push({ file: 'index.md', field: 'index', message: `ontbreekt; genereer met: ${indexCmd}` });
} else if (readFileSync(indexPath, 'utf8') !== index) {
  errors.push({ file: 'index.md', field: 'index', message: `is verouderd ten opzichte van de front matter; genereer opnieuw met: ${indexCmd}` });
}

errors.forEach((e) => report('error', e));
unchecked.forEach((e) => report('warning', e));
const summary = errors.length
  ? `decisions check: ${errors.length} fout(en) in ${dir}`
  : `decisions check: ${dir} in orde (${decisions.length} besluiten${unchecked.length ? `, ${unchecked.length} niet gecontroleerd` : ''})`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [...errors.map((e) => `- ❌ \`${e.file}\` **${e.field}**: ${e.message}`), ...unchecked.map((e) => `- ⚠️ \`${e.file}\` **${e.field}**: ${e.message}`)];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n\n${lines.join('\n')}\n`);
}
process.exit(errors.length ? 1 : 0);
