// Browser proof with synthetic microphone input; Quest capture still needs an on-device run.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { chromium } = await import(process.env.WANDER_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), 'wander-openmic-'));
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><body style="background:#344c44;color:white;font:18px system-ui"><h1>Live voice browser proof</h1><script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.185.0/build/three.module.js"}}</script></body>');
      return;
    }
    if (path.includes('..')) throw new Error('Invalid path');
    res.setHeader('content-type', /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream');
    res.end(await readFile(join(root, path)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { NpcLiveMicrophone } = await import('/src/npcliveaudio.mjs');
    window.proof = { frames: 0, grants: 0, muted: [] };
    proof.mic = new NpcLiveMicrophone({ onFrame: frame => { proof.frames++; proof.samples = frame.pcm.length; },
      getUserMedia: options => { proof.grants++; return navigator.mediaDevices.getUserMedia(options); } });
    proof.mic.onMuted = value => proof.muted.push(value);
    await proof.mic.start();
  });
  await page.waitForFunction(() => proof.frames >= 3);
  await page.evaluate(() => proof.mic.setPaused(true));
  const paused = await page.evaluate(() => proof.frames);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => proof.frames), paused);
  assert.equal(await page.evaluate(() => proof.mic.stream.getAudioTracks()[0].enabled), false);
  await page.evaluate(() => proof.mic.setPaused(false));
  await page.waitForFunction(count => proof.frames > count + 3, paused);
  const capture = await page.evaluate(() => ({ frames: proof.frames, grants: proof.grants,
    samples: proof.samples, context: proof.mic.context.state, muted: proof.muted }));
  assert.equal(capture.grants, 1);
  assert.equal(capture.context, 'running');
  assert.equal(capture.samples, 320);
  await page.evaluate(async () => {
    const { XRActionHUD } = await import('/src/xractionhud.js');
    const { PerspectiveCamera } = await import('three');
    const hud = new XRActionHUD(new PerspectiveCamera());
    hud.setActive(true);
    for (const [label, cue, dt, status] of [
      ['Onboarding and voice', null, 0, 'Listening nearby'],
      ['Voice after onboarding', null, 6, 'Listening · Maren'],
      ['Train controls and voice', { mode: 'riding', primaryAction: 'STAND', secondaryAction: 'SWITCH SEAT' }, 0, 'Speaking · Maren'],
      ['Capture unavailable', null, 0, 'Microphone muted or audio suspended'],
    ]) {
      hud.update(cue, dt, status);
      if (!hud.presentation.visible || !hud.sprite.visible) throw new Error('Voice HUD disappeared');
      const revision = hud.contentRevision;
      hud.update(cue, 0, status);
      if (hud.contentRevision !== revision) throw new Error('Idle HUD redraws every frame');
      const caption = document.createElement('p'); caption.textContent = label; document.body.append(caption);
      const image = document.createElement('img'); image.src = hud.canvas.toDataURL(); image.style.width = '1024px'; document.body.append(image);
    }
    hud.update(null, 0, '');
    if (hud.presentation.visible) throw new Error('Disabled voice left a persistent HUD');
    proof.hudRevision = hud.contentRevision;
    hud.dispose();
    const track = proof.mic.stream.getAudioTracks()[0];
    proof.mic.stop(); proof.stopped = track.readyState;
  });
  assert.equal(await page.evaluate(() => proof.stopped), 'ended');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, 'voice-hud.png'), fullPage: true });
  const report = { capture, stopped: 'ended', browserErrors: errors, artifacts };
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
