import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const ARTIFACTS = '/opt/cursor/artifacts/screenshots';
const MB = 1024 * 1024;

async function openReady(page, quality) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('/?quality=' + quality);
  await page.waitForFunction(() => window.dreamHome && window.dreamHome.ready(), null, { timeout: 150000 });
  await page.waitForTimeout(200);
  const stats = await page.evaluate(() => window.dreamHome.stats());
  return { errors, stats };
}

function writeStats(testInfo, stats) {
  const out = testInfo.outputPath('stats.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(stats, null, 2));
  console.log(testInfo.project.name, JSON.stringify(stats));
}

test('high tier stays inside the phone budget', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-iphone');
  const { errors, stats } = await openReady(page, 'high');
  writeStats(testInfo, stats);
  expect(errors, errors.join('\n')).toEqual([]);
  expect(stats.tier).toBe('high');
  expect(stats.reasons).toContain('ios');
  expect(stats.modelUrls.join(' ')).toContain('dream_house_high_shell.glb');
  expect(stats.modelUrls.join(' ')).toContain('dream_house_high_props.glb');
  expect(stats.triangles).toBeGreaterThan(600000);
  expect(stats.triangles).toBeLessThan(1500000);
  expect(stats.textureBytes).toBeGreaterThan(80 * MB);
  expect(stats.textureBytes).toBeLessThan(400 * MB);
  expect(stats.dpr).toBeLessThanOrEqual(1.5);
  expect(stats.shadows).toBe(true);
  expect(stats.shadowSize).toBe(1024);
  expect(stats.antialias).toBe(true);
  expect(stats.env).toBe(true);
  expect(stats.forestTrees).toBeGreaterThan(2000);
  expect(stats.forestTrees).toBeLessThan(5000);
  expect(stats.info.calls).toBeGreaterThan(0);
  expect(stats.info.calls).toBeLessThan(500);
  expect(stats.info.triangles).toBeGreaterThan(1000);
  expect(stats.info.triangles).toBeLessThan(2500000);
  expect(stats.info.geometries).toBeGreaterThan(0);
  expect(stats.info.textures).toBeGreaterThan(0);
  await expect(page.locator('#quality option[value="low"]')).toHaveCount(1);
  await expect(page.locator('#quality option[value="balanced"]')).toHaveCount(1);
  await expect(page.locator('#quality option[value="high"]')).toHaveCount(1);
  await expect(page.locator('#quality option[value="desktop"]')).toHaveCount(1);
  await expect(page.locator('#menu-btn')).toBeVisible();
  await page.evaluate(() => document.getElementById('menu-btn').click());
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await page.evaluate(() => document.getElementById('scrim').click());
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  const jumped = await page.evaluate(() => window.dreamHome.jump('kitchen_dining'));
  expect(jumped).toBe(true);
  await page.evaluate(() => window.dreamHome.pause());
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'webkit-iphone-high-kitchen.png'), timeout: 20000, animations: 'disabled' });
  await page.evaluate(() => window.dreamHome.jump('front_elevation'));
  await page.evaluate(() => window.dreamHome.pause());
  await page.screenshot({ path: path.join(ARTIFACTS, 'webkit-iphone-high-front.png'), timeout: 20000, animations: 'disabled' });
});

test('low tier keeps the previous phone budget', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-iphone');
  const { errors, stats } = await openReady(page, 'low');
  writeStats(testInfo, stats);
  expect(errors, errors.join('\n')).toEqual([]);
  expect(stats.tier).toBe('low');
  expect(stats.modelUrl).toContain('dream_house_mobile.glb');
  expect(stats.triangles).toBeGreaterThan(1000);
  expect(stats.triangles).toBeLessThan(1000000);
  expect(stats.textureBytes).toBeLessThan(80 * MB);
  expect(stats.dpr).toBeLessThanOrEqual(1.5);
  expect(stats.shadows).toBe(false);
  expect(stats.antialias).toBe(false);
  expect(stats.env).toBe(false);
  expect(stats.forestTrees).toBeLessThan(800);
  expect(stats.info.calls).toBeGreaterThan(0);
  expect(stats.info.calls).toBeLessThan(500);
  expect(stats.info.geometries).toBeGreaterThan(0);
  expect(stats.info.textures).toBeGreaterThan(0);
});

