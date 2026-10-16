import { parseDocument } from 'yaml';

export const RESERVED = new Set(['README.md', 'template.md', 'index.md']);
export const STATUSES = ['voorgesteld', 'geaccepteerd', 'afgewezen'];
export const ID_RE = /^[a-z0-9-]+\/\d{4}$/;
const FILE_RE = /^(\d{4})-[a-z0-9-]+\.md$/;
const KEYS = ['status', 'datum', 'besluitnemers', 'geraadpleegd', 'raakt', 'vervangt'];
const MARKER = '<!-- Gegenereerd door Tytovate/.github (decisions index). Niet met de hand bewerken. -->';

export const isDecisionFile = (name) => name.endsWith('.md') && !RESERVED.has(name);

// Splits front matter from body; returns null when the file does not open with a --- block.
function splitFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { yaml: m[1], body: m[2] } : null;
}

const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Parses and validates one decision file. Errors carry the file and the field they concern.
export function parseDecision(file, text, prefix) {
  const errors = [];
  const fail = (field, message) => errors.push({ file, field, message });
  const dec = { file, num: null, title: null, fm: {}, errors };

  const fm = FILE_RE.exec(file);
  if (fm) dec.num = fm[1];
  else fail('bestandsnaam', `moet NNNN-korte-titel.md zijn (kleine letters, cijfers, streepjes)`);

  const split = splitFrontMatter(text);
  if (!split) {
    fail('front matter', 'het bestand moet beginnen met een front-matterblok tussen twee regels ---');
    return dec;
  }
  const doc = parseDocument(split.yaml);
  if (doc.errors.length) {
    for (const e of doc.errors) fail('front matter', `ongeldige YAML: ${e.message.split('\n')[0]}`);
    return dec;
  }
  const data = doc.toJS();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('front matter', 'moet een lijst van sleutels zijn (status, datum, ...)');
    return dec;
  }
  dec.fm = data;

  for (const key of Object.keys(data)) {
    if (!KEYS.includes(key)) fail(key, `onbekende sleutel; toegestaan: ${KEYS.join(', ')}`);
  }
  if (!STATUSES.includes(data.status)) {
    fail('status', `is ${JSON.stringify(data.status ?? null)}, moet een van ${STATUSES.join(' | ')} zijn ('vervangen' leidt de index af)`);
  }
  if (!validDate(data.datum)) fail('datum', `is ${JSON.stringify(data.datum ?? null)}, moet een bestaande datum JJJJ-MM-DD zijn`);
  for (const key of ['besluitnemers', 'raakt']) {
    if (!isStringList(data[key]) || data[key].length === 0) fail(key, 'moet een niet-lege lijst met tekst zijn');
  }
  if ('geraadpleegd' in data && !isStringList(data.geraadpleegd)) fail('geraadpleegd', 'moet een lijst met tekst zijn (mag leeg)');

  dec.vervangt = [];
  if ('vervangt' in data) {
    if (!Array.isArray(data.vervangt)) fail('vervangt', 'moet een lijst zijn');
    else data.vervangt.forEach((item, i) => {
      const field = `vervangt[${i}]`;
      if (typeof item === 'string') {
        if (!ID_RE.test(item)) fail(field, `${JSON.stringify(item)} is geen id als team/0001 of paperclip/0007`);
        else dec.vervangt.push({ id: item, deels: null });
        return;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail(field, 'moet een id zijn of {id, deels}');
        return;
      }
      const extra = Object.keys(item).filter((k) => k !== 'id' && k !== 'deels');
      if (extra.length) fail(field, `onbekende sleutel ${extra.map((k) => JSON.stringify(k)).join(', ')}; staat er een komma in 'deels'? Zet de tekst dan tussen aanhalingstekens`);
      if (typeof item.id !== 'string' || !ID_RE.test(item.id)) fail(`${field}.id`, `${JSON.stringify(item.id ?? null)} is geen id als team/0001`);
      if (typeof item.deels !== 'string' || item.deels.trim() === '') fail(`${field}.deels`, 'moet beschrijven welk deel vervangen wordt');
      if (typeof item.id === 'string' && ID_RE.test(item.id)) dec.vervangt.push({ id: item.id, deels: typeof item.deels === 'string' ? item.deels : null });
    });
  }
  if (dec.num && dec.vervangt.some((v) => v.id === `${prefix}/${dec.num}`)) fail('vervangt', 'een besluit kan zichzelf niet vervangen');

  const heading = split.body.match(/^# (.+)$/m);
  const h = heading && /^(\d{4}): (.+)$/.exec(heading[1].trim());
  if (!h) fail('titel', `de eerste kop moet '# NNNN: het besluit in één zin' zijn`);
  else if (dec.num && h[1] !== dec.num) fail('titel', `nummer ${h[1]} in de kop wijkt af van ${dec.num} in de bestandsnaam`);
  else dec.title = h[2].trim();

  return dec;
}

