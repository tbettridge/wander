const uid = () => globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(36).slice(2);
const copy = value => JSON.parse(JSON.stringify(value));
export function createNotebook() {
  return { version: 1, pages: [{ id: uid(), title: 'My travels', text: '', strokes: [] }], collected: [] };
}
export function normalizeNotebook(value) {
  if (value?.version !== 1 || !Array.isArray(value.pages)) return createNotebook();
  return { version: 1, pages: value.pages.filter(p => p && typeof p.id === 'string').map(p => ({
    id: p.id, title: String(p.title || 'Untitled page'), text: String(p.text || ''),
    strokes: (p.strokes || []).filter(s => Array.isArray(s.points)).map(s => ({
      id: String(s.id || uid()), color: s.color === 'erase' ? 'erase' : '#25352e',
      width: Math.max(1, Math.min(20, Number(s.width) || 3)),
      points: s.points.filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]),
    })),
  })), collected: (value.collected || []).filter(p => p?.id).map(p => ({
    id: String(p.id), title: String(p.title || 'Collected page'), text: String(p.text || ''), author: String(p.author || ''),
  })) };
}
export function addNotebookPage(book, title = 'Untitled page') {
  const page = { id: uid(), title, text: '', strokes: [] }; book.pages.push(page); return page;
}
export function collectNotebookPage(book, entry) {
  const existing = book.collected.find(page => page.id === entry.id);
  if (existing) return existing;
  const page = { id: String(entry.id), title: String(entry.title), text: String(entry.text), author: String(entry.author || '') };
  book.collected.push(page); return page;
}
export function notebookStroke(points, erase = false) {
  return { id: uid(), color: erase ? 'erase' : '#25352e', width: erase ? 16 : 3, points };
}
export function paintNotebookDrawing(ctx, page, width, height) {
  ctx.fillStyle = '#faf6e9'; ctx.fillRect(0, 0, width, height);
  for (const stroke of page.strokes || []) {
    ctx.strokeStyle = stroke.color === 'erase' ? '#faf6e9' : stroke.color;
    ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = 0; i < stroke.points.length; i++) {
      const [x, y] = stroke.points[i];
      if (i) ctx.lineTo(x * width, y * height); else ctx.moveTo(x * width, y * height);
    }
    ctx.stroke();
  }
}
export class NotebookStore {
  constructor({ key, indexedDB = globalThis.indexedDB }) {
    this.key = key; this.indexedDB = indexedDB; this.book = createNotebook(); this.lastError = null;
    this.chain = Promise.resolve(true);
  }
  async open() {
    if (this.db) return this.db;
    if (!this.indexedDB) throw new Error('Notebook storage is unavailable. Export your pages to keep them.');
    this.db = await new Promise((resolve, reject) => {
      const req = this.indexedDB.open('wander-courier-notebooks-v1', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('books')) req.result.createObjectStore('books'); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Another tab is preventing notebook storage from opening.'));
    });
    return this.db;
  }
  async load() {
    try {
      const db = await this.open();
      const raw = await new Promise((resolve, reject) => {
        const req = db.transaction('books', 'readonly').objectStore('books').get(this.key);
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      this.book = normalizeNotebook(raw); if (!this.book.pages.length) addNotebookPage(this.book);
      this.lastError = null;
    } catch (error) { this.lastError = error; }
    return this.book;
  }
  save(book = this.book) {
    this.book = book; const snapshot = copy(book);
    this.chain = this.chain.catch(() => false).then(async () => {
      try {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('books', 'readwrite');
          tx.objectStore('books').put(snapshot, this.key);
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        this.lastError = null; return true;
      } catch (error) { this.lastError = error; return false; }
    });
    return this.chain;
  }
  async clear() {
    await this.chain;
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readwrite'); tx.objectStore('books').delete(this.key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
}
const html = text => String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function notebookPrintHtml(book, { blankPages = 2 } = {}) {
  const drawing = page => '<svg viewBox="0 0 800 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="My drawn map"><rect width="800" height="480" fill="#faf6e9"/>'
    + (page.strokes || []).map(stroke => '<polyline fill="none" stroke="' + (stroke.color === 'erase' ? '#faf6e9' : '#25352e')
      + '" stroke-width="' + Number(stroke.width) + '" stroke-linecap="round" stroke-linejoin="round" points="'
      + stroke.points.map(([x, y]) => (x * 800).toFixed(2) + ',' + (y * 480).toFixed(2)).join(' ') + '"/>').join('') + '</svg>';
  const pages = [...book.pages, ...book.collected];
  return '<!doctype html><html lang="en"><meta charset="utf-8"><title>First Post — My journey book</title><style>'
    + '@page{size:A5;margin:12mm}body{font:12pt/1.5 Georgia,serif;color:#25352e;margin:0}section{break-after:page;overflow-wrap:anywhere}h1{font-size:28pt}h2{font-size:18pt}p{white-space:pre-wrap}svg{width:100%;max-height:75mm;break-inside:avoid}footer{font:9pt system-ui;color:#67766c;margin-top:8mm}.cover{padding-top:30mm}button{padding:12px;font-size:16px}@media print{button{display:none}}'
    + '</style><body><button onclick="window.print()">Print / Save as PDF</button><section class="cover"><h1>First Post</h1><p>My journey book\nWander</p><p>Routes I learned. People I met. Accounts I kept.</p></section>'
    + pages.map((page, i) => '<section><h2>' + html(page.title) + '</h2>' + (page.author ? '<p>' + html(page.author) + '</p>' : '')
      + '<p>' + html(page.text) + '</p>' + (page.strokes?.length ? drawing(page) : '') + '<footer>' + (i + 1) + '</footer></section>').join('')
    + Array.from({ length: Math.max(0, Math.min(12, blankPages)) }, (_, i) => '<section><h2>Notes from the road</h2><p style="height:135mm"></p><footer>' + (pages.length + i + 1) + '</footer></section>').join('') + '</body></html>';
}
