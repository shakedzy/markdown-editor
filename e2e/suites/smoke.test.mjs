import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, closeAll, fixture, openFile, getDoc, title } from '../harness.mjs';

after(closeAll);

test('launches and opens a file', async () => {
  const dir = fixture({ 'a.md': '# Hello\n' });
  await withApp({}, async ({ app, win }) => {
    const page = await openFile(app, win, `${dir}/a.md`);
    assert.equal(await getDoc(page), '# Hello\n');
    assert.match(await title(page), /a\.md/);
  });
});
