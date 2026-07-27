// Compact head-locked controller legend for immersive VR. DOM overlays are not
// visible inside a normal WebXR session, so train interaction cues must live in
// the rendered scene. The panel stays low in the view and never depth-tests
// against the world.

import * as THREE from 'three';
import {
  XR_INTRO_HINT_SECONDS,
  xrActionHudVisible,
  xrActionItems,
} from './xractions.mjs';

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export class XRActionHUD {
  constructor(camera) {
    this.camera = camera;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 152;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.name = 'XR controller actions';
    this.sprite.position.set(0, -0.48, -1.65);
    this.sprite.scale.set(1.55, 0.23, 1);
    this.sprite.renderOrder = 10000;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
    camera.add(this.sprite);
    this.active = false;
    this.introRemaining = 0;
    this.signature = '';
  }

  setActive(active) {
    this.active = !!active;
    this.introRemaining = this.active ? XR_INTRO_HINT_SECONDS : 0;
    this.signature = '';
    this.material.opacity = 1;
    this.sprite.visible = this.active;
    if (this.active) this.update(null, 0);
  }

  update(cue = null, dt = 0) {
    if (!this.active) return;
    if (!cue) this.introRemaining = Math.max(0, this.introRemaining - Math.max(0, dt));
    const visible = xrActionHudVisible(cue, this.introRemaining);
    this.sprite.visible = visible;
    if (!visible) return;

    // The introductory movement reminder gently clears from the view. Train
    // prompts are contextual and stay fully legible while the action is valid.
    this.material.opacity = cue ? 1 : Math.min(1, this.introRemaining / 1.0);
    const items = xrActionItems(cue);
    const signature = items.map((item) => `${item.button}:${item.action}`).join('|');
    if (signature === this.signature) return;
    this.signature = signature;
    this.draw(items);
  }

  draw(items) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    roundedRect(ctx, 8, 18, width - 16, height - 36, 42);
    ctx.fillStyle = 'rgba(8, 14, 20, 0.74)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(220, 239, 248, 0.38)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.font = '600 30px Helvetica Neue, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    const gap = 34;
    const measurements = items.map((item) => ({
      ...item,
      actionWidth: ctx.measureText(item.action).width,
      buttonWidth: Math.max(58, ctx.measureText(item.button).width + 28),
    }));
    const total = measurements.reduce(
      (sum, item) => sum + item.buttonWidth + 14 + item.actionWidth, 0,
    ) + gap * Math.max(0, measurements.length - 1);
    let x = (width - total) * 0.5;
    const y = height * 0.5;

    for (const item of measurements) {
      roundedRect(ctx, x, y - 32, item.buttonWidth, 64, 20);
      ctx.fillStyle = 'rgba(224, 242, 250, 0.96)';
      ctx.fill();
      ctx.fillStyle = '#13212a';
      ctx.textAlign = 'center';
      ctx.fillText(item.button, x + item.buttonWidth * 0.5, y + 1);
      x += item.buttonWidth + 14;
      ctx.fillStyle = 'rgba(240, 247, 250, 0.94)';
      ctx.textAlign = 'left';
      ctx.fillText(item.action, x, y + 1);
      x += item.actionWidth + gap;
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.camera.remove(this.sprite);
    this.texture.dispose();
    this.material.dispose();
  }
}
