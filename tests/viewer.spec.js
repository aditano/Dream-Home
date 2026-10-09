import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const ARTIFACTS = '/opt/cursor/artifacts/screenshots';

function projectKind(name) {
  if (name.includes('desktop')) return 'desktop';
  return 'mobile';
}

test('model loads without console errors', async ({ page }, testInfo) => {
  const kind = projectKind(testInfo.project.name);
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/?quality=' + kind);
  await page.waitForFunction(() => window.dreamHome && window.dreamHome.ready(), null, { timeout: 90000 });
  await page.waitForTimeout(500);

  const stats = await page.evaluate(() => window.dreamHome.stats());
  const outDir = testInfo.outputPath('stats');
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.writeFileSync(testInfo.outputPath('stats.json'), JSON.stringify(stats, null, 2));
  console.log(testInfo.project.name, JSON.stringify(stats));

  expect(errors, errors.join('\n')).toEqual([]);
  expect(stats.tier).toBe(kind);
  expect(stats.modelUrl).toContain(kind === 'mobile' ? 'dream_house_mobile.glb' : 'dream_house.glb');
  expect(stats.modelUrl.includes('mobile')).toBe(kind === 'mobile');
  expect(stats.triangles).toBeGreaterThan(1000);

  if (kind === 'mobile') {
    if (testInfo.project.name === 'webkit-iphone') expect(stats.reasons).toContain('ios');
    expect(stats.triangles).toBeLessThan(1000000);
    expect(stats.textureBytes).toBeLessThan(80 * 1024 * 1024);
    expect(stats.dpr).toBeLessThanOrEqual(1.5);
    expect(stats.shadows).toBe(false);
    expect(stats.antialias).toBe(false);
    await expect(page.locator('#menu-btn')).toBeVisible();
    await page.evaluate(() => document.getElementById('menu-btn').click());
    await expect(page.locator('#sidebar')).toHaveClass(/open/);
    await page.evaluate(() => window.dreamHome.pause());
    if (testInfo.project.name === 'webkit-iphone') {
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, 'webkit-iphone-menu.png'), timeout: 20000, animations: 'disabled' });
    }
    await page.evaluate(() => document.getElementById('scrim').click());
    await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
    const jumped = await page.evaluate(() => window.dreamHome.jump('kitchen_dining'));
    expect(jumped).toBe(true);
    await page.evaluate(() => window.dreamHome.pause());
    if (testInfo.project.name === 'webkit-iphone') {
      await page.screenshot({ path: 'assets/fallback/kitchen.jpg', type: 'jpeg', quality: 70, timeout: 20000, animations: 'disabled' });
      await page.screenshot({ path: path.join(ARTIFACTS, 'webkit-iphone-kitchen.png'), timeout: 20000, animations: 'disabled' });
      await page.evaluate(() => window.dreamHome.jump('front_elevation'));
      await page.evaluate(() => window.dreamHome.pause());
      await page.screenshot({ path: 'assets/fallback/front.jpg', type: 'jpeg', quality: 70, timeout: 20000, animations: 'disabled' });
      await page.screenshot({ path: path.join(ARTIFACTS, 'webkit-iphone-front.png'), timeout: 20000, animations: 'disabled' });
    }
    if (stats.heap && typeof stats.heap.usedJSHeapSize === 'number') {
      expect(stats.heap.usedJSHeapSize).toBeLessThan(400 * 1024 * 1024);
    }
  } else {
    expect(stats.triangles).toBeGreaterThan(1000000);
    await expect(page.locator('#menu-btn')).toBeHidden();
  }
});
