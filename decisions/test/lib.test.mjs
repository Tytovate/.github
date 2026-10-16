import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVervangt, findDuplicates, parseDecision, renderIndex } from '../lib.mjs';

const doc = (fm, title = '0001: Een besluit') => `---\n${fm}\n---\n\n# ${title}\n`;
const GOOD = 'status: geaccepteerd\ndatum: 2026-10-07\nbesluitnemers: [A]\nraakt: [x]';
const fields = (d) => d.errors.map((e) => e.field);

test('a valid decision has no errors and keeps datum a string', () => {
  const d = parseDecision('0001-een-besluit.md', doc(GOOD), 't');
  assert.deepEqual(d.errors, []);
  assert.equal(d.fm.datum, '2026-10-07');
  assert.equal(d.title, 'Een besluit');
});

test('front matter: each defect names its field', () => {
  const cases = [
    ['status: vervangen\ndatum: 2026-10-07\nbesluitnemers: [A]\nraakt: [x]', 'status'],
    ['status: geaccepteerd\ndatum: 2026-02-30\nbesluitnemers: [A]\nraakt: [x]', 'datum'],
    ['status: geaccepteerd\ndatum: 2026-10-07\nbesluitnemers: []\nraakt: [x]', 'besluitnemers'],
    ['status: geaccepteerd\ndatum: 2026-10-07\nbesluitnemers: [A]', 'raakt'],
    [`${GOOD}\ngeraadpleegd: iemand`, 'geraadpleegd'],
    [`${GOOD}\nauteur: A`, 'auteur'],
    [`${GOOD}\nvervangt: [team/1]`, 'vervangt[0]'],
    [`${GOOD}\nvervangt: [{id: team/0002}]`, 'vervangt[0].deels'],
    [`${GOOD}\nvervangt: [t/0001]`, 'vervangt'],
  ];
  for (const [fm, field] of cases) {
    assert.ok(fields(parseDecision('0001-een-besluit.md', doc(fm), 't')).includes(field), `${field} in ${fm}`);
  }
});

test('an unquoted comma in deels is caught as a stray key', () => {
  const d = parseDecision('0001-een-besluit.md', doc(`${GOOD}\nvervangt: [{id: t/0000, deels: fase 2, een scherm}]`), 't');
  assert.match(d.errors.find((e) => e.field === 'vervangt[0]').message, /komma/);
});

test('missing front matter, bad YAML, bad filename and title mismatch', () => {
  assert.deepEqual(fields(parseDecision('0001-x.md', '# 0001: x\n', 't')), ['front matter']);
  assert.deepEqual(fields(parseDecision('0001-x.md', doc('status: [open'), 't')), ['front matter']);
  assert.ok(fields(parseDecision('1-x.md', doc(GOOD), 't')).includes('bestandsnaam'));
  assert.deepEqual(fields(parseDecision('0002-x.md', doc(GOOD), 't')), ['titel']);
});

test('a duplicate number names every file that shares it', () => {
  const ds = ['0001-a.md', '0001-b.md', '0002-c.md'].map((f) => parseDecision(f, doc(GOOD), 't'));
  const errs = findDuplicates(ds);
  assert.deepEqual(errs.map((e) => e.file), ['0001-a.md', '0001-b.md']);
  assert.ok(errs.every((e) => e.field === 'nummer' && e.message.includes('0001-b.md')));
});

test('vervangt: own prefix must exist, foreign goes to the resolver', async () => {
  const d = parseDecision('0001-a.md', doc(`${GOOD}\nvervangt: [t/0009, other/0001, other/0002]`), 't');
  const resolve = async (id) => (id === 'other/0001' ? true : id === 'other/0002' ? false : null);
  const { errors } = await checkVervangt([d], 't', resolve);
  assert.deepEqual(errors.map((e) => e.message), ['t/0009 bestaat niet in deze map', 'other/0002 bestaat niet']);
  const { unchecked } = await checkVervangt([d], 't', async () => null);
  assert.equal(unchecked.length, 2);
});

test('index: fully replaced drops out, partly replaced says by what, proposals do not replace', () => {
  const ds = [
    parseDecision('0001-a.md', doc(GOOD, '0001: A'), 't'),
    parseDecision('0002-b.md', doc(GOOD, '0002: B'), 't'),
    parseDecision('0003-c.md', doc(`${GOOD}\nvervangt: [t/0001, {id: t/0002, deels: plek}]`, '0003: C'), 't'),
    parseDecision('0004-d.md', doc(`${GOOD.replace('geaccepteerd', 'voorgesteld')}\nvervangt: [t/0003]`, '0004: D'), 't'),
  ];
  const index = renderIndex(ds, 't');
  assert.doesNotMatch(index, /\[t\/0001\]/);
  assert.match(index, /\| \[t\/0002\]\(0002-b.md\) \| B \| geaccepteerd; deels vervangen: plek \(\[t\/0003\]\(0003-c.md\)\) \|/);
  assert.match(index, /\| \[t\/0003\]\(0003-c.md\) \| C \| geaccepteerd \|/);
  assert.match(index, /\| \[t\/0004\]\(0004-d.md\) \| D \| voorgesteld \|/);
  assert.equal(renderIndex(ds, 't'), index);
});
