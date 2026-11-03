import { expect, test, type Locator, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { DESKTOP, expectPhoneFit, sidewaysScroll, useWidth, type Width } from '../harness/console.js';
import { withDb } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { hostInventory, setHostReportedAt } from '../harness/host.js';
import { fixture, reseedWorld } from '../harness/seed.js';

/**
 * Restart that confirms then follows, and Copy for Claude (SHP-T-19.7, SHP-REQ-210/211/212/242,
 * SHP-ADR-013), against the real server and the seeded snapshot, at 1440 and 390 px in both themes.
 *
 * This harness runs no agent, so a confirmed Restart is refused `agent_offline` at once and the
 * sheet must say the restart did not go through; and the incident bundle comes back with its logs
 * unavailable, which must be said in the line under Copy for Claude and not hide the facts.
 */

const WORKER = 'bindery-worker-1';

function containerId(name: string): string {
  const found = hostInventory(Date.now()).containers.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no seeded container ${name}`);
  return found.id;
}

async function openSheet(page: Page, name = WORKER): Promise<Locator> {
  await page.goto(`/host?container=${containerId(name)}`);
  await expect(page.locator('h1', { hasText: 'Host' })).toBeAttached();
  const sheet = page.getByRole('dialog', { name });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function expectClean(page: Page, label: string, width: Width): Promise<void> {
  await settle(page);
  const { blocking } = await axeViolations(page);
  expect(blocking, `${label}:\n  ${blocking.join('\n  ')}`).toEqual([]);
  const { overflow, culprits } = await sidewaysScroll(page);
  expect(overflow, `${label} scrolls sideways:\n  ${culprits.join('\n  ')}`).toBeLessThanOrEqual(0);
  if (width === 'phone') await expectPhoneFit(page, label);
}

test.beforeEach(async () => {
  await withDb((db) => setHostReportedAt(db, fixture().agentId, new Date()));
});

// A refused restart leaves a row in Activity; put the baseline back for the specs after this one.
test.afterAll(async () => {
  await withDb((db) => reseedWorld(db));
});

for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
  for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
    test.describe(`admin at ${width === 'phone' ? '390 px' : '1440 px'}, ${theme}`, () => {
      test.use({ storageState: storageStateFor('admin'), permissions: ['clipboard-read', 'clipboard-write'], ...useWidth(width) });

      test('Restart asks first, naming the container and its app; Cancel sends nothing — axe clean', async ({ page }) => {
        const posted: string[] = [];
        page.on('request', (r) => {
          if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/actions') posted.push(r.url());
        });
        await forceTheme(page, theme);
        const sheet = await openSheet(page);
        await expectTheme(page, theme);
        await sheet.getByRole('button', { name: 'Restart', exact: true }).click();
        const confirm = page.getByRole('dialog', { name: `Restart ${WORKER}?` });
        await expect(confirm).toBeVisible();
        await expect(confirm.getByText(/^bindery · worker restarts on the same image\./)).toBeVisible();
        await expectClean(page, `Restart confirmation (${theme}, ${width})`, width);
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await expect(confirm).toHaveCount(0);
        expect(posted).toEqual([]);
      });

      test('a confirmed Restart with no agent says the restart did not go through — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        const sheet = await openSheet(page);
        await sheet.getByRole('button', { name: 'Restart', exact: true }).click();
        await page.getByRole('dialog', { name: `Restart ${WORKER}?` }).getByRole('button', { name: 'Restart', exact: true }).click();
        await expect(sheet.getByText('The restart did not go through')).toBeVisible();
        await expect(sheet.getByText('The agent that runs this has not polled the server recently.').first()).toBeVisible();
        // Nothing restarted, so nothing to follow: the buttons are usable again.
        await expect(sheet.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
        await expectClean(page, `Restart refused (${theme}, ${width})`, width);
      });

      test('Copy for Claude copies the bundle and says what it copied — axe clean', async ({ page }) => {
        await forceTheme(page, theme);
        const sheet = await openSheet(page);
        await sheet.getByRole('button', { name: 'Copy for Claude' }).click();
        await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible({ timeout: 90_000 });
        // No agent answers here, so the logs are unavailable, and the line says so.
        await expect(sheet.getByText(/^Copied \d+ facts? for Claude — logs unavailable: .* Built just now, stored nowhere\.$/)).toBeVisible();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied.startsWith('# Incident:')).toBe(true);
        expect(copied).toContain(WORKER);
        expect(copied).toContain('Logs unavailable:');
        await expectClean(page, `Copied for Claude (${theme}, ${width})`, width);
      });
    });
  }
}

test.describe('a viewer', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: DESKTOP });

  test('sees neither Restart nor Copy for Claude', async ({ page }) => {
    const sheet = await openSheet(page);
    await expect(sheet.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Copy for Claude' })).toHaveCount(0);
    await settle(page);
    const { overflow } = await sidewaysScroll(page);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

