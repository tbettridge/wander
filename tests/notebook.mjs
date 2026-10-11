import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebook, normalizeNotebook, addNotebookPage, collectNotebookPage,
  notebookStroke, notebookPrintHtml, NotebookStore } from '../src/notebook.mjs';
test('notebook text, normalized drawings and collected works round-trip without duplicate copies', () => {
  const book = createNotebook(); book.pages[0].text = 'Keep the well on my left.';
  const page = addNotebookPage(book, 'My map'); page.strokes.push(notebookStroke([[0.1, 0.2], [0.8, 0.7]]));
  const poem = { id: 'poem', title: 'Rain', text: 'A journey\nA home', author: 'The poet' };
  collectNotebookPage(book, poem); collectNotebookPage(book, poem);
  assert.deepEqual(normalizeNotebook(JSON.parse(JSON.stringify(book))), book);
  assert.equal(book.collected.length, 1);
});
test('print edition contains notes, vector drawings and escaped personal text, but no invisible story content', () => {
  const book = createNotebook(); book.pages[0].text = '<script>bad()</script>';
  book.pages[0].strokes.push(notebookStroke([[0.2, 0.4], [0.7, 0.8]]));
  const result = notebookPrintHtml(book);
  assert.ok(result.includes('@page{size:A5'));
  assert.ok(result.includes('&lt;script&gt;')); assert.ok(!result.includes('<script>bad'));
  assert.ok(result.includes('<polyline')); assert.ok(!result.includes('FP-17'));
});
test('storage failure preserves editable pages and reports an exportable unsaved state', async () => {
  const store = new NotebookStore({ key: 'proof', indexedDB: null });
  const book = await store.load(); book.pages[0].text = 'My notes are still here.';
  assert.equal(await store.save(book), false);
  assert.ok(store.lastError); assert.equal(store.book.pages[0].text, 'My notes are still here.');
});
