import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  createTestBranch,
  deleteTestBranch,
  getTestRepo,
  getTestToken,
  loadWorkspace,
} from './github-fixture'

const repo = getTestRepo()
const token = getTestToken()
let branchName = ''

async function waitForWorkspaceCommit(page: Page, action: () => Promise<void>) {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes('/contents/conlab.json') &&
        response.ok(),
      { timeout: 30_000 },
    ),
    action(),
  ])
}

function eventCard(page: Page, eventId: string) {
  return page.locator('.event-card').filter({ hasText: eventId })
}

function renderedBucket(page: Page) {
  return page.getByLabel('Accepted text')
}

test.beforeAll(async () => {
  branchName = await createTestBranch(token, repo)
})

test.afterAll(async () => {
  if (branchName) {
    await deleteTestBranch(token, repo, branchName)
  }
})

test('runs bucket CRUD and rendered history against an isolated GitHub branch', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')

  await page.getByLabel('GitHub repo URL').fill(repo.repoUrl)
  await page.getByLabel('GitHub PAT').fill(token)
  await page.getByLabel('Branch').fill(branchName)
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Connect workspace' }).click(),
  )

  await expect(page.getByRole('heading', { name: 'Contribution Ledger' })).toBeVisible()
  await expect(page.getByText(`${repo.owner}/${repo.repo} · ${branchName}`)).toBeVisible()

  await page.getByLabel('Bucket name').fill('Problem Space')
  await page.getByLabel('Description').fill('Customer pains and market triggers for the offer.')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Create bucket' }).click(),
  )
  await expect(page.getByRole('button', { name: /Problem Space/ })).toBeVisible()

  await page.getByLabel('Add proposed content').fill('Initial accepted content for the bucket.')
  await page.getByLabel('Comment').fill('initial')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  await expect(eventCard(page, 'EV-001')).toContainText('Proposed')
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, 'EV-001').getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(eventCard(page, 'EV-001')).toContainText('Accepted')
  await expect(renderedBucket(page).getByText('Initial accepted content for the bucket.')).toBeVisible()

  await page.getByLabel('Change target').selectOption('EV-001')
  await page.getByLabel('Revise content from EV-001').fill('Revised accepted content for bucket history.')
  await page.getByLabel('Comment').fill('revision')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, 'EV-002').getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(renderedBucket(page).getByText('Revised accepted content for bucket history.')).toBeVisible()
  await expect(renderedBucket(page).getByText('Initial accepted content for the bucket.')).not.toBeVisible()

  await page.getByLabel('Change target').selectOption('')
  await page.getByLabel('Add proposed content').fill('Rejected content should never render.')
  await page.getByLabel('Comment').fill('reject')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, 'EV-003').getByRole('button', { name: 'Reject' }).click(),
  )
  await expect(eventCard(page, 'EV-003')).toContainText('Rejected')
  await expect(renderedBucket(page).getByText('Rejected content should never render.')).not.toBeVisible()

  await page.getByLabel('Change target').selectOption('EV-002')
  await page.getByRole('radio', { name: 'Delete' }).check()
  await page.getByLabel('Comment').fill('delete')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, 'EV-004').getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(renderedBucket(page).getByText('No accepted content yet.')).toBeVisible()

  await page.getByLabel('Change target').selectOption('EV-004')
  await page.getByRole('radio', { name: 'Delete' }).check()
  await page.getByLabel('Comment').fill('restore')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, 'EV-005').getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(renderedBucket(page).getByText('Revised accepted content for bucket history.')).toBeVisible()

  await page.getByRole('button', { name: '<<' }).click()
  await expect(renderedBucket(page).getByText('No accepted content yet.')).toBeVisible()
  await page.getByRole('button', { name: '>>' }).click()
  await expect(renderedBucket(page).getByText('Revised accepted content for bucket history.')).toBeVisible()

  const workspace = await loadWorkspace(token, repo, branchName)
  expect(workspace.buckets).toHaveLength(1)
  expect(workspace.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'EV-001', action: 'Create', status: 'Accepted' }),
      expect.objectContaining({ id: 'EV-002', action: 'Revise', status: 'Accepted', baseEventId: 'EV-001' }),
      expect.objectContaining({ id: 'EV-003', action: 'Create', status: 'Rejected' }),
      expect.objectContaining({ id: 'EV-004', action: 'Delete', status: 'Accepted', baseEventId: 'EV-002' }),
      expect.objectContaining({ id: 'EV-005', action: 'Delete', status: 'Accepted', baseEventId: 'EV-004' }),
    ]),
  )
})
