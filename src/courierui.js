import { COURIER_JOBS, COURIER_ROLES, COURIER_THREADS } from './couriercontent.mjs';
import { addNotebookPage, collectNotebookPage, notebookStroke, paintNotebookDrawing, notebookPrintHtml } from './notebook.mjs';

const element = (tag, text = '', className = '') => {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
};
const button = (label, run, disabled = false) => ({ label, run, disabled });
export class CourierUI {
  constructor({ controller, notebook, population, controls, renderer, onOpen, onClose, onRestart, onReturn,
    getNearbySources, getNearbyBoards = () => [], onVisitContact, canOpen = () => true }) {
    Object.assign(this, { controller, notebook, population, controls, renderer, onOpen, onClose, onRestart, onReturn,
      getNearbySources, getNearbyBoards, onVisitContact, canOpen });
    this.isOpen = false; this.view = 'next'; this.pageId = notebook.book.pages[0]?.id;
    this.message = ''; this.chatDraft = ''; this.inputTarget = null; this.erase = false; this.dirty = true;
    this.revision = 0; this.keyboard = false; this.shift = false; this.editorTimer = null;
    this.focusedJobId = null; this.reminderDismissed = false;
    const style = element('style');
    style.textContent = '#courier-panel{position:fixed;inset:6vh max(12px,calc((100vw - 1020px)/2));z-index:45;background:#f5efdd;color:#25352e;box-shadow:0 12px 80px #0009;border:1px solid #75846c;border-radius:14px;display:none;flex-direction:column;font:16px/1.5 Georgia,serif;overflow:hidden}#courier-panel header{padding:14px 20px;display:flex;gap:12px;align-items:center;background:#203e32;color:#f5efdd}#courier-panel h2{font-size:22px;margin:0;flex:1}#courier-panel nav{display:flex;gap:8px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid #75846c66}#courier-panel button{background:#e5ddc5;border:1px solid #859380;border-radius:7px;padding:8px 12px;color:#25352e;cursor:pointer;font:14px system-ui}#courier-panel button:disabled{opacity:.45;cursor:default}#courier-panel button:focus-visible{outline:3px solid #b88437}#courier-panel .content{padding:12px 22px;overflow:auto;flex:1;min-height:0}#courier-panel p{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}#courier-panel .actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}#courier-panel input,#courier-panel textarea{font:16px/1.5 Georgia,serif;color:#25352e;background:#faf6e9;border:1px solid #a2aa90;border-radius:6px;padding:10px;box-sizing:border-box;width:100%;margin:5px 0}#courier-panel textarea{min-height:100px}#courier-panel canvas{width:100%;max-height:32vh;border:1px solid #a2aa90;touch-action:none;background:#faf6e9}#courier-panel footer{padding:8px 20px;border-top:1px solid #75846c66;font:12px system-ui;white-space:pre-wrap}#courier-toast{position:fixed;bottom:10%;left:50%;transform:translateX(-50%);max-width:600px;padding:12px 20px;background:#203e32ee;color:#f5efdd;border-radius:10px;z-index:44;font:15px Georgia;pointer-events:none}';
    document.head.append(style);
    style.textContent += '#courier-reminder{position:fixed;left:16px;bottom:16px;z-index:42;max-width:min(420px,calc(100vw - 32px));display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:#203e32ee;color:#f5efdd;border:1px solid #75846c;border-radius:10px;box-shadow:0 6px 28px #0007;font:14px/1.4 system-ui}#courier-reminder .courier-reminder-copy{flex:1;min-width:0}#courier-reminder strong{display:block;margin-bottom:3px}#courier-reminder button{background:#e5ddc5;border:1px solid #859380;border-radius:6px;padding:5px 8px;color:#25352e;cursor:pointer;font:12px system-ui;white-space:nowrap}#courier-reminder .courier-reminder-actions{display:flex;gap:5px}#courier-panel .courier-guidance{padding:12px 14px;background:#e9e2cd;border-left:4px solid #b88437;border-radius:4px}#courier-panel .courier-card{padding:10px 12px;margin:10px 0;background:#faf6e9;border:1px solid #a2aa90;border-radius:7px}';
    style.textContent += '.courier-route-hidden{display:none!important}#courier-panel canvas{display:block;width:min(100%,53.33vh);height:auto;max-height:none;aspect-ratio:5/3;margin:8px auto}';
    this.panel = element('section'); this.panel.id = 'courier-panel'; this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true'); this.panel.setAttribute('aria-label', 'First Post journey book');
    this.panel.addEventListener('click', e => e.stopPropagation());
    this.panel.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.append(this.panel);
    this.toast = element('div'); this.toast.id = 'courier-toast'; this.toast.style.display = 'none'; this.toast.setAttribute('role', 'status'); document.body.append(this.toast);
    this.reminder = element('aside', '', 'courier-reminder'); this.reminder.id = 'courier-reminder';
    this.reminder.setAttribute('aria-label', 'First Post next step'); this.reminder.style.display = 'none'; document.body.append(this.reminder);
    this.unsub = controller.subscribe(result => {
      if (result.message) this.notify(result.message + (result.persisted === false ? '\nProgress is not saved. Keep this tab open and try saving again.' : ''));
      this.syncCollected(); this.render(); this.renderReminder();
    });
    this.unsubDialogue = population.subscribeDialogue(() => {
      if (this.isOpen) { population.dialogueEl.style.display = 'none'; this.render(); }
    });
    this.onKey = event => {
      if (this.isOpen && event.code === 'Escape') { this.close(); event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable) return;
      if (event.code === 'KeyN' && !event.repeat) {
        if (!this.isOpen && !this.canOpen()) return;
        if (this.isOpen) this.close(); else this.open();
        event.preventDefault(); event.stopImmediatePropagation();
      } else if (this.isOpen && event.code === 'Escape') {
        this.close(); event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', this.onKey, true);
    this.syncCollected(); this.renderReminder();
  }
  npcId() { return this.population.dialogueOpen ? this.population.conversationNpcId : null; }
  setView(view) {
    if (this.view === 'welcome' && view !== 'welcome') this.markWelcomeExplored();
    if (view === 'conversation' && !this.population.dialogueOpen && this.population.activeNpc?.distance <= 4.5) {
      this.population.talk(); this.population.setPointerReleased();
    }
    this.view = view; this.keyboard = false; this.inputTarget = null; this.render();
    if (view === 'conversation') this.learnConversationLeads();
  }
  open(view = 'next') {
    if (!this.controller.story) return;
    if (!this.isOpen) {
      this.previousControls = { enabled: this.controls.enabled, allowLook: this.controls.allowLook };
      this.isOpen = true; this.controls.uiInputCaptured = true; this.controls.suspendInput();
      this.onOpen?.(); this.xr?.recenter();
    }
    if (view === 'conversation' && !this.population.dialogueOpen && this.population.activeNpc?.distance <= 4.5) {
      this.population.talk(); this.population.setPointerReleased();
    }
    this.view = view; this.panel.style.display = this.renderer.xr.isPresenting ? 'none' : 'flex';
    this.population.dialogueEl.style.display = 'none';
    if (view === 'conversation') this.learnConversationLeads();
    this.render(); this.renderReminder();
  }
  close({ suspend = false } = {}) {
    if (!this.isOpen) return;
    if (this.view === 'welcome') this.markWelcomeExplored();
    this.stroke = null; this.flush();
    if (this.population.dialogueOpen) this.population.completeDialogueClose();
    this.isOpen = false; this.keyboard = false; this.controls.uiInputCaptured = false;
    this.controls.enabled = suspend ? false : this.previousControls?.enabled ?? true;
    this.controls.allowLook = this.previousControls?.allowLook ?? false;
    this.panel.style.display = 'none'; this.dirty = true; this.renderReminder(); if (!suspend) this.onClose?.();
  }
  markWelcomeExplored() {
    if (this.controller.story?.onboarding?.seen) return;
    const result = this.controller.chooseWelcome?.('explore');
    if (result?.ok === false) this.notify(result.reason || 'The welcome choice could not be saved.');
  }
  chooseWelcome(choice) {
    const result = this.controller.chooseWelcome?.(choice);
    if (!result) { this.notify('Welcome choices are unavailable right now.'); return; }
    if (!result.ok) return this.action(result);
    this.reminderDismissed = false;
    if (choice === 'easy') {
      this.focusedJobId = 'village-note';
      this.controller.focusJob?.(this.focusedJobId);
      this.view = 'leads';
    } else if (choice === 'explain') this.view = 'help';
    else { this.view = 'next'; this.close(); return; }
    this.render(); this.renderReminder();
  }
  renderReminder() {
    if (!this.reminder) return;
    const onboarding = this.controller.story?.onboarding;
    const reason = this.renderer.xr.isPresenting ? 'xr' : this.isOpen ? 'open'
      : !this.canOpen() ? 'unavailable' : !this.controller.story ? 'no-story'
        : onboarding?.hintsEnabled === false ? 'disabled' : this.reminderDismissed ? 'dismissed' : '';
    if (reason) {
      const key = 'hidden:' + reason;
      if (this.reminderStateKey !== key) this.reminder.style.display = 'none';
      this.reminderStateKey = key; return;
    }
    let guidance;
    try { guidance = this.controller.guidance?.(); } catch { guidance = null; }
    if (!guidance?.text) {
      if (this.reminderStateKey !== 'hidden:no-guidance') this.reminder.style.display = 'none';
      this.reminderStateKey = 'hidden:no-guidance'; return;
    }
    const key = ['visible', guidance.title || '', guidance.text].join('\n');
    if (this.reminderStateKey === key && this.reminder.style.display !== 'none') return;
    this.reminder.replaceChildren();
    const copy = element('div', '', 'courier-reminder-copy');
    copy.append(element('strong', guidance.title || 'Next step'), element('span', guidance.text));
    const actions = element('div', '', 'courier-reminder-actions');
    const open = element('button', 'Open book'); open.onclick = () => this.open('next');
    const dismiss = element('button', 'Hide'); dismiss.setAttribute('aria-label', 'Hide next step reminder');
    dismiss.onclick = () => { this.reminderDismissed = true; this.reminder.style.display = 'none'; };
    actions.append(open, dismiss); this.reminder.append(copy, actions); this.reminder.style.display = 'flex';
    this.reminderStateKey = key;
  }
  localOpportunityCards(npcId = this.npcId()) {
    if (!npcId) return [];
    const direct = this.controller.localOpportunities?.(npcId);
    const contextual = this.controller.contextForNpc(npcId)?.localOpportunities;
    return Array.isArray(direct) ? direct : Array.isArray(contextual) ? contextual : [];
  }
  learnConversationLeads() {
    const npcId = this.npcId();
    if (!npcId) return;
    const role = this.controller.roleFor(npcId);
    for (const job of COURIER_JOBS.filter(def => def.sender === role)) this.controller.learnOffer(job.id, npcId);
    const context = this.controller.contextForNpc(npcId);
    const opportunities = this.localOpportunityCards(npcId);
    const place = context?.place ?? context?.placeKey ?? this.controller.getNpcPlace?.(npcId);
    if (opportunities.length && place && this.controller.learnReferrals) {
      const result = this.controller.learnReferrals(npcId, place);
      if (result?.ok === false) this.notify(result.reason || 'These local referrals are unavailable.');
    }
  }
  nearbyBoards() {
    try { return this.getNearbyBoards?.() || []; } catch { return []; }
  }
  cardsAt(place) {
    try { return this.controller.boardJobs?.(place) || []; } catch { return []; }
  }
  allPublicCards() {
    const story = this.controller.story || {}, places = new Set();
    for (const [key, place] of Object.entries(story.bindings?.places || {})) {
      places.add(key);
      if (typeof place === 'string') places.add(place);
      else { if (place?.id) places.add(place.id); if (place?.key) places.add(place.key); }
    }
    for (const board of this.nearbyBoards()) if (board?.place) places.add(board.place);
    const cards = new Map();
    for (const place of places) for (const card of this.cardsAt(place)) {
      const id = card?.id || card?.jobId;
      if (id) cards.set(id, card);
    }
    for (const value of Object.values(story.leads || {})) {
      const card = value?.card || value?.job;
      const id = card?.id || card?.jobId;
      if (id && card.title) cards.set(id, card);
    }
    return cards;
  }
  knownLeadIds() {
    const story = this.controller.story || {}, ids = new Set();
    const add = value => {
      const id = typeof value === 'string' ? value : value?.jobId || value?.id;
      if (id && COURIER_JOBS.some(job => job.id === id)) ids.add(id);
    };
    const leads = story.leads;
    if (Array.isArray(leads)) for (const lead of leads) add(lead);
    else for (const [key, value] of Object.entries(leads || {})) {
      if (value && typeof value === 'object' && (value.jobId || value.id)) add(value);
      else if (key.startsWith('job:') && value) add(key.slice(4));
    }
    for (const id of Object.keys(story.knownOffers || {})) add(id);
    for (const [id, job] of Object.entries(story.jobs || {})) if (job.attempts > 0) add(id);
    if (story.focusJobId) add(story.focusJobId);
    if (this.focusedJobId) add(this.focusedJobId);
    return [...ids];
  }
  cardForDefinition(id) {
    const def = COURIER_JOBS.find(job => job.id === id), c = this.controller;
    if (!def) return null;
    const sender = c.npc(def.sender), recipient = c.npc(def.recipient), rolePlaces = c.story.bindings?.places || {};
    const senderPlace = rolePlaces[COURIER_ROLES[def.sender]], recipientPlace = rolePlaces[COURIER_ROLES[def.recipient]];
    const placeName = place => typeof place === 'string' ? place : place?.name || '';
    const address = person => person?.home?.address || person?.address || '';
    return { id, title: def.title, description: def.description, state: c.story.jobs[id]?.state,
      local: !!senderPlace && (senderPlace?.id || senderPlace) === (recipientPlace?.id || recipientPlace), kind: def.kind,
      sender: { id: sender?.id, name: sender?.name || 'the sender', place: placeName(senderPlace), home: { address: address(sender) } },
      recipient: { id: recipient?.id, name: recipient?.name || 'the recipient', place: placeName(recipientPlace), home: { address: address(recipient) } } };
  }
  leadCard(id) { return this.allPublicCards().get(id) || this.cardForDefinition(id); }
  cardPlaceName(card, side) {
    const person = card?.[side] || {}, value = person.place;
    const bound = this.controller.story?.bindings?.places?.[value];
    const supplied = side === 'sender'
      ? person.placeName || card?.senderPlaceName
      : person.placeName || card?.recipientPlaceName || card?.destinationName;
    if (supplied) return supplied;
    if (bound?.name) return bound.name;
    if (value && typeof value === 'object') return value.name || '';
    return typeof value === 'string' && !['A', 'B', 'H'].includes(value) ? value : '';
  }
  focusLead(jobId) {
    const result = this.controller.focusJob?.(jobId);
    if (result?.ok === false) return this.action(result);
    this.focusedJobId = jobId; this.view = 'leads'; this.render();
  }
  readBoard(place) {
    const result = this.controller.readBoard?.(place);
    if (!result) return this.notify('That board cannot be read right now.');
    if (!result.ok) return this.action(result);
    const jobs = result.jobs || this.cardsAt(place);
    if (jobs.length === 1) this.focusedJobId = jobs[0].id || jobs[0].jobId;
    else this.focusedJobId = null;
    if (result.applied === false && result.message) this.notify(result.message);
    this.view = 'leads'; this.action(result);
  }
  visitContact(jobId) {
    const card = this.leadCard(jobId);
    if (!card?.sender?.id) return this.notify('The sender’s address is not available yet. Read the local board or ask a neighbor about this lead.');
    this.controller.focusJob?.(jobId);
    const visit = { jobId, contactId: card.sender.id, place: this.cardPlaceName(card, 'sender'), address: card.sender.home?.address || '', name: card.sender.name };
    if (this.onVisitContact) this.onVisitContact(visit);
    else {
      this.close();
      this.notify(`Meet ${visit.name} at ${visit.address}. Press T to talk; open the book with N for your next step.`);
    }
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
    const collectedBefore = book.collected.length;
    collectNotebookPage(book, { id: 'guide:first-post', title: 'Welcome to First Post', author: 'The courier desk',
      text: 'Work is optional and deliveries have no deadlines. The Next page gives one clear thing you can do now. Read the Post & Errands boards or ask a neighbor for a local referral to find work.\n\nMeet a sender in person to hear more. A lead shows names and home addresses; it never accepts the delivery for you. Accept only while beside the sender.\n\nDesktop: T talks to a nearby person, E reads or interacts, and N opens this book. VR: right grip opens or closes the book; point and press the right trigger to choose buttons or draw on a notebook page.' });
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
    for (const id of this.knownLeadIds()) {
      const card = this.leadCard(id);
      if (!card) continue;
      const sender = card.sender || {}, recipient = card.recipient || {};
      collectNotebookPage(book, { id: 'lead:' + id, title: card.title || 'Local delivery lead', author: 'A local referral or public board',
        text: (card.description || 'A local delivery opportunity.') + '\nFrom: ' + (sender.name || 'Unknown sender')
          + (this.cardPlaceName(card, 'sender') ? ' in ' + this.cardPlaceName(card, 'sender') : '') + '\nSender home: ' + (sender.home?.address || 'Ask locally')
          + '\nFor: ' + (recipient.name || 'Unknown recipient') + (this.cardPlaceName(card, 'recipient') ? ' in ' + this.cardPlaceName(card, 'recipient') : '')
          + '\nRecipient home: ' + (recipient.home?.address || 'Ask locally')
          + '\n\nMeet the sender and talk in person. Reading or choosing this lead does not accept it.' });
    }
    if (book.collected.length !== collectedBefore) this.flush();
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
    if (this.view === 'welcome') {
      screen.title = 'Welcome to First Post';
      screen.paragraphs.push('Work is optional. You can explore first, ask people what is happening nearby, or read a public Post & Errands board. Choosing an idea never accepts a delivery.');
      screen.buttons.push(button('Show me an easy delivery', () => this.chooseWelcome('easy')));
      screen.buttons.push(button('Explain how this works', () => this.chooseWelcome('explain')));
      screen.buttons.push(button('I’ll explore first', () => this.chooseWelcome('explore')));
    } else if (this.view === 'next') {
      screen.title = 'Your next step';
      const guidance = c.guidance?.();
      screen.paragraphs.push((guidance?.title ? guidance.title + '\n' : '')
        + (guidance?.text || 'Explore freely, talk with a nearby person, or read a public board. Your work is optional.'));
      screen.paragraphs.push('Desktop: T talks · E reads or interacts · N opens this book.\nVR: right grip opens or closes the book; point and press the right trigger to choose.');
      if (guidance?.jobId) screen.buttons.push(button('Review this delivery lead', () => this.focusLead(guidance.jobId)));
      screen.buttons.push(button('See local leads and boards', () => this.setView('leads')));
      screen.buttons.push(button('Talk with a nearby person', () => this.setView('conversation'), !this.population.dialogueOpen && !(this.population.activeNpc?.distance <= 4.5)));
      screen.buttons.push(button('Read the controls and help', () => this.setView('help')));
    } else if (this.view === 'leads') {
      screen.title = 'Local leads';
      screen.paragraphs.push('Read a board or choose a referral to see both addresses. Meet the sender in person to hear more; this page never accepts a delivery.');
      const boards = this.nearbyBoards();
      for (const board of boards) {
        const cards = this.cardsAt(board.place);
        screen.paragraphs.push('Post & Errands — ' + (board.name || board.place)
          + (board.contactHint ? '\n' + board.contactHint : board.contactName
            ? '\nContact: ' + board.contactName + '. Home address: ' + (board.address || 'ask locally') : ''));
        for (const card of cards) screen.paragraphs.push((card.title || 'Local opportunity') + ': ' + (card.description || 'A delivery opportunity is posted here.'));
        screen.buttons.push(button('Read board: ' + (board.name || board.place), () => this.readBoard(board.place)));
      }
      const ids = this.knownLeadIds();
      const cards = ids.map(id => this.leadCard(id)).filter(Boolean).sort((a, b) => {
        if (a.id === 'village-note') return -1;
        if (b.id === 'village-note') return 1;
        if (!!a.local !== !!b.local) return a.local ? -1 : 1;
        return String(a.title).localeCompare(String(b.title));
      });
      const focusedId = this.focusedJobId || c.story.focusJobId || null;
      const focused = cards.find(card => card.id === focusedId);
      for (const card of cards) {
        const status = c.story.jobs[card.id]?.state || card.state || 'lead';
        const localNote = card.id === 'village-note' ? ' · easy local errand' : card.local ? ' · local' : '';
        screen.paragraphs.push((card.title || 'Delivery lead') + localNote + ' — ' + status);
        screen.buttons.push(button('Choose: ' + card.title, () => this.focusLead(card.id)));
      }
      if (focused) {
        const sender = focused.sender || {}, recipient = focused.recipient || {};
        screen.paragraphs.push('\n' + focused.title + (focused.id === 'village-note' ? ' · First local errand' : '')
          + '\n' + (focused.description || '')
          + '\nFrom: ' + (sender.name || 'Unknown sender') + (this.cardPlaceName(focused, 'sender') ? ' in ' + this.cardPlaceName(focused, 'sender') : '')
          + '\nSender home address: ' + (sender.home?.address || 'Ask locally')
          + '\nFor: ' + (recipient.name || 'Unknown recipient') + (this.cardPlaceName(focused, 'recipient') ? ' in ' + this.cardPlaceName(focused, 'recipient') : '')
          + '\nRecipient home address: ' + (recipient.home?.address || 'Ask locally'));
        if (c.story.jobs[focused.id]?.state === 'active') screen.buttons.push(button('Open satchel', () => this.setView('satchel')));
        else if (c.story.jobs[focused.id]?.state !== 'delivered' && sender.name) screen.buttons.push(button('Meet ' + sender.name, () => this.visitContact(focused.id)));
      }
      if (!cards.length && !boards.length) screen.paragraphs.push('No Post & Errands board is close enough to read. Talk with a local person or explore until you find one.');
      if (boards.length) screen.buttons.push(button('See accounts and questions', () => this.setView('more')));
      if (!ids.length && !boards.length) screen.buttons.push(button('Talk with a nearby person', () => this.setView('conversation'), !this.population.dialogueOpen && !(this.population.activeNpc?.distance <= 4.5)));
    } else if (this.view === 'help') {
      screen.title = 'How to use this book';
      screen.paragraphs.push('Your Next page keeps one current action visible. The Leads page lists nearby Post & Errands boards and referrals you have encountered. Choose a lead to read names and addresses, then meet its sender and talk in person.');
      screen.paragraphs.push('Desktop: press T to talk, E to read or interact, and N to open or close this book. Use the mouse to choose book buttons.\nVR: right grip opens or closes the book. Point and press the right trigger to choose; draw in the notebook with the same trigger.');
      screen.paragraphs.push('Work is optional and has no deadlines. Reading a board or asking about a lead never accepts work remotely. Your handwritten notes and maps stay in your notebook.');
      const hints = c.story.onboarding?.hintsEnabled !== false;
      screen.buttons.push(button(hints ? 'Hide desktop next-step reminder' : 'Show desktop next-step reminder', () => {
        const result = c.setHints?.(!hints);
        if (!result) return this.notify('Reminder settings are unavailable right now.');
        if (!result.ok) return this.action(result);
        this.reminderDismissed = false; this.render(); this.renderReminder();
      }));
      screen.buttons.push(button('Show welcome choices again', () => this.setView('welcome')));
      screen.buttons.push(button('Back to next step', () => this.setView('next')));
    } else if (this.view === 'more') {
      screen.title = 'More in your book';
      screen.paragraphs.push('Read the accounts people have collected, browse pages for your journey, or reopen the controls guide.');
      screen.buttons.push(button('Accounts and questions', () => this.setView('stories')));
      screen.buttons.push(button('Collected pages', () => this.setView('library')));
      screen.buttons.push(button('Help and controls', () => this.setView('help')));
      screen.buttons.push(button('Welcome choices', () => this.setView('welcome')));
    } else if (this.view === 'conversation') {
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
              screen.buttons.push(button('Pass on ' + def.title, () => this.action(c.decline(def.id, npcId))));
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
      for (const card of this.localOpportunityCards(npcId)) {
        const id = card?.id || card?.jobId;
        if (!id) continue;
        screen.paragraphs.push('Local referral: ' + (card.title || 'Delivery opportunity') + '\n' + (card.description || 'A neighbor can tell you more.'));
        screen.buttons.push(button('View lead: ' + (card.title || id), () => this.focusLead(id)));
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
    if (!this.isOpen || this.renderer.xr.isPresenting) { this.panel.style.display = 'none'; this.renderReminder(); return; }
    const focus = document.activeElement?.dataset?.field;
    const selection = focus ? document.activeElement.selectionStart : null;
    const screen = this.screen(); this.panel.replaceChildren();
    const header = element('header'); header.append(element('h2', screen.title));
    const close = element('button', 'Close · N / Esc'); close.onclick = () => this.close(); header.append(close);
    const nav = element('nav');
    for (const [id, label] of [['next', 'Next'], ['leads', 'Leads'], ['conversation', 'Talk'], ['satchel', 'Satchel'], ['notes', 'Notebook'], ['more', 'More']]) {
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
    this.panel.append(header, nav, content, this.footer); this.renderFooter(); this.renderReminder();
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
