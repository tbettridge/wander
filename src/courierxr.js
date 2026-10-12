import * as THREE from 'three';
import { paintNotebookDrawing } from './notebook.mjs';

// Pure hit testing is also used by the desktop controller simulation tests.
export function courierPanelHit(rects, x, y) {
  return rects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) || null;
}
export class CourierXRPanel {
  constructor({ ui, renderer, scene, camera, controls, canOpen }) {
    Object.assign(this, { ui, renderer, scene, camera, controls, canOpen }); ui.xr = this;
    this.canvas = document.createElement('canvas'); this.canvas.width = 1200; this.canvas.height = 1080;
    this.ctx = this.canvas.getContext('2d'); this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.minFilter = THREE.LinearFilter; this.texture.generateMipmaps = false;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.864), new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, depthTest: false }));
    this.mesh.renderOrder = 1200; this.mesh.visible = false; this.mesh.frustumCulled = false; controls.rig.add(this.mesh);
    this.raycaster = new THREE.Raycaster(); this.matrix = new THREE.Matrix4(); this.rects = []; this.offset = 0; this.page = 0;
    this.gripHeld = false; this.triggerHeld = false; this.controller = null;
    this.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xc4ae77, depthTest: false }));
    this.line.visible = false; this.line.renderOrder = 1201;
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      if (!controller.parent) scene.add(controller);
      controller.addEventListener('connected', event => { if (event.data.handedness === 'right') { this.controller = controller; controller.add(this.line); } });
    }
  }
  recenter() {
    const camera = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera(this.camera) : this.camera;
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const forward = camera.getWorldDirection(new THREE.Vector3()); forward.y = 0; forward.normalize();
    const position = eye.clone().addScaledVector(forward, 1.15); position.y -= 0.06;
    this.controls.rig.updateWorldMatrix(true, false); this.mesh.position.copy(this.controls.rig.worldToLocal(position));
    this.mesh.lookAt(eye); this.ui.dirty = true; this.page = 0; this.offset = 0;
  }
  rect(label, x, y, w, h, run, disabled = false) {
    const c = this.ctx; c.fillStyle = disabled ? '#d3ccba' : '#e4dbc4'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#88937c'; c.strokeRect(x, y, w, h); c.fillStyle = disabled ? '#8a8e7b' : '#25352e';
    c.font = '24px system-ui'; c.fillText(label.length > Math.floor(w / 13) ? label.slice(0, Math.floor(w / 13) - 1) + '…' : label, x + 10, y + h / 2 + 8);
    this.rects.push({ x, y, w, h, run: disabled ? () => {} : run });
  }
  lines(text, width = 74) {
    const result = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        if ((line + ' ' + word).length > width && line) { result.push(line); line = word; }
        else line += (line ? ' ' : '') + word;
      }
      result.push(line);
    }
    return result;
  }
  redraw() {
    const ui = this.ui, c = this.ctx, screen = ui.screen(); this.rects = [];
    this.offset = Math.min(this.offset, Math.max(0, Math.floor((screen.buttons.length - 1) / 8) * 8));
    c.fillStyle = '#f5efdd'; c.fillRect(0, 0, 1200, 1080); c.fillStyle = '#203e32'; c.fillRect(0, 0, 1200, 84);
    c.fillStyle = '#faf6e9'; c.font = '32px Georgia'; c.fillText(screen.title.slice(0, 42), 28, 54);
    this.rect('Close', 1060, 15, 112, 52, () => ui.close());
    const tabs = [['next', 'Next'], ['leads', 'Leads'], ['conversation', 'Talk'], ['satchel', 'Satchel'], ['notes', 'Notebook'], ['more', 'More']];
    tabs.forEach(([id, name], i) => this.rect(name, 24 + i * 150, 100, 138, 50, () => { ui.setView(id); this.page = 0; this.offset = 0; }, id === 'conversation' && !ui.population.dialogueOpen && !(ui.population.activeNpc?.distance <= 4.5)));
    this.rect('Recenter', 965, 100, 207, 50, () => this.recenter());
    c.font = '25px Georgia'; c.fillStyle = '#25352e';
    if (ui.keyboard) { this.drawKeyboard(screen); this.texture.needsUpdate = true; ui.dirty = false; return; }
    const lines = screen.paragraphs.flatMap(p => [...this.lines(p), '']);
    const pageLines = screen.drawing ? 0 : screen.fields.length ? 8 : 12;
    const pages = Math.max(1, Math.ceil(lines.length / Math.max(1, pageLines)));
    this.page = Math.min(this.page, pages - 1);
    for (const [i, line] of lines.slice(this.page * pageLines, (this.page + 1) * pageLines).entries()) c.fillText(line, 28, 195 + i * 34);
    if (pages > 1) {
      this.rect('Previous text', 28, 615, 205, 44, () => { this.page = Math.max(0, this.page - 1); ui.dirty = true; }, this.page === 0);
      this.rect('More text', 247, 615, 205, 44, () => { this.page++; ui.dirty = true; }, this.page >= pages - 1);
      c.font = '22px system-ui'; c.fillText((this.page + 1) + ' / ' + pages, 490, 645);
    }
    for (const [i, field] of screen.fields.entries()) {
      this.rect(field.label + ': ' + field.value.replace(/\n/g, ' ').slice(-64), 28, 175 + i * 68 + (screen.drawing ? 0 : 305), 1144, 56, () => {
        ui.inputTarget = field.id; ui.keyboard = true; ui.dirty = true;
      });
    }
    if (screen.drawing) {
      this.drawingRect = { x: (1200 - 320 * 5 / 3) / 2, y: 327, w: 320 * 5 / 3, h: 320 };
      const offscreen = this.drawingCanvas ||= Object.assign(document.createElement('canvas'), { width: 800, height: 480 });
      paintNotebookDrawing(offscreen.getContext('2d'), screen.drawing, 800, 480);
      const r = this.drawingRect;
      c.drawImage(offscreen, r.x, r.y, r.w, r.h); c.strokeStyle = '#88937c'; c.strokeRect(r.x, r.y, r.w, r.h);
    } else this.drawingRect = null;
    const visible = screen.buttons.slice(this.offset, this.offset + 8);
    visible.forEach((action, i) => this.rect(action.label, 28 + (i % 2) * 580, 684 + Math.floor(i / 2) * 66, 565, 55, action.run, action.disabled));
    if (screen.buttons.length > 8) {
      this.rect('Previous actions', 28, 955, 245, 45, () => { this.offset = Math.max(0, this.offset - 8); ui.dirty = true; }, this.offset === 0);
      this.rect('More actions', 290, 955, 225, 45, () => { this.offset += 8; ui.dirty = true; }, this.offset + 8 >= screen.buttons.length);
    }
    c.font = '20px system-ui'; c.fillStyle = '#4e604f';
    c.fillText((ui.notebook.lastError ? 'Pages not saved. ' : '') + ui.message.slice(0, 95), 28, 1032);
    c.fillText('Right grip: close book · right trigger: select or draw', 28, 1060);
    this.texture.needsUpdate = true; ui.dirty = false;
  }
  drawKeyboard(screen) {
    const ui = this.ui, c = this.ctx;
    const field = screen.fields.find(f => f.id === ui.inputTarget);
    if (!field) { ui.keyboard = false; ui.dirty = true; return; }
    c.fillStyle = '#25352e'; c.font = '28px Georgia'; c.fillText(field.label, 28, 207);
    this.lines(field.value.slice(-300), 70).slice(-5).forEach((line, i) => c.fillText(line, 28, 250 + i * 36));
    const update = value => { ui.fieldChanged(field.id, value); ui.dirty = true; };
    ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm.,?'].forEach((row, ri) => [...row].forEach((char, ci) => {
      const value = ui.shift ? char.toUpperCase() : char;
      this.rect(value, 44 + ci * 110, 474 + ri * 85, 98, 70, () => update(field.value + value));
    }));
    this.rect('Shift', 44, 837, 155, 65, () => { ui.shift = !ui.shift; ui.dirty = true; });
    this.rect('Space', 213, 837, 355, 65, () => update(field.value + ' '));
    this.rect('Backspace', 582, 837, 252, 65, () => update(field.value.slice(0, -1)));
    this.rect('New line', 848, 837, 275, 65, () => update(field.value + '\n'));
    this.rect(field.id === 'chat' ? 'Send' : 'Done writing', 44, 932, 500, 65, () => {
      if (field.id === 'chat') { ui.population.setPointerReleased(); ui.population.sendMessage(ui.chatDraft); ui.chatDraft = ''; }
      ui.keyboard = false; ui.flush(); ui.render();
    }, field.id === 'chat' && ui.population.chatBusy);
    this.rect('Back to page', 568, 932, 555, 65, () => { ui.keyboard = false; ui.dirty = true; });
  }
  update() {
    if (!this.renderer.xr.isPresenting) { this.mesh.visible = false; this.line.visible = false; this.gripHeld = false; this.triggerHeld = false; return; }
    const source = [...(this.renderer.xr.getSession()?.inputSources || [])].find(s => s.handedness === 'right');
    const grip = !!source?.gamepad?.buttons?.[1]?.pressed, trigger = !!source?.gamepad?.buttons?.[0]?.pressed;
    if (grip && !this.gripHeld && this.canOpen()) { if (this.ui.isOpen) this.ui.close(); else { this.ui.open(); this.recenter(); } }
    this.gripHeld = grip; this.mesh.visible = this.ui.isOpen; this.line.visible = this.ui.isOpen && !!this.controller;
    if (this.ui.isOpen) {
      this.ui.population.dialogueEl.style.display = 'none';
      if (this.ui.dirty) this.redraw();
      if (this.controller) {
        this.controller.updateWorldMatrix(true, false); this.mesh.updateWorldMatrix(true, false);
        this.matrix.extractRotation(this.controller.matrixWorld);
        this.raycaster.ray.origin.setFromMatrixPosition(this.controller.matrixWorld);
        this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.matrix);
        const hit = this.raycaster.intersectObject(this.mesh)[0]; this.line.scale.z = hit?.distance || 1.5;
        if (hit) {
          const x = hit.uv.x * 1200, y = (1 - hit.uv.y) * 1080, rect = this.drawingRect;
          const inDrawing = !this.ui.keyboard && rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
          if (trigger && inDrawing) {
            const u = (x - rect.x) / rect.w, v = (y - rect.y) / rect.h;
            if (!this.triggerHeld) this.ui.startStroke(u, v); else this.ui.moveStroke(u, v);
          } else if (trigger && !this.triggerHeld) courierPanelHit(this.rects, x, y)?.run();
        }
        if (!trigger && this.triggerHeld && this.ui.stroke) this.ui.endStroke();
      }
    }
    this.triggerHeld = trigger;
  }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose(); this.line.removeFromParent(); this.line.geometry.dispose(); this.line.material.dispose(); }
}
