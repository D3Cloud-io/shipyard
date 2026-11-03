import { expect, test, type Page } from '@playwright/test';
import { axeViolations, expectTheme, forceTheme, settle, type Theme } from '../harness/a11y.js';
import { DESKTOP, PHONE, expectPhoneFit, h1, sidewaysScroll, useWidth, type Width } from '../harness/console.js';
import { withDb } from '../harness/db.js';
import { storageStateFor } from '../harness/env.js';
import { setHostReportedAt } from '../harness/host.js';
import { OVERVIEW_FIXTURE, clearFailingContainers, seedFailingContainer, seededContainerId } from '../harness/overview.js';
import { fixture } from '../harness/seed.js';

/**
 * Overview (SHP-T-19.6, SHP-REQ-207, SHP-REQ-209), against the real server, the seeded host
 * snapshot (harness/host.ts) and one failing Deployed container (harness/overview.ts): at 1440 px
 * and at 390 px on a touch phone, in light and dark — axe clean and never wider than the viewport.
 * The banner names the failing container and opens its sheet on Host; the tiles and the chips are
 * there, and on a phone the quiet chips fold into one line.
 */

const FAILING = OVERVIEW_FIXTURE.failingContainer;
const APP = OVERVIEW_FIXTURE.app;

async function openOverview(page: Page): Promise<void> {
  await page.goto('/overview');
  await h1(page, 'Overview');
  await expect(page.getByRole('group', { name: 'What runs' })).toBeVisible();
  await settle(page);
}

test.use({ storageState: storageStateFor('admin') });

test.beforeEach(async () => {
  const agentId = fixture().agentId;
  await withDb(async (db) => {
    await setHostReportedAt(db, agentId, new Date());
    await seedFailingContainer(db, agentId);
  });
});

test.afterAll(async () => {
  await withDb((db) => clearFailingContainers(db, fixture().agentId));
});

for (const width of ['desktop', 'phone'] as const satisfies readonly Width[]) {
  for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
    test.describe(`${width === 'phone' ? '390 px' : '1440 px'}, ${theme}`, () => {
      test.use(useWidth(width));

      test('Overview is axe clean and no wider than the viewport, with a banner', async ({ page }) => {
        await forceTheme(page, theme);
        await openOverview(page);
        await expectTheme(page, theme);
        const incidents = page.getByRole('group', { name: 'Incidents' });
        await expect(incidents.getByText(`${APP} is degraded`)).toBeVisible();
        await expect(incidents.getByText(new RegExp(`^${FAILING} unhealthy since `))).toBeVisible();
        await expect(incidents.getByRole('link', { name: `Open ${FAILING}` })).toBeVisible();
        await expect(incidents.getByRole('link', { name: `${APP} app` })).toHaveAttribute('href', `/apps/${APP}`);
        await expect(page.getByRole('list', { name: 'Deployed apps' }).getByRole('link', { name: APP, exact: true })).toBeVisible();

        const label = `Overview (${theme}, ${width})`;
        const { blocking } = await axeViolations(page);
        expect(blocking, `${label}:\n  ${blocking.join('\n  ')}`).toEqual([]);
        const { overflow, culprits } = await sidewaysScroll(page);
        expect(overflow, `${label} scrolls sideways:\n  ${culprits.join('\n  ')}`).toBeLessThanOrEqual(0);
        const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(widths.scroll).toBe(widths.client);
        if (width === 'phone') await expectPhoneFit(page, label);
      });
    });
  }
}

test.describe('at 1440 px', () => {
  test.use({ viewport: DESKTOP });

  test('shows tiles and chips, and the banner opens the failing container on Host', async ({ page }) => {
    await openOverview(page);
    await expect(page.getByText(/^This host · \d+ containers · agent \d+ (s|min) ago$/)).toBeVisible();

    const tiles = page.getByRole('list', { name: 'Deployed apps' });
    const tile = tiles.getByRole('listitem').filter({ has: page.getByRole('link', { name: APP, exact: true }) });
    await expect(tile).toHaveAttribute('data-failing', 'true');
    await expect(tile).toContainText('Unhealthy');

    const chips = page.getByRole('list', { name: 'Other compose projects' });
    await expect(chips).toBeVisible();
    await expect(chips.getByRole('listitem').filter({ hasText: OVERVIEW_FIXTURE.operatedProject })).toContainText('Operated');
    await expect(chips.getByRole('listitem').filter({ hasText: OVERVIEW_FIXTURE.observedProject })).toContainText('Observed');

    await page.getByRole('group', { name: 'Incidents' }).getByRole('link', { name: `Open ${FAILING}` }).click();
    await expect(page).toHaveURL(new RegExp(`/host\\?container=${seededContainerId(FAILING)}$`));
    await expect(page.getByRole('dialog', { name: FAILING })).toBeVisible();
  });

  test('has no banner once nothing is failing', async ({ page }) => {
    await withDb((db) => clearFailingContainers(db, fixture().agentId));
    await openOverview(page);
    await expect(page.getByRole('group', { name: 'Incidents' })).toHaveCount(0);
    const tile = page.getByRole('list', { name: 'Deployed apps' }).getByRole('listitem').filter({ has: page.getByRole('link', { name: APP, exact: true }) });
    await expect(tile).not.toHaveAttribute('data-failing', 'true');
  });
});

test.describe('at 390 px', () => {
  test.use(PHONE);

  test('the quiet chips fold into one line, and the banner opens the container sheet', async ({ page }) => {
    await openOverview(page);
    await expect(page.getByRole('list', { name: 'Other compose projects' })).toBeHidden();
    await expect(page.getByText(/^1 operated and 1 observed stacks, /)).toBeVisible();

    await page.getByRole('group', { name: 'Incidents' }).getByRole('link', { name: `Open ${FAILING}` }).click();
    await expect(page.getByRole('dialog', { name: FAILING })).toBeVisible();
    await expectPhoneFit(page, 'Overview → container sheet (390 px)');
  });
});