test('a crash during high reloads into balanced', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-iphone');
  await page.addInitScript(() => sessionStorage.setItem('dreamhome-boot', 'high'));
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.waitForFunction(() => window.dreamHome && window.dreamHome.ready(), null, { timeout: 150000 });
  const stats = await page.evaluate(() => window.dreamHome.stats());
  writeStats(testInfo, stats);
  expect(errors, errors.join('\n')).toEqual([]);
  expect(stats.tier).toBe('balanced');
  expect(stats.fellBack).toBe(true);
  expect(stats.modelUrl).toContain('dream_house_balanced.glb');
  expect(stats.textureBytes).toBeLessThan(160 * MB);
  expect(stats.shadowSize).toBe(1024);
  expect(stats.shadows).toBe(true);
  await expect(page.locator('#tier-note')).toContainText('Balanced');
});

test('ipad high tier loads the same phone model', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-ipad');
  const { errors, stats } = await openReady(page, 'high');
  writeStats(testInfo, stats);
  expect(errors, errors.join('\n')).toEqual([]);
  expect(stats.tier).toBe('high');
  expect(stats.reasons).toContain('ios');
  expect(stats.triangles).toBeLessThan(1500000);
  expect(stats.textureBytes).toBeLessThan(400 * MB);
  expect(stats.shadowSize).toBe(1024);
  expect(stats.info.calls).toBeLessThan(500);
  await expect(page.locator('#menu-btn')).toBeHidden();
  await expect(page.locator('#sidebar')).toBeVisible();
  const jumped = await page.evaluate(() => window.dreamHome.jump('master_bedroom'));
  expect(jumped).toBe(true);
  await page.evaluate(() => window.dreamHome.pause());
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, 'webkit-ipad-high-bedroom.png'), timeout: 20000, animations: 'disabled' });
});

test('balanced tier on a phone-sized chromium window', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  const { errors, stats } = await openReady(page, 'balanced');
  writeStats(testInfo, stats);
  expect(errors, errors.join('\n')).toEqual([]);
  expect(stats.tier).toBe('balanced');
  expect(stats.modelUrl).toContain('dream_house_balanced.glb');
  expect(stats.triangles).toBeGreaterThan(600000);
  expect(stats.triangles).toBeLessThan(1500000);
  expect(stats.textureBytes).toBeLessThan(160 * MB);
  expect(stats.shadows).toBe(true);
  expect(stats.shadowSize).toBe(1024);
  expect(stats.env).toBe(true);
  expect(stats.antialias).toBe(true);
  expect(stats.info.calls).toBeLessThan(500);
  expect(stats.info.geometries).toBeGreaterThan(0);
  expect(stats.info.textures).toBeGreaterThan(0);
  if (stats.heap && typeof stats.heap.usedJSHeapSize === 'number') {
    expect(stats.heap.usedJSHeapSize).toBeLessThan(700 * MB);
  }
});

test('desktop tier loads the full model', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  const { errors, stats } = await openReady(page, 'desktop');
  writeStats(testInfo, stats);
  expect(errors, errors.join('\n')).toEqual([]);
  expect(stats.tier).toBe('desktop');
  expect(stats.modelUrl).toContain('dream_house.glb');
  expect(stats.modelUrl.includes('mobile')).toBe(false);
  expect(stats.modelUrl.includes('high')).toBe(false);
  expect(stats.triangles).toBeGreaterThan(1000000);
  expect(stats.shadowSize).toBe(4096);
  expect(stats.env).toBe(true);
  await expect(page.locator('#menu-btn')).toBeHidden();
});

test('old mobile query still selects low', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  await page.goto('/?quality=mobile');
  await page.waitForFunction(() => window.dreamHome, null, { timeout: 20000 });
  const tier = await page.evaluate(() => window.dreamHome.tier);
  expect(tier).toBe('low');
});
