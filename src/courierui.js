import { COURIER_JOBS, COURIER_ROLES, COURIER_THREADS } from './couriercontent.mjs';
import { addNotebookPage, collectNotebookPage, notebookStroke, paintNotebookDrawing, notebookPrintHtml } from './notebook.mjs';

const element = (tag, text = '', className = '') => {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
};
const button = (label, run, disabled = false) => ({ label, run, disabled });
export class CourierUI {
  constructor({ controller, notebook, population, controls, renderer, onOpen, onClose, onRestart, onReturn, getNearbySources, canOpen = () => true }) {
    Object.assign(this, { controller, notebook, population, controls, renderer, onOpen, onClose, onRestart, onReturn, getNearbySources, canOpen });
    this.isOpen = false; this.view = 'notes'; this.pageId = notebook.book.pages[0]?.id;
    this.message = ''; this.chatDraft = ''; this.inputTarget = null; this.erase = false; this.dirty = true;
    this.revision = 0; this.keyboard = false; this.shift = false; this.editorTimer = null;
    const style = element('style');
    style.textContent = '#courier-panel{position:fixed;inset:6vh max(12px,calc((100vw - 1020px)/2));z-index:45;background:#f5efdd;color:#25352e;box-shadow:0 12px 80px #0009;border:1px solid #75846c;border-radius:14px;display:none;flex-direction:column;font:16px/1.5 Georgia,serif;overflow:hidden}#courier-panel header{padding:14px 20px;display:flex;gap:12px;align-items:center;background:#203e32;color:#f5efdd}#courier-panel h2{font-size:22px;margin:0;flex:1}#courier-panel nav{display:flex;gap:8px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid #75846c66}#courier-panel button{background:#e5ddc5;border:1px solid #859380;border-radius:7px;padding:8px 12px;color:#25352e;cursor:pointer;font:14px system-ui}#courier-panel button:disabled{opacity:.45;cursor:default}#courier-panel button:focus-visible{outline:3px solid #b88437}#courier-panel .content{padding:12px 22px;overflow:auto;flex:1;min-height:0}#courier-panel p{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}#courier-panel .actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}#courier-panel input,#courier-panel textarea{font:16px/1.5 Georgia,serif;color:#25352e;background:#faf6e9;border:1px solid #a2aa90;border-radius:6px;padding:10px;box-sizing:border-box;width:100%;margin:5px 0}#courier-panel textarea{min-height:100px}#courier-panel canvas{width:100%;max-height:32vh;border:1px solid #a2aa90;touch-action:none;background:#faf6e9}#courier-panel footer{padding:8px 20px;border-top:1px solid #75846c66;font:12px system-ui;white-space:pre-wrap}#courier-toast{position:fixed;bottom:10%;left:50%;transform:translateX(-50%);max-width:600px;padding:12px 20px;background:#203e32ee;color:#f5efdd;border-radius:10px;z-index:44;font:15px Georgia;pointer-events:none}';
    document.head.append(style);
    style.textContent += '.courier-route-hidden{display:none!important}#courier-panel canvas{display:block;width:min(100%,53.33vh);height:auto;max-height:none;aspect-ratio:5/3;margin:8px auto}';
    this.panel = element('section'); this.panel.id = 'courier-panel'; this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true'); this.panel.setAttribute('aria-label', 'First Post journey book');
    this.panel.addEventListener('click', e => e.stopPropagation());
    this.panel.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.append(this.panel);
    this.toast = element('div'); this.toast.id = 'courier-toast'; this.toast.style.display = 'none'; this.toast.setAttribute('role', 'status'); document.body.append(this.toast);
    this.unsub = controller.subscribe(result => {
      if (result.message) this.notify(result.message + (result.persisted === false ? '\nProgress is not saved. Keep this tab open and try saving again.' : ''));
      this.syncCollected(); this.render();
    });
    this.unsubDialogue = population.subscribeDialogue(() => {
      if (this.isOpen) { population.dialogueEl.style.display = 'none'; this.render(); }
    });
    this.onKey = event => {
      if (this.isOpen && event.code === 'Escape') { this.close(); event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable) return;
      if (event.code === 'KeyN' && !event.repeat) {
        if (!this.isOpen && !this.canOpen()) return;
        if (this.isOpen) this.close(); else this.open('notes');
        event.preventDefault(); event.stopImmediatePropagation();
      } else if (this.isOpen && event.code === 'Escape') {
        this.close(); event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', this.onKey, true);
    this.syncCollected();
  }
  npcId() { return this.population.dialogueOpen ? this.population.conversationNpcId : null; }
  setView(view) {
    if (view === 'conversation' && !this.population.dialogueOpen && this.population.activeNpc?.distance <= 4.5) {
      this.population.talk(); this.population.setPointerReleased();
    }
    this.view = view; this.keyboard = false; this.inputTarget = null; this.render();
  }
  open(view = 'notes') {
    if (!this.controller.story) return;
    if (!this.isOpen) {
      this.previousControls = { enabled: this.controls.enabled, allowLook: this.controls.allowLook };
      this.isOpen = true; this.controls.uiInputCaptured = true; this.controls.suspendInput();
      this.onOpen?.(); this.xr?.recenter();
    }
    this.view = view; this.panel.style.display = this.renderer.xr.isPresenting ? 'none' : 'flex';
    this.population.dialogueEl.style.display = 'none';
    if (view === 'conversation') {
      const id = this.npcId(), role = this.controller.roleFor(id);
      for (const job of COURIER_JOBS.filter(j => j.sender === role)) this.controller.learnOffer(job.id, id);
    }
    this.render();
  }
  close({ suspend = false } = {}) {
    if (!this.isOpen) return;
    this.stroke = null; this.flush();
    if (this.population.dialogueOpen) this.population.completeDialogueClose();
    this.isOpen = false; this.keyboard = false; this.controls.uiInputCaptured = false;
    this.controls.enabled = suspend ? false : this.previousControls?.enabled ?? true;
    this.controls.allowLook = this.previousControls?.allowLook ?? false;
    this.panel.style.display = 'none'; this.dirty = true; if (!suspend) this.onClose?.();
  }
  notify(text) {
    this.message = text; this.toast.textContent = text; this.toast.style.display = this.renderer.xr.isPresenting ? 'none' : 'block';
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { this.toast.style.display = 'none'; }, 6500);
    this.dirty = true;
  }
  action(result) {
    if (!result?.ok) this.notify(result?.reason || 'That action is unavailable.');
    if (result?.message && this.population.dialogueOpen) this.authoredLine(result.message);
    this.syncCollected(); this.render(); return result;
  }
  authoredLine(text) {
    if (!this.population.dialogueOpen) return;
    const entry = { role: 'assistant', content: text, source: 'authored', speakerId: this.npcId() };
    this.population.chatHistory.push(entry); this.population.limitChatHistory(); this.population.renderDialogue({ text }, 'authored', entry);
  }
  syncCollected() {
    if (!this.controller.story) return;
    const book = this.notebook.book;
    for (const [id, record] of Object.entries(this.controller.story.evidence)) {
      const source = this.controller.sources().find(s => s.sourceId === record.sourceIds[0]);
      if (source) collectNotebookPage(book, { id: 'evidence:' + id, title: source.title, text: source.text, author: 'Collected at ' + this.controller.story.bindings.places[source.place].name });
    }
    const work = this.controller.story.works.personal;
    if (work) collectNotebookPage(book, { id: 'work:personal', title: work.title, author: work.author,
      text: work.introduction + '\n\n' + work.lines.join('\n') });
    for (const [id, job] of Object.entries(this.controller.story.jobs)) {
      if (!job.attempts) continue;
      const def = COURIER_JOBS.find(j => j.id === id);
      collectNotebookPage(book, { id: 'brief:' + id, title: def.title, author: this.controller.npc(def.sender).name,
        text: def.description + '\nFor ' + this.controller.npc(def.recipient).name + ' at '
          + this.controller.story.bindings.places[COURIER_ROLES[def.recipient]].name
          + '\nHome address: ' + this.controller.npc(def.recipient).home.address
          + (def.serial ? '\nDispatch serial: ' + def.serial : '') });
    }
  }
  editPage() { return this.notebook.book.pages.find(p => p.id === this.pageId) || this.notebook.book.pages[0]; }
  markEdited() {
    this.dirty = true; clearTimeout(this.editorTimer);
    this.editorTimer = setTimeout(() => this.flush(), 300);
  }
  async flush() {
    clearTimeout(this.editorTimer);
    const saved = await this.notebook.save();
    if (!saved) this.notify('Your pages are still editable, but are not saved. Export them to keep a copy.');
    this.renderFooter(); return saved;
  }
  readSource(source, speakerId = null) {
    const result = this.controller.discover(source.sourceId, speakerId);
    if (!result.ok) return this.action(result);
    this.document = { title: source.title, text: source.text }; this.view = 'document';
    this.syncCollected(); this.flush(); this.render();
  }
  directions(destination) {
    const id = this.npcId(), context = this.controller.contextForNpc(id);
    const route = context?.routes?.find(r => r.place === destination);
    if (!route) return this.notify('Ask someone who knows the local road.');
    this.authoredLine(route.instructions);
    const actor = this.population.actorById(id);
    const target = this.population.contextForActor(actor)?.targets?.find(t => t.id === route.targetId);
    if (actor && target) this.population.pointOut(actor, target, 3.5);
    collectNotebookPage(this.notebook.book, { id: 'route:' + id + ':' + destination,
      title: 'Directions to ' + route.name, author: this.controller.state.entities[id].name, text: route.instructions });
    this.flush(); this.render();
  }
  screen() {
    const c = this.controller, npcId = this.npcId(), role = c.roleFor(npcId);
    const screen = { title: 'First Post', paragraphs: [], buttons: [], fields: [], drawing: null };
    if (this.view === 'conversation') {
      screen.title = this.population.activeNpc?.identity.name || 'Conversation';
      screen.paragraphs = this.population.dialogueSnapshot().messages.slice(-5).map(m => (m.role === 'user' ? 'You: ' : '') + m.text);
      if (this.population.chatBusy) screen.paragraphs.push('Thinking…');
      screen.fields.push({ id: 'chat', label: 'Your message', value: this.chatDraft });
      screen.buttons.push(button('Send message', () => {
        this.population.setPointerReleased(); this.population.sendMessage(this.chatDraft); this.chatDraft = ''; this.render();
      }, this.population.chatBusy || !this.chatDraft.trim()));
      if (role) {
        for (const def of COURIER_JOBS) {
          const job = c.story.jobs[def.id];
          if (def.sender === role && job.state !== 'delivered') {
            screen.paragraphs.push(def.title + ': ' + def.description + '\nFor ' + c.npc(def.recipient).name + ' at ' + c.story.bindings.places[COURIER_ROLES[def.recipient]].name + '\nHome address: ' + c.npc(def.recipient).home.address);
            if (job.state === 'active') screen.buttons.push(button('Return ' + def.title, () => this.action(c.handoff(def.id, npcId, true))));
            else {
              screen.buttons.push(button('Accept ' + def.title, () => this.action(c.accept(def.id, npcId))));
              screen.buttons.push(button('Pass on this offer', () => this.action(c.decline(def.id, npcId))));
            }
          }
          if (def.recipient === role && job.state === 'active') screen.buttons.push(button('Deliver ' + def.title, () => this.action(c.handoff(def.id, npcId))));
        }
        for (const route of c.contextForNpc(npcId).routes) screen.buttons.push(button('Ask the way to ' + route.name, () => this.directions(route.place)));
        for (const lesson of c.contextForNpc(npcId).travelLessons) screen.buttons.push(button('Ask: ' + lesson.title, () => {
          this.authoredLine(lesson.text);
          collectNotebookPage(this.notebook.book, { id: 'lesson:' + lesson.id, title: lesson.title,
            author: c.state.entities[npcId].name, text: lesson.text });
          this.flush(); this.render();
        }));
        for (const source of c.sources().filter(s => s.place === COURIER_ROLES[role])) {
          screen.buttons.push(button('Read: ' + source.title, () => this.readSource(source, npcId)));
        }
        if (Object.keys(c.story.evidence).length) screen.buttons.push(button('Share my collected evidence', () => this.action(c.shareEvidence(npcId, Object.keys(c.story.evidence)))));
        if (role === 'poet') screen.buttons.push(button(c.story.works.personal ? 'Read my poem' : 'Tell the poet about my journey', async () => {
          this.notify('The poet is putting your account into words…'); this.render();
          const result = await c.shareJourney(npcId); this.action(result);
          if (result.work) { this.document = { title: result.work.title, text: result.work.introduction + '\n\n' + result.work.lines.join('\n') }; this.setView('document'); this.flush(); }
        }));
      }
    } else if (this.view === 'satchel') {
      screen.title = 'My satchel';
      const active = Object.values(c.story.jobs).filter(j => j.state === 'active');
      screen.paragraphs.push(active.length + ' / 3 parcels. There are no deadlines. You can finish or return a parcel before taking another.');
      for (const def of COURIER_JOBS.filter(j => c.story.knownOffers[j.id])) {
        const job = c.story.jobs[def.id];
        screen.paragraphs.push(def.title + ' — ' + job.state + (def.fragile ? ' · ' + job.condition : '') + '\n'
          + 'From ' + c.npc(def.sender).name + ' to ' + c.npc(def.recipient).name + ' at ' + c.story.bindings.places[COURIER_ROLES[def.recipient]].name + '\nHome address: ' + c.npc(def.recipient).home.address);
        if (job.state === 'active') {
          screen.buttons.push(button('Deliver ' + def.title, () => this.action(c.handoff(def.id, c.npc(def.recipient).id)), !c.nearby(c.npc(def.recipient).id)));
          screen.buttons.push(button('Return ' + def.title, () => this.action(c.handoff(def.id, c.npc(def.sender).id, true)), !c.nearby(c.npc(def.sender).id)));
        }
      }
      if (!Object.keys(c.story.knownOffers).length) screen.paragraphs.push('Ask a local resident about work. You can explore and read their accounts even if you pass on every delivery.');
    } else if (this.view === 'stories') {
      screen.title = 'Accounts and questions';
      const nearby = this.getNearbySources();
      for (const source of nearby) screen.buttons.push(button('Read nearby: ' + source.title, () => this.readSource(source)));
      for (const thread of COURIER_THREADS) {
        const found = thread.evidence.filter(id => c.story.evidence[id]);
        if (!found.length) continue;
        screen.paragraphs.push(thread.title + ' — ' + found.length + ' / 2 accounts' + (c.story.compared[thread.id] ? '\n' + thread.comparison : ''));
        screen.buttons.push(button('Compare: ' + thread.title, () => this.action(c.compare(thread.id)), found.length < 2));
      }
      screen.buttons.push(button('Consider the larger pattern', () => this.action(c.formHypothesis()), Object.keys(c.story.compared).length < 2));
      if (c.story.hypothesis) screen.paragraphs.push('A first hypothesis: perhaps the records and recollections are repeating parts of other lives. You can share these accounts with any of the people you meet.');
      if (!Object.keys(c.story.evidence).length && !nearby.length) screen.paragraphs.push('Ask people about local accounts, or examine the public reading stands. There is no required job or investigator.');
    } else if (this.view === 'document') {
      screen.title = this.document?.title || 'Collected page'; screen.paragraphs.push(this.document?.text || '');
      screen.buttons.push(button('Back to accounts', () => this.setView('stories')));
      if (this.population.dialogueOpen) screen.buttons.push(button('Back to conversation', () => this.setView('conversation')));
    } else if (this.view === 'library') {
      screen.title = 'Collected pages';
      for (const page of this.notebook.book.collected) screen.buttons.push(button(page.title, () => { this.document = page; this.setView('document'); }));
      if (!screen.buttons.length) screen.paragraphs.push('Directions, accepted delivery briefs, accounts and poems you collect appear here.');
    } else {
      screen.title = 'My notebook';
      const page = this.editPage();
      screen.buttons.push(button('New page', () => { this.pageId = addNotebookPage(this.notebook.book).id; this.markEdited(); this.render(); }));
      for (const entry of this.notebook.book.pages) screen.buttons.push(button(entry.title, () => { this.pageId = entry.id; this.render(); }));
      if (page) {
        screen.fields.push({ id: 'title', label: 'Page title', value: page.title }, { id: 'note', label: 'Write a note', value: page.text, multiline: true });
        screen.drawing = page;
        if (this.controller.roleFor(this.npcId()) === 'poet' && !this.controller.story.works.personal) {
          screen.buttons.push(button('Share this page with the poet', async () => {
            this.notify('The poet is writing from the journey and this selected page…');
            this.action(await this.controller.shareJourney(this.npcId(), page.text)); this.flush(); this.render();
          }));
        }
        screen.buttons.push(button(this.erase ? 'Use pen' : 'Use eraser', () => { this.erase = !this.erase; this.render(); }));
        screen.buttons.push(button('Undo last stroke', () => { page.strokes.pop(); this.markEdited(); this.render(); }, !page.strokes.length));
        screen.buttons.push(button('Delete this page', () => {
          if (!this.renderer.xr.isPresenting && !confirm('Delete this notebook page?')) return;
          if (this.renderer.xr.isPresenting && !this.deleteConfirm) { this.deleteConfirm = true; this.notify('Select Delete this page again to confirm.'); return this.render(); }
          this.deleteConfirm = false; this.notebook.book.pages = this.notebook.book.pages.filter(p => p.id !== page.id);
          if (!this.notebook.book.pages.length) addNotebookPage(this.notebook.book);
          this.pageId = this.notebook.book.pages[0].id; this.markEdited(); this.render();
        }));
      }
      screen.buttons.push(button('Print / Save as PDF', () => this.print()));
      screen.buttons.push(button('Export notebook', () => this.export()));
      screen.buttons.push(button('Return to normal Wander', () => { this.flush().then(() => this.onReturn?.()); }));
      screen.buttons.push(button('Restart First Post', () => {
        if (this.renderer.xr.isPresenting && !this.restartConfirm) { this.restartConfirm = true; this.notify('Restart erases this proof’s progress and notebook. Select Restart First Post again to confirm.'); return this.render(); }
        if (!this.renderer.xr.isPresenting && !confirm('Restart First Post? This erases only this prototype’s progress and notebook pages.')) return;
        this.onRestart?.().catch(error => this.notify('The proof could not be reset: ' + error.message));
      }));
    }
    return screen;
  }
  fieldChanged(id, value) {
    if (id === 'chat') this.chatDraft = value.slice(0, 320);
    else { const page = this.editPage(); if (!page) return;
      if (id === 'title') page.title = value.slice(0, 100); else page.text = value;
      this.markEdited(); }
    this.dirty = true;
  }
  startStroke(x, y) {
    const page = this.editPage(); if (!page || this.view !== 'notes') return;
    this.stroke = notebookStroke([[x, y]], this.erase); page.strokes.push(this.stroke); this.markEdited();
  }
  moveStroke(x, y) {
    if (!this.stroke) return;
    const last = this.stroke.points.at(-1);
    if (Math.hypot(last[0] - x, last[1] - y) < 0.002) return;
    this.stroke.points.push([x, y]); this.markEdited();
  }
  endStroke() { this.stroke = null; this.flush(); this.render(); }
  render() {
    this.revision++; this.dirty = true;
    if (!this.isOpen || this.renderer.xr.isPresenting) { this.panel.style.display = 'none'; return; }
    const focus = document.activeElement?.dataset?.field;
    const selection = focus ? document.activeElement.selectionStart : null;
    const screen = this.screen(); this.panel.replaceChildren();
    const header = element('header'); header.append(element('h2', screen.title));
    const close = element('button', 'Close · N / Esc'); close.onclick = () => this.close(); header.append(close);
    const nav = element('nav');
    for (const [id, label] of [['conversation', 'Conversation'], ['satchel', 'Satchel'], ['notes', 'Notebook'], ['library', 'Collected pages'], ['stories', 'Questions']]) {
      const b = element('button', label); b.disabled = id === 'conversation' && !this.population.dialogueOpen && !(this.population.activeNpc?.distance <= 4.5);
      b.onclick = () => this.setView(id); nav.append(b);
    }
    const content = element('div', '', 'content');
    for (const text of screen.paragraphs) content.append(element('p', text));
    for (const field of screen.fields) {
      const label = element('label', field.label); const input = element(field.multiline ? 'textarea' : 'input');
      input.value = field.value; input.dataset.field = field.id;
      input.oninput = () => { this.fieldChanged(field.id, input.value); if (field.id === 'chat') {
        const send = this.panel.querySelector('[data-send]'); if (send) send.disabled = !this.chatDraft.trim() || this.population.chatBusy;
      } };
      if (field.id === 'chat') input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.population.setPointerReleased(); this.population.sendMessage(this.chatDraft); this.chatDraft = ''; this.render(); } };
      label.append(input); content.append(label);
    }
    if (screen.drawing) {
      const canvas = element('canvas'); canvas.width = 800; canvas.height = 480; canvas.setAttribute('aria-label', 'Draw a map or notes');
      const ctx = canvas.getContext('2d'); paintNotebookDrawing(ctx, screen.drawing, 800, 480);
      const point = event => { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (event.clientY - r.top) / r.height))]; };
      canvas.onpointerdown = event => { canvas.setPointerCapture(event.pointerId); this.startStroke(...point(event)); paintNotebookDrawing(ctx, screen.drawing, 800, 480); };
      canvas.onpointermove = event => { if (!this.stroke) return; this.moveStroke(...point(event)); paintNotebookDrawing(ctx, screen.drawing, 800, 480); };
      canvas.onpointerup = () => this.endStroke(); canvas.onpointercancel = () => this.endStroke(); content.append(canvas);
    }
    const actions = element('div', '', 'actions');
    for (const action of screen.buttons) {
      const b = element('button', action.label); b.disabled = action.disabled; b.onclick = action.run;
      if (action.label === 'Send message') b.dataset.send = 'true'; actions.append(b);
    }
    content.append(actions); this.footer = element('footer');
    this.panel.append(header, nav, content, this.footer); this.renderFooter();
    if (focus) {
      const input = this.panel.querySelector('[data-field="' + focus + '"]');
      input?.focus({ preventScroll: true }); if (selection != null) input?.setSelectionRange(selection, selection);
    }
  }
  renderFooter() {
    if (this.footer) this.footer.textContent = (this.notebook.lastError ? 'Pages not saved — export a copy. ' : '') + this.message;
    this.dirty = true;
  }
  async print() {
    if (this.renderer.xr.isPresenting) return this.notify('Your pages are shared with desktop. Leave VR when you want to print or save a PDF.');
    const tab = window.open('', '_blank');
    if (!tab) return this.notify('Allow a new tab to open the printable journey book. You can also export the notebook.');
    await this.flush(); tab.document.open(); tab.document.write(notebookPrintHtml(this.notebook.book)); tab.document.close();
  }
  export() {
    if (this.renderer.xr.isPresenting) return this.notify('Use Export notebook after returning to desktop to download these same pages.');
    const blob = new Blob([JSON.stringify(this.notebook.book, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = 'first-post-notebook.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  dispose() {
    this.close(); this.unsub(); this.unsubDialogue(); window.removeEventListener('keydown', this.onKey, true);
    this.panel.remove(); this.toast.remove(); clearTimeout(this.toastTimer);
  }
}