export function findDuplicates(decisions) {
  const byNum = new Map();
  for (const d of decisions) if (d.num) byNum.set(d.num, [...(byNum.get(d.num) ?? []), d.file]);
  const errors = [];
  for (const [num, files] of byNum) {
    if (files.length < 2) continue;
    for (const file of files) {
      errors.push({ file, field: 'nummer', message: `${num} is dubbel: ${files.join(', ')}. Kies het volgende vrije nummer op de standaardbranch` });
    }
  }
  return errors;
}

// Own-prefix targets must exist here; foreign ones go to `resolveForeign` (null = not checked).
export async function checkVervangt(decisions, prefix, resolveForeign) {
  const local = new Set(decisions.filter((d) => d.num).map((d) => `${prefix}/${d.num}`));
  const errors = [];
  const unchecked = [];
  for (const d of decisions) {
    for (const [i, v] of (d.vervangt ?? []).entries()) {
      const field = `vervangt[${i}]`;
      if (v.id.startsWith(`${prefix}/`)) {
        if (!local.has(v.id)) errors.push({ file: d.file, field, message: `${v.id} bestaat niet in deze map` });
        continue;
      }
      const result = await resolveForeign(v.id);
      if (result === null) unchecked.push({ file: d.file, field, message: `${v.id} niet gecontroleerd: geen token voor een andere repo` });
      else if (result !== true) errors.push({ file: d.file, field, message: result === false ? `${v.id} bestaat niet` : `${v.id}: ${result}` });
    }
  }
  return { errors, unchecked };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// One row per decision that still applies or was rejected; fully superseded ones drop out.
export function renderIndex(decisions, prefix) {
  const valid = decisions.filter((d) => d.num && d.title).sort((a, b) => a.num.localeCompare(b.num));
  const byId = new Map(valid.map((d) => [`${prefix}/${d.num}`, d]));
  const replaced = new Map();
  for (const d of valid) {
    if (d.fm.status !== 'geaccepteerd') continue;
    for (const v of d.vervangt ?? []) {
      if (!byId.has(v.id)) continue;
      replaced.set(v.id, [...(replaced.get(v.id) ?? []), { by: d, deels: v.deels }]);
    }
  }
  const link = (d) => `[${prefix}/${d.num}](${d.file})`;
  const rows = [];
  for (const d of valid) {
    const by = replaced.get(`${prefix}/${d.num}`) ?? [];
    if (by.some((r) => r.deels === null)) continue;
    let status = d.fm.status;
    if (by.length) status += '; deels vervangen: ' + by.map((r) => `${r.deels} (${link(r.by)})`).join('; ');
    const raakt = (Array.isArray(d.fm.raakt) ? d.fm.raakt : []).map((r) => `\`${r}\``).join(', ');
    rows.push(`| ${link(d)} | ${cell(d.title)} | ${cell(status)} | ${cell(raakt)} |`);
  }
  return [
    MARKER,
    '',
    `# Besluiten (${prefix})`,
    '',
    `Eén regel per geldend, voorgesteld of afgewezen besluit, uit de front matter. Geheel vervangen besluiten staan er niet in.`,
    '',
    '| Nr | Besluit | Status | Raakt |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
