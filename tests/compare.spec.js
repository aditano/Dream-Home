import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';

const ARTIFACTS = '/opt/cursor/artifacts/screenshots';
const DOCS = path.resolve('docs/compare');

const VIEWS = [
  ['front_elevation', 'Front elevation'],
  ['gate_approach', 'Driveway and gate'],
  ['kitchen_dining', 'Kitchen'],
  ['master_bedroom', 'Master bedroom'],
];

const COLUMNS = [
  ['desktop', 'Desktop'],
  ['high', 'High'],
  ['low', 'Low, previous phone model'],
];

function writeFileRetry(file, data) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (err) {
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (attempt + 1));
    }
  }
  throw lastErr;
}

function decodeShot(dataUrl) {
  const body = dataUrl.split(',')[1];
  return Buffer.from(body, 'base64');
}

async function labelPanel(buf, title) {
  const meta = await sharp(buf).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const svg = Buffer.from(
    `<svg width="${width}" height="42" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#14171c"/><text x="16" y="27" fill="#f2efe9" font-family="sans-serif" font-size="18">${title}</text></svg>`,
  );
  const photo = await sharp(buf).jpeg({ quality: 80 }).toBuffer();
  return sharp({
    create: { width, height: height + 42, channels: 3, background: '#14171c' },
  }).composite([
    { input: svg, top: 0, left: 0 },
    { input: photo, top: 42, left: 0 },
  ]).jpeg({ quality: 76 }).toBuffer();
}

async function sideBySide(panels) {
  const metas = await Promise.all(panels.map((panel) => sharp(panel).metadata()));
  const height = metas[0].height || 1;
  const width = metas.reduce((sum, meta) => sum + (meta.width || 0), 0);
  let left = 0;
  const layers = [];
  for (let i = 0; i < panels.length; i++) {
    layers.push({ input: panels[i], top: 0, left });
    left += metas[i].width || 0;
  }
  return sharp({
    create: { width, height, channels: 3, background: '#14171c' },
  }).composite(layers).jpeg({ quality: 76 }).toBuffer();
}

test('side by side views of desktop, high, and low', async ({ page }, testInfo) => {
  test.setTimeout(300000);
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await page.setViewportSize({ width: 960, height: 600 });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.mkdirSync(DOCS, { recursive: true });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  const shots = {};
  for (const [quality] of COLUMNS) {
    errors.length = 0;
    await page.goto('/?quality=' + quality);
    await page.waitForFunction(() => window.dreamHome && window.dreamHome.ready(), null, { timeout: 180000 });
    expect(errors, errors.join('\n')).toEqual([]);
    const stats = await page.evaluate(() => window.dreamHome.stats());
    fs.writeFileSync(path.join(DOCS, `stats-${quality}.json`), JSON.stringify(stats, null, 2));
    console.log('compare', quality, stats.triangles, stats.textureBytes, stats.info && stats.info.calls);
    shots[quality] = {};
    for (const [id] of VIEWS) {
      const ok = await page.evaluate((viewId) => window.dreamHome.jump(viewId), id);
      expect(ok).toBe(true);
      await page.evaluate(() => window.dreamHome.pause());
      const dataUrl = await page.evaluate(() => window.dreamHome.snapshot());
      shots[quality][id] = decodeShot(dataUrl);
      await page.evaluate(() => window.dreamHome.resume());
    }
  }

  for (const [id, title] of VIEWS) {
    const panels = [];
    for (const [quality, label] of COLUMNS) {
      panels.push(await labelPanel(shots[quality][id], label));
    }
    const row = await sideBySide(panels);
    const name = `compare-${id}.jpg`;
    writeFileRetry(path.join(DOCS, name), row);
    writeFileRetry(path.join(ARTIFACTS, name), row);
  }
});
