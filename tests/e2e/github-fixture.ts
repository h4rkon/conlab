import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type TestRepo = {
  owner: string
  repo: string
  repoUrl: string
}

const DEFAULT_REPO_URL = 'https://github.com/h4rkon/conlab'

export function getTestRepo(): TestRepo {
  const repoUrl = process.env.TEST_GITHUB_REPO ?? DEFAULT_REPO_URL
  const parsedUrl = new URL(repoUrl)
  const [owner, repo] = parsedUrl.pathname.split('/').filter(Boolean)

  if (!owner || !repo) {
    throw new Error(`Invalid TEST_GITHUB_REPO: ${repoUrl}`)
  }

  return {
    owner,
    repo,
    repoUrl: `https://github.com/${owner}/${repo}`,
  }
}

export function getTestToken() {
  if (process.env.TEST_GITHUB_TOKEN) {
    return process.env.TEST_GITHUB_TOKEN.trim()
  }

  for (const candidate of ['.secret/pat', '.secret/conlab_multicloud']) {
    const tokenPath = resolve(candidate)

    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, 'utf8').trim()
    }
  }

  throw new Error('Set TEST_GITHUB_TOKEN or create an ignored .secret/pat file.')
}

export async function githubRequest<T>(
  token: string,
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const details = await response.json().catch(() => undefined)
    const message = typeof details?.message === 'string' ? details.message : response.statusText
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export async function createTestBranch(token: string, repo: TestRepo) {
  const branchName = `conlab-ui-test-${Date.now()}`
  const repository = await githubRequest<{ default_branch: string }>(
    token,
    `/repos/${repo.owner}/${repo.repo}`,
  )
  const baseRef = await githubRequest<{ object: { sha: string } }>(
    token,
    `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${repository.default_branch}`,
  )

  await githubRequest(
    token,
    `/repos/${repo.owner}/${repo.repo}/git/refs`,
    {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: baseRef.object.sha,
      }),
    },
  )

  return branchName
}

export async function deleteTestBranch(token: string, repo: TestRepo, branchName: string) {
  await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/refs/heads/${branchName}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
}

export async function loadWorkspace(token: string, repo: TestRepo, branchName: string) {
  const file = await githubRequest<{ content: string }>(
    token,
    `/repos/${repo.owner}/${repo.repo}/contents/conlab.json?ref=${branchName}`,
  )
  const jsonText = Buffer.from(file.content, 'base64').toString('utf8')

  return JSON.parse(jsonText) as {
    buckets: unknown[]
    events: Array<{ id: string; action: string; status: string; baseEventId?: string }>
  }
}
