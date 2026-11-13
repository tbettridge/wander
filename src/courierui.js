import { COURIER_EVIDENCE, COURIER_ENDING, courierText, courierCompass } from './couriercontent.mjs';
import { STORY_GLITCHES, STORY_TELLS, beatDone, beatOpen, storyThreads } from './courierstory.mjs';
const storyAccount = id => STORY_TELLS.find(tell => tell.accounts.length === 1 && tell.accounts[0] === id) || null;
import { addNotebookPage, collectNotebookPage, notebookStroke, paintNotebookDrawing, notebookPrintHtml } from './notebook.mjs';
import { COURIER_STAMPS, createCourierMap, revealCourierMap, courierMapSeen, addCourierMark,
  removeCourierMarkNear, paintCourierMap, paintCourierStamp, paintPostedVillageMap } from './couriermap.mjs';

const element = (tag, text = '', className = '') => {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
};
const button = (label, run, disabled = false) => ({ label, run, disabled });
// The book's pages, in ribbon order; the number keys 1–5 turn to them.
export const COURIER_TABS = Object.freeze([['round', 'Round'], ['map', 'Map'], ['stories', 'Story'], ['people', 'People'], ['notes', 'Notebook']]);
// Older names for pages that were merged, so every caller still lands somewhere.
const VIEW_ALIAS = { next: 'round', leads: 'round', satchel: 'round', more: 'menu', help: 'menu' };
const ROLE_LABELS = { dispatcher: 'Post dispatcher', guide: 'Trail guide', gardener: 'Gardener', potter: 'Potter', poet: 'Poet', archivist: 'Station archivist' };
const CARGO_ICONS = { letter: '✉', basket: '🧺', parcel: '📦' };
const STYLE = `
#courier-panel{position:fixed;inset:5vh max(12px,calc((100vw - 1080px)/2));z-index:45;color:#25352e;display:none;flex-direction:column;font:16px/1.5 Georgia,serif;overflow:hidden;border:1px solid #6d5a3c;border-radius:8px 16px 16px 8px;box-shadow:0 14px 80px #000a;background:#f5efdd linear-gradient(90deg,#d9cdaa 0,#efe7d0 14px,#f5efdd 40px)}
#courier-panel header{padding:11px 16px 11px 22px;display:flex;gap:10px;align-items:center;background:#203e32;color:#f5efdd}
#courier-panel h2{font-size:22px;margin:0;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#courier-panel h2 small{font:13px system-ui;opacity:.8;margin-left:10px}
#courier-panel .body{display:flex;flex:1;min-height:0}
#courier-panel nav{display:flex;flex-direction:column;gap:7px;padding:18px 0 18px 14px;width:148px;flex:none;border-right:1px solid #75846c55}
#courier-panel nav button{text-align:left;border-radius:8px 0 0 8px;border-right:none;padding:10px 12px;font:16px Georgia,serif;display:flex;gap:9px;align-items:center}
#courier-panel nav button.current{background:#203e32;color:#f5efdd;border-color:#203e32;box-shadow:-3px 2px 6px #0003}
#courier-panel button{background:#e5ddc5;border:1px solid #859380;border-radius:7px;padding:8px 12px;color:#25352e;cursor:pointer;font:14px system-ui}
#courier-panel button:disabled{opacity:.45;cursor:default}
#courier-panel button:focus-visible{outline:3px solid #b88437}
#courier-panel button.primary{background:#203e32;color:#f5efdd;border-color:#203e32;font-weight:600}
#courier-panel button.current{background:#b88437;color:#fff8e6;border-color:#8f6524}
#courier-panel kbd{font:12px system-ui;background:#fbf7ea;color:#25352e;border:1px solid #859380;border-bottom-width:2px;border-radius:4px;padding:0 6px;min-width:10px;text-align:center}
#courier-panel button.primary kbd,#courier-panel nav button.current kbd{background:transparent;color:inherit;border-color:#f5efdd88;margin-left:8px}
#courier-panel nav button kbd{margin-left:0}
#courier-panel .content{padding:14px 24px;overflow:hidden auto;flex:1;min-height:0}
#courier-panel .content.turn{animation:courier-turn .18s ease-out}
@keyframes courier-turn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){#courier-panel .content.turn{animation:none}}
#courier-panel p{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}
#courier-panel h3{font:bold 14px system-ui;margin:18px 0 6px;color:#3d5a49;text-transform:uppercase;letter-spacing:.05em}
#courier-panel .actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#courier-panel input,#courier-panel textarea{font:16px/1.5 Georgia,serif;color:#25352e;background:#faf6e9;border:1px solid #a2aa90;border-radius:6px;padding:10px;box-sizing:border-box;width:100%;margin:5px 0}
#courier-panel textarea{min-height:100px}
#courier-panel canvas.draw{display:block;width:min(100%,53.33vh);height:auto;aspect-ratio:5/3;margin:8px auto;border:1px solid #a2aa90;touch-action:none;background:#faf6e9}
#courier-panel canvas.posted{display:block;width:auto;max-width:100%;max-height:50vh;aspect-ratio:3/2;margin:4px auto 10px;border:1px solid #a2aa90;border-radius:6px;box-shadow:0 2px 8px rgba(40,30,10,.18)}
#courier-panel canvas.map{display:block;width:auto;max-width:100%;max-height:56vh;aspect-ratio:5/3;margin:0 auto;border:1px solid #a2aa90;border-radius:6px;cursor:crosshair;touch-action:none}
#courier-panel canvas.swatch{width:20px;height:20px;flex:none}
#courier-panel footer{padding:7px 20px;border-top:1px solid #75846c55;font:12px system-ui;white-space:pre-wrap;min-height:18px}
#courier-panel .guide{padding:13px 16px;background:#e9e2cd;border-left:5px solid #b88437;border-radius:5px;margin:2px 0 8px}
#courier-panel .guide strong{display:block;font-size:18px;margin-bottom:2px}
#courier-panel .guide p{margin:4px 0}
#courier-panel .card{display:flex;gap:12px;align-items:flex-start;padding:11px 14px;margin:9px 0;background:#fbf7ea;border:1px solid #b9ad8a;border-radius:8px;box-shadow:0 2px 5px #0001}
#courier-panel .card.current{border-color:#b88437;box-shadow:0 0 0 2px #b8843766}
#courier-panel .card.active{border-left:5px solid #a6492f}
#courier-panel .card .icon{font-size:24px;line-height:1.25;width:30px;text-align:center;flex:none}
#courier-panel .card .main{flex:1;min-width:0}
#courier-panel .card .title{font-weight:bold;font-size:17px}
#courier-panel .badge{font:12px system-ui;background:#e5ddc5;border-radius:999px;padding:2px 9px;margin-left:8px;vertical-align:middle;white-space:nowrap}
#courier-panel .card .line{margin:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}
#courier-panel .card .side{display:flex;flex-direction:column;gap:6px;flex:none;align-items:stretch}
#courier-panel .pips{display:flex;gap:4px;align-items:center;font:13px system-ui;white-space:nowrap}
#courier-panel .pip{width:10px;height:10px;border-radius:50%;border:1.5px solid #f5efddaa}
#courier-panel .pip.on{background:#d8a24a;border-color:#d8a24a}
#courier-panel .pips span{margin-left:6px;opacity:.9}
#courier-panel .thread{margin:6px 0 20px}
#courier-panel .thread .pair{display:grid;grid-template-columns:1fr 46px 1fr;align-items:stretch}
#courier-panel .account{padding:10px 12px;background:#fbf7ea;border:1px solid #b9ad8a;border-radius:5px;box-shadow:0 3px 8px #0002;transform:rotate(-.5deg)}
#courier-panel .account:last-child{transform:rotate(.6deg)}
#courier-panel .account.missing{border-style:dashed;background:transparent;box-shadow:none;color:#6c6a55}
#courier-panel .account b{display:block}
#courier-panel .account p{margin:4px 0;font-size:14px;line-height:1.4}
#courier-panel .thread .tie{align-self:center;border-top:3px dashed #b9ad8a}
#courier-panel .thread .tie.tied{border-top:3px solid #a6492f}
#courier-panel .thread .finding{margin-top:10px;padding:8px 12px;border-left:4px solid #a6492f;background:#f0e2cf}
#courier-panel .keys{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;margin:10px 0;align-items:center}
#courier-panel .keys kbd{justify-self:start;font-size:13px;padding:1px 8px}
#courier-panel .tools{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;align-items:center}
#courier-panel .tools button{padding:5px 9px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
#courier-panel .tools input{flex:1 1 220px;width:auto;margin:0;padding:6px 10px;font-size:15px}
#courier-panel .chat{display:flex;flex-direction:column;gap:6px;max-height:24vh;overflow:auto;margin-bottom:6px}
#courier-panel .chat p{margin:0;padding:8px 12px;border-radius:10px 10px 10px 3px;background:#fbf7ea;border:1px solid #cfc5a6;max-width:88%;align-self:flex-start}
#courier-panel .chat p.you{align-self:flex-end;background:#dfe6d2;border-radius:10px 10px 3px 10px}
#courier-panel .chat p.busy{font-style:italic;opacity:.7}
#courier-panel .say{display:flex;gap:8px;padding:8px 16px 10px;border-top:1px solid #75846c55}
#courier-panel .say input{flex:1;margin:0}
#courier-panel.talk{top:auto;bottom:3vh;left:50%;right:auto;transform:translateX(-50%);width:min(780px,calc(100vw - 24px));max-height:58vh;border-radius:14px;background:#f5efddf7}
#courier-panel.talk header{padding:8px 14px 8px 18px}
#courier-panel.talk h2{font-size:19px}
#courier-panel.talk .content{padding:10px 16px 4px}
#courier-panel.talk .card{margin:6px 0;padding:8px 12px}
@media (max-width:760px){#courier-panel .body{flex-direction:column}#courier-panel nav{flex-direction:row;flex-wrap:wrap;width:auto;padding:8px 12px;border-right:none;border-bottom:1px solid #75846c55}#courier-panel nav button{border-radius:7px;border-right:1px solid #859380}#courier-panel .card{flex-wrap:wrap}#courier-panel .pips span{display:none}}
#courier-toast{position:fixed;top:64px;left:50%;white-space:pre-wrap;transform:translateX(-50%);max-width:600px;padding:12px 20px;background:#203e32ee;color:#f5efdd;border-radius:10px;z-index:44;font:15px Georgia;pointer-events:none}
#courier-reminder{position:fixed;left:16px;bottom:16px;z-index:42;max-width:min(420px,calc(100vw - 32px));display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:#203e32ee;color:#f5efdd;border:1px solid #75846c;border-radius:10px;box-shadow:0 6px 28px #0007;font:14px/1.4 system-ui}
#courier-reminder .courier-reminder-copy{flex:1;min-width:0}
#courier-reminder strong{display:block;margin-bottom:3px}
#courier-reminder button{background:#e5ddc5;border:1px solid #859380;border-radius:6px;padding:5px 8px;color:#25352e;cursor:pointer;font:12px system-ui;white-space:nowrap}
#courier-reminder .courier-reminder-actions{display:flex;gap:5px}
.courier-route-hidden{display:none!important}
#courier-hud{margin-top:2px;display:flex;flex-direction:column;gap:6px;max-width:min(340px,calc(100vw - 32px));letter-spacing:0;text-shadow:none}
#courier-hud .satchel{display:flex;align-items:center;gap:7px;font:12px system-ui;color:rgba(255,255,255,.88);text-shadow:0 1px 3px #000c;letter-spacing:.06em;text-transform:uppercase}
#courier-hud .slot{width:20px;height:20px;border-radius:5px;border:1px solid rgba(255,255,255,.4);background:rgba(13,22,24,.45);display:grid;place-items:center;font-size:12px;text-transform:none}
#courier-hud .slot.full{background:rgba(229,214,170,.85);border-color:#e5d6aa}
#courier-hud .tag{position:relative;padding:8px 12px 9px 16px;background:#efe4c4;color:#25352e;border:1px solid #8f7a52;border-radius:4px 10px 10px 4px;box-shadow:0 3px 12px #0006;font:14px/1.35 Georgia,serif;transform:rotate(-.6deg)}
#courier-hud .tag::before{content:'';position:absolute;left:5px;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;background:#25352e33;box-shadow:inset 0 0 0 1px #6d5a3c}
#courier-hud .tag b{display:block;font-size:15px}
#courier-hud .tag span{display:block;font-style:italic}
#courier-hud .tag .chipped{color:#a6492f;font-style:normal;font:11px system-ui;margin-left:6px}
#courier-prompt{position:fixed;left:50%;bottom:max(26vh,212px);transform:translateX(-50%);z-index:8;padding:7px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(8,15,16,.62);color:rgba(239,245,241,.95);font:13px/1.6 "Helvetica Neue",Arial,sans-serif;letter-spacing:.5px;text-shadow:0 1px 3px #000e;pointer-events:none;user-select:none;white-space:nowrap;max-width:calc(100vw - 32px);overflow:hidden;text-overflow:ellipsis}
#courier-prompt b{display:inline-block;min-width:12px;padding:0 6px;margin-right:4px;border:1px solid rgba(255,255,255,.5);border-bottom-width:2px;border-radius:4px;text-align:center}
#courier-arrival{position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:43;text-align:center;color:#f5efdd;pointer-events:none;opacity:0;padding:22px 72px;background:radial-gradient(ellipse at center,rgba(12,22,18,.62) 0,rgba(12,22,18,.38) 45%,transparent 72%);text-shadow:0 2px 10px #000e;white-space:nowrap}
#courier-arrival small{display:block;font:13px system-ui;letter-spacing:.3em;text-transform:uppercase;opacity:.85}
#courier-arrival strong{display:block;font:600 46px/1.15 Georgia,serif;letter-spacing:.06em;margin:4px 0}
#courier-arrival span{display:inline-block;font:italic 15px Georgia,serif;border-top:1px solid #f5efdd88;padding-top:5px}
#courier-arrival.show{animation:courier-arrive 5s ease forwards}
@keyframes courier-arrive{0%{opacity:0;transform:translate(-50%,8px)}12%{opacity:1;transform:translate(-50%,0)}78%{opacity:1}100%{opacity:0}}
#courier-stamp{position:fixed;left:50%;top:40%;z-index:46;width:190px;height:190px;margin:-95px 0 0 -95px;border-radius:50%;border:6px double #a6492f;color:#a6492f;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;font:600 13px/1.3 Georgia,serif;letter-spacing:.08em;text-transform:uppercase;pointer-events:none;background:radial-gradient(circle,#f5efdd 0 60%,#f5efddcc 100%);box-shadow:0 8px 30px #0006}
#courier-stamp strong{font-size:27px;letter-spacing:.12em;margin:4px 0;border-top:2px solid #a6492f;border-bottom:2px solid #a6492f;padding:2px 8px}
#courier-stamp.show{display:flex;animation:courier-stamp 2.8s ease-out forwards}
@keyframes courier-stamp{0%{opacity:0;transform:scale(1.9) rotate(-4deg)}14%{opacity:1;transform:scale(.94) rotate(-12deg)}20%{transform:scale(1) rotate(-12deg)}80%{opacity:1;transform:scale(1) rotate(-12deg)}100%{opacity:0;transform:scale(1) rotate(-12deg)}}
@media (prefers-reduced-motion:reduce){#courier-arrival.show,#courier-stamp.show{animation-duration:.01s;animation-delay:2.5s;animation-direction:reverse}}
`;
export class CourierUI {
  constructor({ controller, notebook, population, controls, renderer, onOpen, onClose, onRestart, onReturn,
    getNearbySources, getNearbyBoards = () => [], getMapData = () => null, getLandmarkNear = () => null, onVisitContact, canOpen = () => true }) {
    Object.assign(this, { controller, notebook, population, controls, renderer, onOpen, onClose, onRestart, onReturn,
      getNearbySources, getNearbyBoards, getMapData, getLandmarkNear, onVisitContact, canOpen });
    this.isOpen = false; this.view = 'round'; this.pageId = notebook.book.pages[0]?.id;
    this.message = ''; this.chatDraft = ''; this.inputTarget = null; this.erase = false; this.dirty = true;
    this.revision = 0; this.keyboard = false; this.shift = false; this.editorTimer = null;
    this.focusedJobId = null; this.reminderDismissed = false;
    this.mapMode = 'near'; this.mapTool = 'house'; this.mapLabel = ''; this.mapHit = null; this.lastReveal = null;
    const style = element('style'); style.textContent = STYLE; document.head.append(style); this.style = style;
    this.panel = element('section'); this.panel.id = 'courier-panel'; this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true'); this.panel.setAttribute('aria-label', 'First Post journey book');
    this.panel.addEventListener('click', e => e.stopPropagation());
    this.panel.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.append(this.panel);
    this.toast = element('div'); this.toast.id = 'courier-toast'; this.toast.style.display = 'none'; this.toast.setAttribute('role', 'status'); document.body.append(this.toast);
    this.reminder = element('aside', '', 'courier-reminder'); this.reminder.id = 'courier-reminder';
    this.reminder.setAttribute('aria-label', 'First Post next step'); this.reminder.style.display = 'none'; document.body.append(this.reminder);
    // The travelling HUD: what is in the satchel and the address on the parcel
    // in hand, under the compass. Never a marker, arrow or distance.
    this.hud = element('div'); this.hud.id = 'courier-hud'; this.hud.style.display = 'none';
    this.hud.setAttribute('aria-live', 'polite');
    (document.getElementById('hud') || document.body).append(this.hud);
    this.arrival = element('div'); this.arrival.id = 'courier-arrival'; this.arrival.setAttribute('role', 'status'); document.body.append(this.arrival);
    this.stamp = element('div'); this.stamp.id = 'courier-stamp'; this.stamp.setAttribute('aria-hidden', 'true'); document.body.append(this.stamp);
    this.unsub = controller.subscribe(result => {
      if (result.message) this.notify(result.message + (result.persisted === false ? '\nProgress is not saved. Keep this tab open and try saving again.' : ''));
      if (result.jobId && result.standing && result.applied !== false
        && this.controller.story?.jobs[result.jobId]?.state === 'delivered') this.deliveryStamp(result);
      this.syncCollected(); this.render(); this.renderReminder(); this.renderHud();
    });
    this.unsubDialogue = population.subscribeDialogue(() => {
      if (this.isOpen) { population.dialogueEl.style.display = 'none'; this.render(); }
    });
    this.onKey = event => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable;
      const swallow = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      if (!this.isOpen) {
        if (event.code === 'KeyN' && !event.repeat && !typing && this.canOpen()) { this.open(); swallow(); }
        return;
      }
      if (event.code === 'Escape') { this.close(); return swallow(); }
      if (this.renderer.xr.isPresenting || event.ctrlKey || event.metaKey || event.altKey) return;
      const onButton = event.target?.tagName === 'BUTTON';
      if (this.view === 'conversation') {
        // The line you type is the conversation: any letter goes to it, and
        // Enter on an empty line does the highlighted thing.
        if (typing) return;
        if (event.key === 'Enter') { if (!onButton && this.primaryAction) { this.primaryAction.run(); swallow(); } return; }
        if (event.key?.length === 1) this.panel.querySelector('[data-field="chat"]')?.focus({ preventScroll: true });
        return;
      }
      if (typing) return;
      if (event.code === 'KeyN' && !event.repeat) { this.close(); return swallow(); }
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && COURIER_TABS[digit[1] - 1]) { this.setView(COURIER_TABS[digit[1] - 1][0]); return swallow(); }
      if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') {
        const index = COURIER_TABS.findIndex(([id]) => id === this.view), step = event.code === 'ArrowRight' ? 1 : -1;
        this.setView(COURIER_TABS[(Math.max(0, index) + (index < 0 ? 0 : step) + COURIER_TABS.length) % COURIER_TABS.length][0]);
        return swallow();
      }
      if (event.key === 'Enter' && !onButton && this.primaryAction) { this.primaryAction.run(); swallow(); }
    };
    window.addEventListener('keydown', this.onKey, true);
    this.syncCollected(); this.renderReminder();
  }
  npcId() { return this.population.dialogueOpen ? this.population.conversationNpcId : null; }
  setView(view) {
    view = VIEW_ALIAS[view] || view;
    if (this.view === 'welcome' && view !== 'welcome') this.markWelcomeExplored();
    if (view === 'conversation' && !this.population.dialogueOpen && this.population.activeNpc?.distance <= 4.5) {
      this.population.talk(); this.population.setPointerReleased();
    }
    this.view = view; this.keyboard = false; this.inputTarget = null; this.render();
    if (view === 'conversation') this.learnConversationLeads();
  }
  open(view = 'round') {
    if (!this.controller.story) return;
    view = VIEW_ALIAS[view] || view;
    if (!this.isOpen) {
      this.previousControls = { enabled: this.controls.enabled, allowLook: this.controls.allowLook };
      this.isOpen = true; this.controls.uiInputCaptured = true; this.controls.suspendInput();
      this.onOpen?.(); this.xr?.recenter();
    }
    if (view === 'conversation' && !this.population.dialogueOpen && this.population.activeNpc?.distance <= 4.5) {
      this.population.talk(); this.population.setPointerReleased();
    }
    this.view = view; this.talkMore = false; this.panel.style.display = this.renderer.xr.isPresenting ? 'none' : 'flex';
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
      this.view = 'round';
    } else if (choice === 'explain') this.view = 'menu';
    else { this.view = 'round'; this.close(); return; }
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
    const open = element('button', 'Open book'); open.onclick = () => this.open('round');
    const dismiss = element('button', 'Hide'); dismiss.setAttribute('aria-label', 'Hide next step reminder');
    dismiss.onclick = () => { this.reminderDismissed = true; this.reminder.style.display = 'none'; };
    actions.append(open, dismiss); this.reminder.append(copy, actions); this.reminder.style.display = 'flex';
    this.reminderStateKey = key;
  }
  renderHud() {
    if (!this.hud) return;
    const story = this.controller.story;
    const hidden = !story || this.renderer.xr.isPresenting || this.isOpen || !this.canOpen();
    const active = hidden ? [] : this.controller.jobs().filter(def => story.jobs[def.id]?.state === 'active');
    const focus = active.find(def => def.id === story.focusJobId) || active[0];
    const key = hidden ? 'hidden' : active.map(def => def.id + ':' + story.jobs[def.id].condition).join(',') + '|' + (focus?.id || '');
    if (key === this.hudKey) return;
    this.hudKey = key;
    if (hidden) { this.hud.style.display = 'none'; return; }
    this.hud.replaceChildren();
    const satchel = element('div', '', 'satchel');
    satchel.append(element('span', 'Satchel'));
    for (let i = 0; i < 3; i++) {
      const def = active[i];
      satchel.append(element('i', def ? (def.fragile ? '☕' : CARGO_ICONS[def.kind] || '📦') : '', 'slot' + (def ? ' full' : '')));
    }
    satchel.append(element('span', active.length ? active.length + ' of 3' : 'empty'));
    satchel.setAttribute('aria-label', active.length ? active.length + ' of 3 parcels in your satchel' : 'Your satchel is empty');
    this.hud.append(satchel);
    if (focus) {
      const recipient = this.controller.npc(focus.recipient), job = story.jobs[focus.id];
      const tag = element('div', '', 'tag'), title = element('b', (focus.fragile ? '☕ ' : (CARGO_ICONS[focus.kind] || '📦') + ' ') + focus.title);
      if (focus.fragile && job.condition === 'chipped') title.append(element('em', 'chipped', 'chipped'));
      tag.append(title, element('span', 'to ' + (recipient?.name || 'the recipient')),
        element('div', recipient?.home?.address || 'Ask in ' + (this.controller.placeName(this.controller.placeOf(focus.recipient)) || 'the village')));
      this.hud.append(tag);
    }
    this.hud.style.display = 'flex';
  }
  /** The courier has read a village's name: they know where they are, and say so on the map. */
  arrive(key) {
    const map = this.courierMap(), place = this.controller.story && this.controller.place(key);
    if (!place || map.place === key) return false;
    map.arrived ||= [];
    const first = !map.arrived.includes(key);
    map.place = key; if (first) map.arrived.push(key);
    this.dirty = true; clearTimeout(this.mapTimer); this.mapTimer = setTimeout(() => this.notebook.save(), 1500);
    if (this.arrival && !this.renderer.xr.isPresenting) {
      this.arrival.replaceChildren(element('small', first ? 'You have reached' : 'Back in'), element('strong', place.name),
        element('span', ({ farmstead: 'Farmstead', hamlet: 'Hamlet', town: 'Town', 'station-halt': 'Station halt' }[place.kind] || (place.stationId ? 'Station village' : 'Village')) + (first ? ' · now on your map' : '')));
      this.arrival.classList.remove('show'); void this.arrival.offsetWidth; this.arrival.classList.add('show');
    }
    if (this.isOpen) this.render();
    return true;
  }
  deliveryStamp(result) {
    if (!this.stamp || this.renderer.xr.isPresenting) return;
    const def = this.controller.jobDef(result.jobId);
    const place = def && this.controller.place(this.controller.placeOf(def.recipient));
    this.stamp.replaceChildren(element('span', place?.name || 'First Post'), element('strong', 'Delivered'),
      element('span', result.standing.delivered + ' of ' + result.standing.total));
    this.stamp.classList.remove('show'); void this.stamp.offsetWidth; this.stamp.classList.add('show');
  }
  /** Reading a road post: the name and the way its arm points, put on the map once. */
  readFingerpost(post) {
    const heading = courierCompass(post.toward.x - post.x, post.toward.z - post.z);
    const map = this.courierMap();
    const marked = map.marks.some(mark => mark.kind === 'post' && Math.hypot(mark.x - post.x, mark.z - post.z) < 15);
    if (!marked) { addCourierMark(map, { kind: 'post', text: post.destination + ' road', x: post.x, z: post.z }); this.markEdited(); }
    this.notify('Road post: “' + post.destination + '”. Its arm points ' + heading + '.' + (marked ? '' : ' You mark the post on your map.'));
    return !marked;
  }
  // ---- The courier's own map ------------------------------------------------
  courierMap() { return this.notebook.book.map ||= createCourierMap(); }
  /** Called as the courier moves: the map fills in around where they have been. */
  explore(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.lastReveal && Math.hypot(this.lastReveal.x - x, this.lastReveal.z - z) < 12) return;
    this.lastReveal = { x, z };
    if (!revealCourierMap(this.courierMap(), x, z)) return;
    this.dirty = true; clearTimeout(this.mapTimer);
    this.mapTimer = setTimeout(() => this.notebook.save(), 4000);
  }
  /** A click on a map page, in 0–1 coordinates across the drawn map. */
  mapClick(u, v) {
    if (!this.mapHit) return;
    const { projection, width, height } = this.mapHit, at = projection.unproject({ x: u * width, y: v * height });
    const map = this.courierMap();
    if (this.mapTool === 'erase') { if (!removeCourierMarkNear(map, at.x, at.z, 16 / projection.scale)) return this.notify('Click on one of your own stamps or labels to rub it out.'); }
    else {
      if (this.mapTool === 'label' && !this.mapLabel.trim()) return this.notify('Type a few words in the label box first, then click the map.');
      if (!addCourierMark(map, { kind: this.mapTool, text: this.mapLabel, x: at.x, z: at.z })) return this.notify('This map is full of marks. Rub some out first.');
      this.mapLabel = '';
    }
    this.markEdited(); this.render();
  }
  /**
   * Only beside something you can find on a map do you know exactly where
   * you stand; anywhere else the courier stamps the map by eye.
   */
  markHere() {
    const spot = this.getLandmarkNear?.();
    if (!spot) return this.notify('Out here you cannot be sure exactly where you are. Click the map where you think you are standing, or mark the spot from beside a road post, board, well or station.');
    if (this.mapTool === 'erase') this.mapTool = 'star';
    if (this.mapTool === 'label' && !this.mapLabel.trim()) return this.notify('Type a few words in the label box first.');
    addCourierMark(this.courierMap(), { kind: this.mapTool, text: this.mapLabel, x: spot.x, z: spot.z });
    this.notify('Marked beside ' + spot.name + '.');
    this.mapLabel = ''; this.markEdited(); this.render();
  }
  /** Directions people have given, as written down at the time. */
  routePages(placeName = '') {
    return this.notebook.book.collected.filter(page => page.id.startsWith('route:') && (!placeName || page.title === 'Directions to ' + placeName));
  }
  /** People the courier has reason to know of: the post desk, and anyone named on a known errand. */
  knownRoles() {
    const c = this.controller, known = new Set(['dispatcher']);
    const add = id => { const def = c.jobDef(id); if (def) { known.add(def.sender); known.add(def.recipient); } };
    for (const id of this.knownLeadIds()) add(id);
    for (const [id, job] of Object.entries(c.story.jobs)) if (['active', 'delivered'].includes(job.state)) add(id);
    return [...Object.keys(c.story.bindings.cast), ...Object.keys(c.story.plot.people || {})].filter(role => known.has(role));
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
    const role = this.controller.whoFor(npcId);
    if (role) for (const job of this.controller.jobs().filter(def => def.sender === role)) this.controller.learnOffer(job.id, npcId);
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
      if (id && this.controller.jobDef(id)) ids.add(id);
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
    const c = this.controller, def = c.jobDef(id);
    if (!def) return null;
    const sender = c.npc(def.sender), recipient = c.npc(def.recipient);
    const senderPlace = c.place(c.placeOf(def.sender)), recipientPlace = c.place(c.placeOf(def.recipient));
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
    const bound = typeof value === 'string' ? this.controller.place(value) : null;
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
    this.focusedJobId = jobId; this.view = 'round'; this.render();
  }
  readBoard(place, { quiet = false } = {}) {
    const result = this.controller.readBoard?.(place);
    if (!result) return this.notify('That board cannot be read right now.');
    if (!result.ok) return this.action(result);
    const jobs = result.jobs || this.cardsAt(place);
    if (jobs.length === 1) this.focusedJobId = jobs[0].id || jobs[0].jobId;
    if (!quiet && result.applied === false && result.message) this.notify(result.message);
    this.view = 'round'; this.syncCollected(); this.render(); return result;
  }
  /** One line a player can act on: what, from whom, to whom, and the address to ask for. */
  jobLine(id) {
    const c = this.controller, def = c.jobDef(id), job = c.story.jobs[id];
    if (!def || !job) return '';
    const sender = c.npc(def.sender), recipient = c.npc(def.recipient);
    const status = ({ offered: 'available', declined: 'available', returned: 'available', active: 'in your satchel', delivered: 'delivered ✓' })[job.state] || job.state;
    const seek = job.state === 'active' ? recipient : job.state === 'delivered' ? null : sender;
    return def.title + ' — ' + status + (def.fragile && job.state === 'active' ? ' · ' + job.condition : '')
      + '\nFrom ' + sender.name + ' (' + c.placeName(c.placeOf(def.sender)) + ') to ' + recipient.name + ' (' + c.placeName(c.placeOf(def.recipient)) + ')'
      + (seek?.home?.address ? '\nAddress: ' + seek.home.address : '');
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
  endingDocument() {
    return { title: COURIER_ENDING.title,
      text: COURIER_ENDING.lines.map(line => courierText(line, this.controller.story.bindings)).join('\n\n') };
  }
  action(result) {
    if (!result?.ok) this.notify(result?.reason || 'That action is unavailable.');
    if (result?.message && this.population.dialogueOpen) this.authoredLine(result.message);
    this.syncCollected();
    if (result?.ending) { this.document = result.ending; this.view = 'document'; this.flush(); }
    this.render(); return result;
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
      text: 'Work is optional and deliveries have no deadlines. The Round page gives one clear thing you can do now. Read the Post & Errands boards or ask a neighbor for a local referral to find work.\n\nYou are given addresses, not routes: ask people the way, follow the road posts, read your compass, and stamp your own map as you go. Meet a sender in person to hear more; a lead never accepts the delivery for you.\n\nDesktop: T talks to a nearby person, E reads or interacts, and N opens this book. VR: right grip opens or closes the book; point and press the right trigger to choose buttons, stamp the map or draw on a notebook page.' });
    for (const [id, record] of Object.entries(this.controller.story.evidence)) {
      const doc = this.controller.accountDoc(id), readAt = this.controller.placeName(String(record.sourceIds?.[0] || '').split(':').slice(1).join(':'));
      if (doc) collectNotebookPage(book, { id: 'evidence:' + id, title: doc.title, text: doc.text,
        author: doc.author ? doc.author + (doc.place ? ', ' + doc.place : '') : 'Collected at ' + (readAt || doc.place || 'a reading stand') });
    }
    // An older save that heard the poet's ending keeps that page.
    if (this.controller.story.concluded) collectNotebookPage(book, { id: 'ending:first-post', author: this.controller.npc('poet').name, ...this.endingDocument() });
    const last = this.controller.story.plot.beats.ending && this.controller.endingDoc();
    if (last) collectNotebookPage(book, { id: 'ending:last-letter', author: this.controller.story.plot.closer.name, ...last });
    const work = this.controller.story.works.personal;
    if (work) collectNotebookPage(book, { id: 'work:personal', title: work.title, author: work.author,
      text: work.introduction + '\n\n' + work.lines.join('\n') });
    for (const [id, job] of Object.entries(this.controller.story.jobs)) {
      if (!job.attempts) continue;
      const def = this.controller.jobDef(id);
      collectNotebookPage(book, { id: 'brief:' + id, title: def.title, author: this.controller.npc(def.sender).name,
        text: def.description + '\nFor ' + this.controller.npc(def.recipient).name + ' at '
          + this.controller.placeName(this.controller.placeOf(def.recipient))
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
  /** When a sender sends the courier off with directions, they point as they say it and the words go in the book. */
  briefed(result, npcId = this.npcId()) {
    const briefing = result?.ok && result.briefing;
    if (!briefing) return result;
    const actor = this.population.actorById?.(npcId);
    if (actor && briefing.point) this.population.pointOut?.(actor, { id: briefing.point.id, name: briefing.point.name, worldX: briefing.point.x, worldZ: briefing.point.z }, 3.5);
    if (briefing.directions) {
      collectNotebookPage(this.notebook.book, { id: briefing.directions.id, title: briefing.directions.title,
        author: this.controller.state.entities[npcId]?.name || 'The dispatcher', text: briefing.text });
      this.flush();
    }
    this.render(); return result;
  }
  /**
   * One page of the book as plain data. `paragraphs` and `buttons` are the
   * flat reading the VR panel draws; `blocks` is the same content laid out as
   * cards for the desktop book. A button marked `inline` already sits inside
   * a block.
   */
  screen() {
    const c = this.controller, npcId = this.npcId(), role = c.whoFor(npcId), places = c.story.bindings.places;
    const screen = { title: 'First Post', paragraphs: [], buttons: [], fields: [], drawing: null, blocks: [], map: null };
    const p = (text, className = '') => { screen.paragraphs.push(text); screen.blocks.push({ type: 'p', text, className }); };
    const h = text => { screen.paragraphs.push('## ' + text); screen.blocks.push({ type: 'h', text }); };
    const btn = (label, run, { disabled = false, primary = false } = {}) => Object.assign(button(label, run, disabled), { primary });
    const act = (label, run, options) => { const made = btn(label, run, options); screen.buttons.push(made); return made; };
    const inline = actions => { for (const action of actions) { action.inline = true; screen.buttons.push(action); } return actions; };
    const card = ({ flat, actions = [], ...rest }) => {
      screen.paragraphs.push(flat ?? [rest.title + (rest.badge ? ' — ' + rest.badge : ''), ...(rest.lines || [])].join('\n'));
      screen.blocks.push({ type: 'card', lines: [], ...rest, actions: inline(actions) });
    };
    const placeOf = who => c.placeName(c.placeOf(who));
    const icon = def => def.fragile ? '☕' : CARGO_ICONS[def.kind] || '📦';
    // Where the courier knows they are: the last name board, village board or station they passed.
    const here = c.place(this.courierMap().place);
    // What the courier has been told about reaching a village, never a live bearing.
    const wayLine = who => {
      const name = placeOf(who);
      if (here && here.name === name) return 'Here in ' + name + '. Find the well and use your compass, or ask someone to point.';
      return this.routePages(name).length ? 'You have written directions to ' + name + ' (Map page).' : 'No directions to ' + name + ' yet: ask someone the way.';
    };
    if (this.view === 'welcome') {
      screen.title = 'Welcome to First Post';
      p('You are the new courier. Your round begins in ' + Object.values(places).map(place => place.name).join(', ').replace(/, ([^,]*)$/, ' and $1') + ', and goes wherever you go after that. People have letters and parcels to send — and some of their records do not quite agree with one another.');
      p('1. Collect — walk up to a sender, press T, choose Accept.\n2. Find the way — you are given an address, not a route. Ask people for directions, follow the road posts, read your compass, and keep your own map.\n3. Deliver — press T beside the recipient, choose Deliver. They may show you something worth keeping.');
      p('Work is optional and nothing has a deadline. Choosing an idea here never accepts a delivery.');
      act('Show me an easy delivery', () => this.chooseWelcome('easy'), { primary: true });
      act('Explain how this works', () => this.chooseWelcome('explain'));
      act('I’ll explore first', () => this.chooseWelcome('explore'));
    } else if (this.view === 'round') {
      screen.title = 'Your round';
      const guidance = c.guidance?.();
      const near = this.population.dialogueOpen || this.population.activeNpc?.distance <= 4.5;
      const text = guidance?.text || 'Explore freely, talk with a nearby person, or read a public board. Your work is optional.';
      const guideActions = [];
      if (guidance?.view) guideActions.push(btn('Open Story', () => this.setView(guidance.view), { primary: true }));
      if (near) guideActions.push(btn('Talk with ' + (this.population.activeNpc?.identity?.name || 'a nearby person'), () => this.setView('conversation'), { primary: !guidance?.view }));
      screen.paragraphs.push((guidance?.title ? guidance.title + '\n' : '') + text);
      screen.blocks.push({ type: 'guide', title: guidance?.title || 'Next step', text, actions: inline(guideActions) });
      const standing = c.standing?.();
      if (standing) screen.paragraphs.push(standing.delivered + ' of ' + standing.total + ' delivered · ' + standing.rank);
      const active = c.jobs().filter(def => c.story.jobs[def.id]?.state === 'active');
      if (active.length) {
        h('In your satchel (' + active.length + ' of 3)');
        for (const def of active) {
          const job = c.story.jobs[def.id], recipient = c.npc(def.recipient), sender = c.npc(def.sender), actions = [];
          if (c.nearby(recipient.id)) actions.push(btn('Deliver ' + def.title, () => this.action(c.handoff(def.id, recipient.id)), { primary: true }));
          if (c.nearby(sender.id)) actions.push(btn('Return ' + def.title, () => this.action(c.handoff(def.id, sender.id, true))));
          card({ icon: icon(def), title: def.title, badge: def.fragile ? job.condition : 'in your satchel', tone: 'active', flat: this.jobLine(def.id), actions,
            lines: ['Take to ' + recipient.name + ' · ' + placeOf(def.recipient), 'Address: ' + (recipient.home?.address || 'ask locally'), wayLine(def.recipient)] });
        }
      }
      const boards = this.nearbyBoards();
      for (const board of boards) {
        const notices = this.cardsAt(board.place).filter(item => !c.story.leads?.['job:' + item.id]);
        if (!notices.length) continue;
        h('Post & Errands board · ' + (board.name || board.place));
        if (board.contactHint) p(board.contactHint);
        for (const item of notices) p((item.title || 'Local opportunity') + ': ' + (item.description || 'A delivery opportunity is posted here.'));
        act('Read board: ' + (board.name || board.place), () => this.readBoard(board.place), { primary: true });
      }
      const ids = this.knownLeadIds();
      const cards = ids.map(id => this.leadCard(id)).filter(Boolean).sort((a, b) => {
        if (a.id === 'village-note') return -1;
        if (b.id === 'village-note') return 1;
        if (!!a.local !== !!b.local) return a.local ? -1 : 1;
        return String(a.title).localeCompare(String(b.title));
      });
      const open = cards.filter(item => !['active', 'delivered'].includes(c.story.jobs[item.id]?.state));
      const focusedId = this.focusedJobId || c.story.focusJobId || null;
      if (open.length) h('Errands to collect');
      for (const item of open) {
        const def = c.jobDef(item.id), sender = item.sender || {}, recipient = item.recipient || {};
        const chosen = item.id === focusedId;
        const detail = [item.description || '', 'Sender home address: ' + (sender.home?.address || 'Ask locally'), 'Recipient home address: ' + (recipient.home?.address || 'Ask locally')];
        const actions = [];
        if (sender.name) actions.push(btn('Meet ' + sender.name, () => this.visitContact(item.id), { primary: chosen || guidance?.jobId === item.id }));
        if (!chosen) actions.push(btn('Details: ' + item.title, () => { this.focusedJobId = item.id; this.render(); }));
        card({ icon: def ? icon(def) : '📦', title: item.title, badge: item.id === 'village-note' ? 'a short first errand' : '', tone: chosen ? 'current' : '', actions,
          flat: [this.jobLine(item.id) || item.title, ...(chosen ? detail : [])].join('\n'),
          lines: ['Collect from ' + (sender.name || 'the sender') + (this.cardPlaceName(item, 'sender') ? ' · ' + this.cardPlaceName(item, 'sender') : ''),
            'For ' + (recipient.name || 'the recipient') + (this.cardPlaceName(item, 'recipient') ? ' · ' + this.cardPlaceName(item, 'recipient') : ''),
            ...(chosen ? detail : [])] });
      }
      const done = c.jobs().filter(def => c.story.jobs[def.id]?.state === 'delivered');
      if (done.length) { h('Delivered'); p(done.map(def => def.title + ' ✓').join('   ')); }
      if (!cards.length && !boards.length) p('You have not heard of any errands yet. Press E at a Post & Errands board beside a village well, or press T beside someone and ask about delivery work.');
      // The village plan and fingerpost beside the board: the one place that says where you are.
      for (const board of boards) {
        h('Posted beside the board · ' + (board.name || board.place));
        if (board.arms?.length) p('The fingerpost reads: ' + board.arms.map(arm => arm.name + ', ' + arm.walk + ' (its arm points ' + arm.compass + ')').join('; ') + '.');
        let place = null;
        try { place = this.getMapData?.()?.places?.find(item => item.key === board.place) || null; } catch { place = null; }
        if (place) screen.blocks.push({ type: 'posted', label: 'The village plan posted at the board in ' + place.name + '. A star marks where you stand.',
          paint: (ctx, width, height) => paintPostedVillageMap(ctx, place, board.roads || [], place.boardFacing, width, height) });
      }
      if (this.getNearbySources?.().length) act('Read the public accounts here', () => this.setView('stories'));
      if (!ids.length && !boards.length) act('Talk with a nearby person', () => this.setView('conversation'), { disabled: !near });
    } else if (this.view === 'map') {
      screen.title = 'Your map';
      const map = this.courierMap();
      let data = null;
      try { data = this.getMapData?.() || null; } catch { data = null; }
      p('This map starts blank and fills in only where you have been. It does not know where you are: find yourself by the road posts, boards and landmarks you have marked. Choose a stamp, then click the map to mark what you find.');
      if (data) {
        const paint = (ctx, width, height) => { this.mapHit = { projection: paintCourierMap(ctx, data, map, this.mapMode, width, height), width, height }; };
        screen.map = { paint, onPoint: (u, v) => this.mapClick(u, v) };
        const tools = [];
        for (const [kind, label] of COURIER_STAMPS) tools.push(Object.assign(btn(label, () => { this.mapTool = kind; this.render(); }), { current: this.mapTool === kind, stamp: kind }));
        tools.push(Object.assign(btn('Rub out', () => { this.mapTool = 'erase'; this.render(); }), { current: this.mapTool === 'erase' }));
        const field = { id: 'mapLabel', label: 'Words beside the next stamp (optional)', value: this.mapLabel, inline: true };
        screen.fields.push(field);
        screen.blocks.push({ type: 'tools', actions: inline(tools), field });
        screen.blocks.push({ type: 'map', paint });
        screen.blocks.push({ type: 'tools', actions: inline([
          btn(this.mapMode === 'near' && map.place ? 'Show everywhere I have been' : 'Show ' + (c.placeName(map.place) || 'my last village'),
            () => { this.mapMode = this.mapMode === 'near' ? 'round' : 'near'; this.render(); }, { disabled: !map.place && this.mapMode !== 'near' }),
          btn('Mark the landmark beside me', () => this.markHere(), { primary: true })]) });
        const unfound = (data.places || []).filter(place => !map.arrived?.includes(place.key) && !courierMapSeen(map, place.x, place.z) && !(place.board && courierMapSeen(map, place.board.x, place.board.z)));
        if (unfound.length) p('Heard of but not yet found: ' + unfound.map(place => place.name).join(', ') + '.');
        p(map.marks.length + (map.marks.length === 1 ? ' mark' : ' marks') + ' of your own on the map.');
      } else p('The map cannot be drawn here.');
      const routes = this.routePages();
      h('Directions you have been given');
      if (!routes.length) p('None yet. Press T beside anyone and ask the way to a village: what they tell you is written down here.');
      for (const page of routes) card({ icon: '➤', title: page.title, badge: page.author ? 'from ' + page.author : '', lines: [page.text] });
    } else if (this.view === 'people') {
      screen.title = 'People on the round';
      const known = this.knownRoles();
      p('Everyone you have met or been told about, with the address they gave. Addresses are compass directions from the village well.');
      for (const who of known) {
        const person = c.npc(who), lines = [placeOf(who), 'Address: ' + (person.home?.address || 'ask locally')];
        for (const def of c.jobs()) {
          const state = c.story.jobs[def.id]?.state;
          if (def.recipient === who && state === 'active') lines.push('Waiting for ' + def.title + ' (in your satchel).');
          else if (def.sender === who && ['offered', 'returned', 'declined'].includes(state) && this.knownLeadIds().includes(def.id)) lines.push('Has ' + def.title + ' to send.');
          else if (def.recipient === who && state === 'delivered') lines.push('Received ' + def.title + ' ✓');
        }
        lines.push(wayLine(who));
        card({ icon: '☺', title: person.name, badge: ROLE_LABELS[who] || person.role || '', lines });
      }
      // People the story has led you to, wherever they live.
      for (const person of c.storyPeople(null)) card({ icon: '✎', title: person.name, badge: person.responsibility, lines: [person.place ? 'In ' + person.place : ''] });
      const unknown = Object.keys(c.story.bindings.cast).length - known.length;
      if (unknown > 0) p(unknown + (unknown === 1 ? ' more person is' : ' more people are') + ' on the round whom you have not heard of yet. Boards and neighbours will name them.');
    } else if (this.view === 'menu') {
      screen.title = 'Menu';
      p('You are given addresses, not routes. Ask people the way (T), follow the road posts between villages, keep your bearings with the compass at the top of the screen, and build your own map as you go. Work is optional and nothing has a deadline.');
      const keys = [['T', 'Talk to the person in front of you'], ['E', 'Read a Post & Errands board or a public account'], ['N', 'Open or close this book'],
        ['1 – 5', 'Turn to a page of the book (or ← →)'], ['Enter', 'Do the highlighted action'], ['Esc', 'Close the book or end a conversation'], ['R', 'Mount or leave the loan horse']];
      screen.paragraphs.push(keys.map(([key, what]) => key + ' — ' + what).join('\n'));
      screen.blocks.push({ type: 'keys', keys });
      p('VR: right grip opens or closes the book. Point and press the right trigger to choose, stamp the map or draw.');
      const hints = c.story.onboarding?.hintsEnabled !== false;
      act('Back to the round', () => this.setView('round'), { primary: true });
      act(hints ? 'Hide the next-step note on screen' : 'Show the next-step note on screen', () => {
        const result = c.setHints?.(!hints);
        if (!result) return this.notify('Reminder settings are unavailable right now.');
        if (!result.ok) return this.action(result);
        this.reminderDismissed = false; this.render(); this.renderReminder();
      });
      act('Show the welcome again', () => this.setView('welcome'));
      act('Return to normal Wander', () => { this.flush().then(() => this.onReturn?.()); });
      act('Restart First Post', () => {
        if (this.renderer.xr.isPresenting && !this.restartConfirm) { this.restartConfirm = true; this.notify('Restart erases this proof’s progress, map and notebook. Select Restart First Post again to confirm.'); return this.render(); }
        if (!this.renderer.xr.isPresenting && !confirm('Restart First Post? This erases only this prototype’s progress, map and notebook pages.')) return;
        this.onRestart?.().catch(error => this.notify('The proof could not be reset: ' + error.message));
      });
    } else if (this.view === 'conversation') {
      const name = (npcId && c.state.entities[npcId]?.name) || this.population.activeNpc?.identity?.name || 'Conversation';
      screen.title = name; screen.subtitle = ROLE_LABELS[role] || c.story.plot.people?.[role]?.role || '';
      const messages = this.population.dialogueSnapshot().messages.slice(-6);
      for (const message of messages) screen.paragraphs.push((message.role === 'user' ? 'You: ' : '') + message.text);
      if (this.population.chatBusy) screen.paragraphs.push('Thinking…');
      screen.blocks.push({ type: 'chat', messages, busy: this.population.chatBusy });
      screen.fields.push({ id: 'chat', label: 'Say something', value: this.chatDraft });
      const send = btn('Send message', () => {
        this.population.setPointerReleased(); this.population.sendMessage(this.chatDraft); this.chatDraft = ''; this.render();
      }, { disabled: this.population.chatBusy || !this.chatDraft.trim() });
      send.send = true; inline([send]);
      const say = text => { this.population.setPointerReleased(); this.population.sendMessage(text); this.render(); };
      const more = [];
      if (role) {
        for (const def of c.jobs()) {
          if (def.recipient === role && c.story.jobs[def.id].state === 'active') act('Deliver ' + def.title, () => this.action(c.handoff(def.id, npcId)), { primary: true });
        }
        const offers = [];
        for (const def of c.jobs()) {
          const job = c.story.jobs[def.id];
          if (def.sender !== role || job.state === 'delivered') continue;
          if (job.state === 'active') { more.push(btn('Return ' + def.title, () => this.action(c.handoff(def.id, npcId, true)))); continue; }
          offers.push(def); more.push(btn('Pass on ' + def.title, () => this.action(c.decline(def.id, npcId))));
        }
        offers.sort((a, b) => Number(!!b.local) - Number(!!a.local)); // the short local errand first
        if (offers.length) h(name + ' can give you');
        for (const def of offers) card({ icon: icon(def), title: def.title, lines: ['For ' + c.npc(def.recipient).name + ' in ' + placeOf(def.recipient), def.description],
          flat: def.title + ' — for ' + c.npc(def.recipient).name + ' in ' + placeOf(def.recipient) + '.\n' + def.description,
          actions: [btn('Accept ' + def.title, () => this.briefed(this.action(c.accept(def.id, npcId)), npcId), { primary: true })] });
        if (role === 'poet') more.unshift(btn(c.story.works.personal ? 'Read my poem' : 'Tell the poet about my journey', async () => {
          this.notify('The poet is putting your account into words…'); this.render();
          const result = await c.shareJourney(npcId); this.action(result);
          if (result.work) { this.document = { title: result.work.title, text: result.work.introduction + '\n\n' + result.work.lines.join('\n') }; this.setView('document'); this.flush(); }
        }));
      }
      // Something a resident has written down for the courier, handed over in person.
      for (const handed of npcId ? c.handedHere(npcId) : []) {
        h(name + ' has something for you');
        card({ icon: '✉', title: handed.title, lines: [handed.text], flat: handed.title + '\n' + handed.text,
          actions: [btn('Take: ' + handed.title, () => {
            const result = this.action(c.receive(handed.accountId, npcId));
            if (result?.ok && result.document) { this.document = result.document; this.setView('document'); this.flush(); }
          }, { primary: true })] });
      }
      // Anyone can be shown what the courier carries, and says what they make of it.
      if (npcId && Object.keys(c.story.evidence).length) {
        const ending = c.story.plot.closer?.id === npcId && beatOpen(c.story, 'ending');
        const show = btn(ending ? 'Show what I found' : 'Show what I carry', () => this.action(c.shareEvidence(npcId, Object.keys(c.story.evidence))), { primary: ending });
        if (ending) screen.buttons.push(show); else more.push(show);
      }
      // Asking the way is the courier's craft, so it is never tucked away.
      const context = npcId ? c.contextForNpc(npcId) : null;
      for (const route of context?.routes || []) act('Ask the way to ' + route.name, () => this.directions(route.place));
      const seek = new Set();
      for (const def of c.jobs()) {
        const state = c.story.jobs[def.id]?.state;
        if (state === 'active') seek.add(def.recipient);
        else if (def.id === (this.focusedJobId || c.story.focusJobId) && ['offered', 'returned'].includes(state)) seek.add(def.sender);
      }
      const localPlace = context?.place ?? c.getNpcPlace?.(npcId);
      for (const who of [...seek].filter(who => who !== role && c.placeOf(who) === localPlace).slice(0, 2)) {
        const person = c.npc(who);
        act('Ask where ' + person.name + ' lives', () => say('Where can I find ' + person.name + '?'), { disabled: this.population.chatBusy });
      }
      if (role) {
        for (const lesson of context?.travelLessons || []) more.push(btn('Ask: ' + lesson.title, () => {
          this.authoredLine(lesson.text);
          collectNotebookPage(this.notebook.book, { id: 'lesson:' + lesson.id, title: lesson.title,
            author: c.state.entities[npcId].name, text: lesson.text });
          this.flush(); this.render();
        }));
        for (const source of c.sources().filter(s => s.place === c.placeOf(role))) more.push(btn('Read: ' + source.title, () => this.readSource(source, npcId)));
      }
      const referrals = this.localOpportunityCards(npcId).filter(item => (item?.id || item?.jobId) && item?.sender?.id !== npcId);
      if (referrals.length) h('Other errands nearby');
      for (const item of referrals) {
        const id = item.id || item.jobId;
        card({ icon: '✎', title: item.title || 'Delivery opportunity', lines: [(item.sender?.name ? 'Ask ' + item.sender.name + '. ' : '') + (item.description || 'A neighbor can tell you more.')],
          flat: 'Local referral: ' + (item.title || 'Delivery opportunity') + (item.sender?.name ? ' — ask ' + item.sender.name : '') + '\n' + (item.description || 'A neighbor can tell you more.'),
          actions: [btn('View lead: ' + (item.title || id), () => this.focusLead(id))] });
      }
      // Everything occasional sits behind one button so the box shows the
      // conversation and the few things that matter here.
      if (more.length) {
        act(this.talkMore ? 'Fewer options' : 'More to ask (' + more.length + ')', () => { this.talkMore = !this.talkMore; this.render(); });
        if (this.talkMore) screen.buttons.push(...more);
      }
    } else if (this.view === 'stories') {
      screen.title = 'Story: accounts and questions';
      const nearby = this.getNearbySources();
      const held = Object.keys(c.story.evidence);
      if (!held.length) p('People here keep written accounts: receipts, recollections, labels. Recipients sometimes show you one when you deliver, and each village well has a public reading stand. When you hold two accounts of the same thing, compare them here.');
      for (const source of nearby.filter(source => !c.story.evidence[source.id])) act('Read nearby: ' + source.title, () => this.readSource(source), { primary: true });
      const comparedCount = STORY_GLITCHES.filter(beat => beatDone(c.story, beat)).length;
      for (const { tell: thread, accounts: halves, ready, compared } of storyThreads(c.story)) {
        const found = halves.filter(half => half.held).map(half => half.id);
        let hint = '';
        if (!ready) {
          const missing = halves.find(half => !half.held).id;
          const job = c.jobs().find(def => (def.reveals === missing || def.carries === missing) && c.story.jobs[def.id].state !== 'delivered');
          const stands = [...new Set([...(COURIER_EVIDENCE.find(e => e.id === missing)?.places || []).map(place => c.placeName(place)),
            ...Object.entries(c.story.plot.sites).filter(([, site]) => site.offers.some(offer => offer.a === missing && offer.ch === 'stand')).map(([id, site]) => c.placeName(id) || site.name)])];
          hint = 'There is a second account. ' + (job ? 'Delivering “' + job.title + '” may turn it up' + (stands.length ? '; ' : '.') : '')
            + (stands.length ? 'the reading stands in ' + (stands.length > 1 ? stands.slice(0, -1).join(', ') + ' and ' + stands.at(-1) : stands[0]) + ' hold a copy.' : job ? '' : 'Someone, somewhere on your travels, will have it.');
        }
        screen.paragraphs.push('## ' + thread.title + ' — ' + found.length + ' of 2 accounts');
        screen.paragraphs.push(found.map(id => '• ' + c.accountDoc(id).title).join('\n') + (hint ? '\n' + hint : '') + (compared ? '\n\nCompared: ' + thread.comparison : ''));
        const accounts = halves.map(({ id, held: has }) => {
          const doc = has && c.accountDoc(id);
          if (!doc) return { found: false, title: 'A second account', text: hint };
          return { found: true, title: doc.title, text: doc.text.length > 150 ? doc.text.slice(0, 147) + '…' : doc.text,
            action: inline([btn('Open: ' + doc.title, () => { this.document = { title: doc.title, text: doc.text }; this.setView('document'); })])[0] };
        }).sort((a, b) => Number(b.found) - Number(a.found));
        const compare = compared ? null : inline([btn('Compare: ' + thread.title, () => this.action(c.compare(thread.id)), { disabled: !ready, primary: ready })])[0];
        screen.blocks.push({ type: 'thread', title: thread.title, accounts, compared, comparison: thread.comparison, action: compare });
      }
      if (!c.story.hypothesis && held.length) {
        if (comparedCount < 2) p('Compare two different sets of accounts to see whether there is a pattern (' + comparedCount + ' of 2 so far).');
        act('Consider the larger pattern', () => this.action(c.formHypothesis()), { disabled: comparedCount < 2, primary: comparedCount >= 2 });
      }
      if (c.story.hypothesis) {
        h('A first hypothesis');
        const next = c.storyGuidance?.();
        p('Perhaps the records and recollections are repeating parts of other lives.' + (next ? '\n' + next.text : ''));
      }
      // The later papers: what someone named, and what was left for the courier.
      for (const beat of ['named', 'turn']) {
        const id = Object.keys(c.story.evidence).find(account => storyAccount(account)?.beat === beat);
        if (!id) continue;
        const doc = c.accountDoc(id);
        h(beat === 'named' ? 'Someone names it' : 'Something that knew your road');
        card({ icon: '✉', title: doc.title, lines: [doc.author ? doc.author + ', ' + doc.place : ''], flat: doc.title,
          actions: [btn('Open: ' + doc.title, () => { this.document = { title: doc.title, text: doc.text }; this.setView('document'); })] });
      }
      if (c.story.concluded) act('Open: ' + COURIER_ENDING.title, () => { this.document = this.endingDocument(); this.setView('document'); });
      const last = c.story.plot.beats.ending && c.endingDoc();
      if (last) act('Open: ' + last.title, () => { this.document = last; this.setView('document'); }, { primary: true });
    } else if (this.view === 'document') {
      screen.title = this.document?.title || 'Collected page'; p(this.document?.text || '');
      if (this.document?.title === COURIER_ENDING.title || (c.story.plot.beats.ending && this.document?.title === c.endingDoc()?.title)) p('— The end of First Post, for now. Every errand and page stays open to you.');
      if (this.population.dialogueOpen) act('Back to conversation', () => this.setView('conversation'), { primary: true });
      act('Back to accounts', () => this.setView('stories'));
      act('Collected pages', () => this.setView('library'));
    } else if (this.view === 'library') {
      screen.title = 'Collected pages';
      for (const page of this.notebook.book.collected) act(page.title, () => { this.document = page; this.setView('document'); });
      if (!screen.buttons.length) p('Directions, accepted delivery briefs, accounts and poems you collect appear here.');
      act('Back to my notebook', () => this.setView('notes'));
    } else {
      screen.title = 'My notebook';
      const page = this.editPage();
      act('New page', () => { this.pageId = addNotebookPage(this.notebook.book).id; this.markEdited(); this.render(); });
      for (const entry of this.notebook.book.pages) act(entry.title, () => { this.pageId = entry.id; this.render(); });
      if (page) {
        screen.fields.push({ id: 'title', label: 'Page title', value: page.title }, { id: 'note', label: 'Write a note', value: page.text, multiline: true });
        screen.drawing = page;
        if (this.controller.roleFor(this.npcId()) === 'poet' && !this.controller.story.works.personal) {
          act('Share this page with the poet', async () => {
            this.notify('The poet is writing from the journey and this selected page…');
            this.action(await this.controller.shareJourney(this.npcId(), page.text)); this.flush(); this.render();
          });
        }
        act(this.erase ? 'Use pen' : 'Use eraser', () => { this.erase = !this.erase; this.render(); });
        act('Undo last stroke', () => { page.strokes.pop(); this.markEdited(); this.render(); }, { disabled: !page.strokes.length });
        act('Delete this page', () => {
          if (!this.renderer.xr.isPresenting && !confirm('Delete this notebook page?')) return;
          if (this.renderer.xr.isPresenting && !this.deleteConfirm) { this.deleteConfirm = true; this.notify('Select Delete this page again to confirm.'); return this.render(); }
          this.deleteConfirm = false; this.notebook.book.pages = this.notebook.book.pages.filter(p => p.id !== page.id);
          if (!this.notebook.book.pages.length) addNotebookPage(this.notebook.book);
          this.pageId = this.notebook.book.pages[0].id; this.markEdited(); this.render();
        });
      }
      act('Collected pages (' + this.notebook.book.collected.length + ')', () => this.setView('library'));
      act('Print / Save as PDF', () => this.print());
      act('Export notebook', () => this.export());
    }
    return screen;
  }
  fieldChanged(id, value) {
    if (id === 'chat') this.chatDraft = value.slice(0, 320);
    else if (id === 'mapLabel') this.mapLabel = value.slice(0, 40);
    else { const page = this.editPage(); if (!page) return;
      if (id === 'title') page.title = value.slice(0, 100); else page.text = value;
      this.markEdited(); }
    this.dirty = true;
  }
  startStroke(x, y) {
    // The VR pointer reaches the map through the same call as a pen stroke.
    if (this.view === 'map') return this.mapClick(x, y);
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
    const before = this.panel.querySelector('.content');
    const scroll = before && this.renderedView === this.view ? before.scrollTop : 0;
    const screen = this.screen(), talk = this.view === 'conversation';
    this.primaryAction = screen.buttons.find(action => action.primary && !action.disabled) || null;
    const make = action => {
      const b = element('button', action.label, action.primary && !action.disabled ? 'primary' : action.current ? 'current' : '');
      b.disabled = !!action.disabled; b.onclick = action.run;
      if (action.stamp) { const swatch = element('canvas', '', 'swatch'); swatch.width = swatch.height = 40; paintCourierStamp(swatch.getContext('2d'), action.stamp, 40, 40); b.prepend(swatch); }
      if (action === this.primaryAction) { b.dataset.primary = 'true'; b.append(element('kbd', '↵')); }
      if (action.send) b.dataset.send = 'true';
      return b;
    };
    const row = (actions, className = 'actions') => { const el = element('div', '', className); for (const action of actions) el.append(make(action)); return el; };
    this.panel.className = talk ? 'talk' : 'book'; this.panel.replaceChildren();
    const header = element('header'), title = element('h2', screen.title);
    if (screen.subtitle) title.append(element('small', screen.subtitle));
    header.append(title);
    const standing = this.controller.standing?.();
    if (standing && !talk) {
      const pips = element('div', '', 'pips'); pips.setAttribute('aria-label', standing.delivered + ' of ' + standing.total + ' delivered');
      for (let i = 0; i < standing.total; i++) pips.append(element('i', '', i < standing.delivered ? 'pip on' : 'pip'));
      pips.append(element('span', standing.rank)); header.append(pips);
    }
    if (talk) { const book = element('button', 'Open book'); book.onclick = () => this.setView('round'); header.append(book); }
    else {
      if (this.population.dialogueOpen) { const back = element('button', 'Back to talk'); back.onclick = () => this.setView('conversation'); header.append(back); }
      const menu = element('button', 'Menu', this.view === 'menu' ? 'current' : ''); menu.onclick = () => this.setView('menu'); header.append(menu);
    }
    const close = element('button', talk ? 'Leave · Esc' : 'Close · Esc'); close.onclick = () => this.close(); header.append(close);
    const content = element('div', '', 'content' + (this.renderedView !== this.view ? ' turn' : ''));
    const loose = screen.buttons.filter(action => !action.inline);
    const fieldInput = field => {
      const input = element(field.multiline ? 'textarea' : 'input');
      input.value = field.value; input.dataset.field = field.id;
      if (field.inline) { input.placeholder = field.label; input.setAttribute('aria-label', field.label); }
      input.oninput = () => { this.fieldChanged(field.id, input.value); if (field.id === 'chat') {
        const b = this.panel.querySelector('[data-send]'); if (b) b.disabled = !this.chatDraft.trim() || this.population.chatBusy;
      } };
      return input;
    };
    const blocks = screen.blocks.length ? screen.blocks : screen.paragraphs.map(text => String(text).startsWith('## ')
      ? { type: 'h', text: String(text).slice(3) } : { type: 'p', text });
    for (const block of blocks) {
      if (block.type === 'p') content.append(element('p', block.text, block.className || ''));
      else if (block.type === 'h') content.append(element('h3', block.text));
      else if (block.type === 'guide') {
        const guide = element('div', '', 'guide'); guide.append(element('strong', block.title), element('p', block.text));
        if (block.actions.length) guide.append(row(block.actions)); content.append(guide);
      } else if (block.type === 'card') {
        const el = element('div', '', 'card ' + (block.tone || '')), main = element('div', '', 'main'), head = element('div', block.title, 'title');
        if (block.badge) head.append(element('span', block.badge, 'badge'));
        main.append(head); for (const text of block.lines.filter(Boolean)) main.append(element('div', text, 'line'));
        if (block.icon) el.append(element('div', block.icon, 'icon'));
        el.append(main); if (block.actions.length) el.append(row(block.actions, 'side')); content.append(el);
      } else if (block.type === 'thread') {
        const el = element('div', '', 'thread'), pair = element('div', '', 'pair');
        el.append(element('h3', block.title));
        block.accounts.forEach((account, i) => {
          if (i) pair.append(element('div', '', 'tie' + (block.compared ? ' tied' : '')));
          const paper = element('div', '', 'account' + (account.found ? '' : ' missing'));
          paper.append(element('b', account.title), element('p', account.text || 'Not found yet.'));
          if (account.action) { account.action.label = 'Read it'; paper.append(make(account.action)); }
          pair.append(paper);
        });
        el.append(pair);
        if (block.compared) el.append(element('div', 'What does not fit: ' + block.comparison, 'finding'));
        else if (block.action) el.append(row([block.action]));
        content.append(el);
      } else if (block.type === 'keys') {
        const grid = element('div', '', 'keys');
        for (const [key, what] of block.keys) grid.append(element('kbd', key), element('span', what));
        content.append(grid);
      } else if (block.type === 'tools') {
        const tools = row(block.actions, 'tools');
        if (block.field) tools.append(fieldInput(block.field));
        content.append(tools);
      }
      else if (block.type === 'posted') {
        const canvas = element('canvas', '', 'posted'); canvas.width = 900; canvas.height = 600; canvas.setAttribute('aria-label', block.label);
        block.paint(canvas.getContext('2d'), 900, 600); content.append(canvas);
      }
      else if (block.type === 'map') {
        const canvas = element('canvas', '', 'map'); canvas.width = 1000; canvas.height = 600; canvas.setAttribute('aria-label', 'Your map. Click to place the chosen stamp.');
        block.paint(canvas.getContext('2d'), 1000, 600);
        canvas.onpointerdown = event => { const r = canvas.getBoundingClientRect(); this.mapClick((event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height); };
        content.append(canvas);
      } else if (block.type === 'chat') {
        const chat = element('div', '', 'chat');
        for (const message of block.messages) chat.append(element('p', message.text, message.role === 'user' ? 'you' : ''));
        if (block.busy) chat.append(element('p', 'Thinking…', 'busy'));
        content.append(chat); queueMicrotask(() => { chat.scrollTop = chat.scrollHeight; });
        // In a conversation the things you can do come straight after what was said.
        if (talk && loose.length) content.append(row(loose));
      }
    }
    const send = () => { this.population.setPointerReleased(); this.population.sendMessage(this.chatDraft); this.chatDraft = ''; this.render(); };
    let sayRow = null;
    for (const field of screen.fields.filter(field => !field.inline)) {
      const input = fieldInput(field);
      if (field.id === 'chat') {
        input.placeholder = 'Say something… ask the way, ask about work'; input.setAttribute('aria-label', field.label);
        input.onkeydown = event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (this.chatDraft.trim()) send(); else this.primaryAction?.run();
        };
        sayRow = element('div', '', 'say'); sayRow.append(input, make(screen.buttons.find(action => action.send)));
      } else { const label = element('label', field.label); label.append(input); content.append(label); }
    }
    if (screen.drawing) {
      const canvas = element('canvas', '', 'draw'); canvas.width = 800; canvas.height = 480; canvas.setAttribute('aria-label', 'Draw a map or notes');
      const ctx = canvas.getContext('2d'); paintNotebookDrawing(ctx, screen.drawing, 800, 480);
      const point = event => { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (event.clientY - r.top) / r.height))]; };
      canvas.onpointerdown = event => { canvas.setPointerCapture(event.pointerId); this.startStroke(...point(event)); paintNotebookDrawing(ctx, screen.drawing, 800, 480); };
      canvas.onpointermove = event => { if (!this.stroke) return; this.moveStroke(...point(event)); paintNotebookDrawing(ctx, screen.drawing, 800, 480); };
      canvas.onpointerup = () => this.endStroke(); canvas.onpointercancel = () => this.endStroke(); content.append(canvas);
    }
    if (!talk && loose.length) content.append(row(loose));
    this.footer = element('footer');
    if (talk) this.panel.append(header, content, ...(sayRow ? [sayRow] : []));
    else {
      const body = element('div', '', 'body'), nav = element('nav');
      COURIER_TABS.forEach(([id, label], i) => {
        const b = element('button', '', id === this.view ? 'current' : ''); b.append(element('kbd', String(i + 1)), label);
        b.onclick = () => this.setView(id); nav.append(b);
      });
      body.append(nav, content); this.panel.append(header, body, this.footer);
    }
    this.renderedView = this.view; content.scrollTop = scroll;
    this.renderFooter(); this.renderReminder();
    const target = focus ? this.panel.querySelector('[data-field="' + focus + '"]') : talk ? this.panel.querySelector('[data-field="chat"]') : null;
    if (target) { target.focus({ preventScroll: true }); if (focus && selection != null) target.setSelectionRange?.(selection, selection); }
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
    this.panel.remove(); this.toast.remove(); this.reminder.remove(); this.hud?.remove(); this.arrival?.remove(); this.stamp?.remove(); this.style.remove(); clearTimeout(this.toastTimer); clearTimeout(this.mapTimer);
  }
}
