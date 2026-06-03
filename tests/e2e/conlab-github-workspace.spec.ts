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
  await expect(page.locator('.busy-overlay')).not.toBeVisible()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/contents/conlab.json'),
    { timeout: 30_000 },
  )
  await action()
  const response = await responsePromise.catch(async (error: unknown) => {
    const errors = await page.locator('.error-text').allTextContents()
    throw new Error(`${error instanceof Error ? error.message : 'No commit response'}; UI errors: ${errors.join(' | ')}`)
  })
  expect(response.ok()).toBeTruthy()
  await expect(page.locator('.busy-overlay')).not.toBeVisible()
}

function eventCard(page: Page, eventId: string) {
  return page.locator('.event-card').filter({
    has: page.locator('.event-title strong', { hasText: new RegExp(`^${eventId}$`) }),
  })
}

async function latestEventId(page: Page) {
  return (await page.locator('.event-card strong').first().innerText()).trim()
}

function renderedBucket(page: Page) {
  return page.getByLabel('Accepted text')
}

function commentField(page: Page) {
  return page.getByRole('textbox', { name: 'Comment' })
}

function bucketForm(page: Page) {
  return page.locator('.bucket-form')
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
  await page.goto(`/?branch=${branchName}`)

  await page.getByLabel('Git repo URL').fill(repo.repoUrl)
  await page.getByLabel('Access token').fill(token)
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Connect workspace' }).click(),
  )

  await expect(page.getByRole('heading', { name: 'Contribution Ledger' })).toBeVisible()
  await expect(page.getByText(`GitHub · ${repo.owner}/${repo.repo} · ${branchName}`)).toBeVisible()

  await bucketForm(page).getByLabel('Bucket name').fill('Problem Space')
  await bucketForm(page).getByLabel('Description').fill('Customer pains and market triggers for the offer.')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Create bucket' }).click(),
  )
  await expect(page.getByRole('button', { name: /Problem Space/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Problem Space' })).toBeVisible()

  await page.getByLabel('Add proposed content').fill('Initial **accepted** content for the bucket.')
  await commentField(page).fill('initial _markdown_ comment')
  await expect(page.getByRole('button', { name: 'Propose content' })).toBeEnabled()
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  const createEventId = await latestEventId(page)
  await expect(eventCard(page, createEventId)).toContainText('Proposed')
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, createEventId).getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(eventCard(page, createEventId)).toContainText('Accepted')
  await expect(renderedBucket(page).getByText('Initial accepted content for the bucket.')).toBeVisible()
  await expect(renderedBucket(page).locator('strong', { hasText: 'accepted' })).toBeVisible()

  await page.getByLabel('Change target').selectOption(createEventId)
  await page.getByLabel(`Revise content from ${createEventId}`).fill('Revised accepted content for bucket history.')
  await commentField(page).fill('revision')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  const reviseEventId = await latestEventId(page)
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, reviseEventId).getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(renderedBucket(page).getByText('Revised accepted content for bucket history.')).toBeVisible()
  await expect(renderedBucket(page).getByText('Initial accepted content for the bucket.')).not.toBeVisible()

  await page.getByLabel('Change target').selectOption('')
  await page.getByLabel('Add proposed content').fill('Rejected content should never render.')
  await commentField(page).fill('reject')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  const rejectedEventId = await latestEventId(page)
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, rejectedEventId).getByRole('button', { name: 'Reject' }).click(),
  )
  await expect(eventCard(page, rejectedEventId)).toContainText('Rejected')
  await expect(renderedBucket(page).getByText('Rejected content should never render.')).not.toBeVisible()

  await page.getByLabel('Change target').selectOption(reviseEventId)
  await page.getByRole('radio', { name: 'Delete' }).check()
  await commentField(page).fill('delete')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  const deleteEventId = await latestEventId(page)
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, deleteEventId).getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(renderedBucket(page).getByText('No accepted content yet.')).toBeVisible()

  await page.getByLabel('Change target').selectOption(deleteEventId)
  await page.getByRole('radio', { name: 'Delete' }).check()
  await commentField(page).fill('restore')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  const restoreEventId = await latestEventId(page)
  await waitForWorkspaceCommit(page, () =>
    eventCard(page, restoreEventId).getByRole('button', { name: 'Accept' }).click(),
  )
  await expect(renderedBucket(page).getByText('Revised accepted content for bucket history.')).toBeVisible()

  await page.getByRole('button', { name: '<<' }).click()
  await expect(renderedBucket(page).getByText('No accepted content yet.')).toBeVisible()
  await page.getByRole('button', { name: '>>' }).click()
  await expect(renderedBucket(page).getByText('Revised accepted content for bucket history.')).toBeVisible()

  await bucketForm(page).getByLabel('Bucket name').fill('Auto Space')
  await bucketForm(page).getByLabel('Description').fill('Automatically accepted content stream.')
  await bucketForm(page).getByLabel('Require reviewer acceptance for content').uncheck()
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Create bucket' }).click(),
  )
  await expect(page.getByRole('heading', { name: 'Auto Space' })).toBeVisible()
  await page.getByLabel('Add proposed content').fill('Automatically accepted block for the bucket.')
  await commentField(page).fill('auto accept')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Propose content' }).click(),
  )
  const autoEventId = await latestEventId(page)
  await expect(eventCard(page, autoEventId)).toContainText('Accepted')
  await expect(renderedBucket(page).getByText('Automatically accepted block for the bucket.')).toBeVisible()

  await page.getByRole('radio', { name: 'Question' }).check()
  await page.getByLabel('Question context').selectOption(autoEventId)
  await page.getByLabel(`Ask question about ${autoEventId}`).fill('Why are we doing this?')
  await commentField(page).fill('question')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Ask question' }).click(),
  )
  const questionEventId = await latestEventId(page)
  await expect(eventCard(page, questionEventId)).toContainText('Open')
  await expect(renderedBucket(page).getByText('Why are we doing this?')).not.toBeVisible()

  await page.getByLabel(`Decision for ${questionEventId}`).fill('Because this bucket needs a recorded rationale.')
  await commentField(page).fill('decision')
  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Add decision' }).click(),
  )
  const decisionEventId = await latestEventId(page)
  await expect(eventCard(page, decisionEventId)).toContainText('Accepted')
  await expect(eventCard(page, questionEventId)).toContainText('Resolved')
  await expect(renderedBucket(page).getByText('Because this bucket needs a recorded rationale.')).toBeVisible()

  await waitForWorkspaceCommit(page, () =>
    page.getByRole('button', { name: 'Archive bucket' }).click(),
  )
  await expect(page.getByRole('heading', { name: /^archived_Auto_Space_\d{14}$/ })).toBeVisible()

  const workspace = await loadWorkspace(token, repo, branchName)
  expect(workspace.buckets).toHaveLength(2)
  expect(workspace.buckets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/^archived_Auto_Space_\d{14}$/), status: 'archived', requiresReview: false }),
    ]),
  )
  expect(workspace.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: createEventId, action: 'Create', status: 'Accepted' }),
      expect.objectContaining({ id: reviseEventId, action: 'Revise', status: 'Accepted', baseEventId: createEventId }),
      expect.objectContaining({ id: rejectedEventId, action: 'Create', status: 'Rejected' }),
      expect.objectContaining({ id: deleteEventId, action: 'Delete', status: 'Accepted', baseEventId: reviseEventId }),
      expect.objectContaining({ id: restoreEventId, action: 'Delete', status: 'Accepted', baseEventId: deleteEventId }),
      expect.objectContaining({ id: autoEventId, action: 'Create', status: 'Accepted' }),
      expect.objectContaining({ id: questionEventId, kind: 'Question', status: 'Resolved', baseEventId: autoEventId }),
      expect.objectContaining({ id: decisionEventId, kind: 'Decision', status: 'Accepted', baseEventId: questionEventId }),
    ]),
  )
})
