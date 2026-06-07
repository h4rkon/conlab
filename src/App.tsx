import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type BucketType = 'content' | 'prompt'

type Bucket = {
  id: string
  name: string
  description: string
  type: BucketType
  requiresReview: boolean
  status: 'active' | 'archived'
  archivedAt?: string
}

type Workspace = {
  version: 1
  buckets: Bucket[]
  events: ContentEvent[]
}

type GitProvider = 'github' | 'gitlab'
type ConlabRole = 'read-only' | 'contributor' | 'reviewer' | 'admin'

type GitUser = {
  id: string
  username: string
  name: string
}

type GitAccess = {
  user: GitUser
  providerRole: string
  conlabRole: ConlabRole
}

type GitHubRepo = {
  owner: string
  repo: string
}

type GitConnectionBase = {
  provider: GitProvider
  repoUrl: string
  token: string
  branch: string
  displayName: string
  access?: GitAccess
  useBranchInCommits: boolean
}

type GitHubConnection = GitConnectionBase &
  GitHubRepo & {
    provider: 'github'
  }

type GitLabConnection = GitConnectionBase & {
  provider: 'gitlab'
  apiBaseUrl: string
  projectPath: string
}

type GitConnection = GitHubConnection | GitLabConnection

type ParsedGitHubRepo = GitHubRepo & {
  provider: 'github'
  repoUrl: string
  displayName: string
}

type ParsedGitLabRepo = {
  provider: 'gitlab'
  apiBaseUrl: string
  displayName: string
  projectPath: string
  repoUrl: string
}

type ParsedGitRepo = ParsedGitHubRepo | ParsedGitLabRepo

type LoadedWorkspace = {
  workspace: Workspace
  sha?: string
}

type WorkspaceUpdateNotification = {
  loaded: LoadedWorkspace
  summary: string
}

type GenAISettings = {
  endpoint: string
  model: string
  apiKey: string
}

type GenAICheckResult = {
  ready_to_post: boolean
  confidence: 'high' | 'medium' | 'low' | string
  single_statement: {
    ok: boolean
    assessment: string
  }
  overlap: {
    has_overlap: boolean
    assessment: string
    similar_events: string[]
  }
  contradictions: string[]
  rewrite_suggestions: string[]
  concise_rewrite: string
  overall_assessment: string
}

type PendingContribution = {
  contentEvent: ContentEvent
  eventKind: EventKind
}

type NarrativeSource = {
  bucketName: string
  content: string
}

type EventKind = 'Content' | 'Question' | 'Decision' | 'Comment'
type EventAction = 'Create' | 'Revise' | 'Delete'
type EventStatus = 'Proposed' | 'Accepted' | 'Rejected' | 'Open' | 'Resolved'

type ContentEvent = {
  id: string
  bucketId: string
  author: string
  body: string
  comment: string
  kind?: EventKind
  action: EventAction
  baseEventId?: string
  status: EventStatus
  createdAt: string
  decidedAt?: string
}

const WORKSPACE_FILE = 'conlab.json'
const CONNECTION_STORAGE_KEY = 'conlab.gitConnection'
const LEGACY_CONNECTION_STORAGE_KEY = 'conlab.githubConnection'
const GENAI_STORAGE_KEY = 'conlab.genaiSettings'
const DEFAULT_GENAI_ENDPOINT = 'https://ai-proxy.lab.epam.com'
const DEFAULT_GENAI_MODEL = 'gpt-4.1-mini-2025-04-14'

const emptyWorkspace: Workspace = {
  version: 1,
  buckets: [],
  events: [],
}

function normalizeWorkspace(workspace?: Partial<Workspace>): Workspace {
  return {
    version: 1,
    buckets: (workspace?.buckets ?? []).map((bucket) => ({
      ...bucket,
      type: bucket.type ?? 'content',
      requiresReview: bucket.requiresReview ?? true,
      status: bucket.status ?? 'active',
    })),
    events: [...(workspace?.events ?? [])],
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function truncate(value: string, maxLength = 80) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value
}

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value)
}

function parseGitRepoUrl(repoUrl: string): ParsedGitRepo {
  const normalizedUrl = repoUrl.trim().replace(/\.git$/, '')
  const parsedUrl = new URL(normalizedUrl)
  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean)

  if (parsedUrl.hostname === 'github.com') {
    const [owner, repo] = pathSegments

    if (!owner || !repo) {
      throw new Error('Use a GitHub repo URL like https://github.com/owner/repo')
    }

    return {
      provider: 'github',
      owner,
      repo,
      displayName: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
    }
  }

  if (pathSegments.length < 2) {
    throw new Error('Use a GitLab repo URL like https://git.example.com/group/project')
  }

  const projectPath = pathSegments.join('/')

  return {
    provider: 'gitlab',
    apiBaseUrl: `${parsedUrl.origin}/api/v4`,
    displayName: projectPath,
    projectPath,
    repoUrl: `${parsedUrl.origin}/${projectPath}`,
  }
}

function getApiErrorMessage(provider: 'GitHub' | 'GitLab', response: Response, details: unknown) {
  const detailRecord = details && typeof details === 'object' ? details as Record<string, unknown> : undefined
  const message = detailRecord?.message
  const errorDescription = detailRecord?.error_description
  const error = detailRecord?.error
  const readableDetail =
    typeof errorDescription === 'string'
      ? errorDescription
      : typeof message === 'string'
        ? message
        : typeof error === 'string'
          ? error
          : message && typeof message === 'object'
            ? JSON.stringify(message)
            : response.statusText || 'Request failed'

  return `${provider} API error ${response.status}: ${readableDetail}`
}

async function gitHubRequest<T>(connection: GitHubConnection, path: string, init?: RequestInit) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${connection.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const details = await response.json().catch(() => undefined)
    throw new Error(getApiErrorMessage('GitHub', response, details))
  }

  return response.json() as Promise<T>
}

async function gitLabRequest<T>(connection: GitLabConnection, path: string, init?: RequestInit) {
  const response = await fetch(`${connection.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': connection.token,
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const details = await response.json().catch(() => undefined)
    throw new Error(getApiErrorMessage('GitLab', response, details))
  }

  return response.json() as Promise<T>
}

async function getDefaultBranch(connection: ParsedGitRepo & { token: string }) {
  if (connection.provider === 'github') {
    const repo = await gitHubRequest<{ default_branch?: string }>(
      { ...connection, branch: 'main', useBranchInCommits: false },
      `/repos/${connection.owner}/${connection.repo}`,
    )

    return repo.default_branch || 'main'
  }

  const project = await gitLabRequest<{ default_branch?: string | null }>(
    { ...connection, branch: 'main', useBranchInCommits: false },
    `/projects/${encodePathSegment(connection.projectPath)}`,
  )

  return project.default_branch || 'main'
}

function getDisplayUserName(user: GitUser) {
  return user.name || user.username
}

function normalizeTokenInput(value: string) {
  const tokenLines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  return tokenLines.at(-1) ?? value.trim()
}

function mapGitHubAccess(permissions?: {
  admin?: boolean
  maintain?: boolean
  push?: boolean
  triage?: boolean
  pull?: boolean
}) {
  if (permissions?.admin) {
    return { providerRole: 'admin', conlabRole: 'admin' as const }
  }

  if (permissions?.maintain) {
    return { providerRole: 'maintain', conlabRole: 'reviewer' as const }
  }

  if (permissions?.push) {
    return { providerRole: 'push', conlabRole: 'contributor' as const }
  }

  if (permissions?.triage) {
    return { providerRole: 'triage', conlabRole: 'read-only' as const }
  }

  return { providerRole: permissions?.pull ? 'pull' : 'none', conlabRole: 'read-only' as const }
}

function mapGitLabAccess(accessLevel?: number) {
  if (typeof accessLevel !== 'number') {
    return { providerRole: 'none', conlabRole: 'read-only' as const }
  }

  if (accessLevel >= 50) {
    return { providerRole: 'owner', conlabRole: 'admin' as const }
  }

  if (accessLevel >= 40) {
    return { providerRole: 'maintainer', conlabRole: 'reviewer' as const }
  }

  if (accessLevel >= 30) {
    return { providerRole: 'developer', conlabRole: 'contributor' as const }
  }

  if (accessLevel >= 20) {
    return { providerRole: 'reporter', conlabRole: 'read-only' as const }
  }

  if (accessLevel >= 10) {
    return { providerRole: 'guest', conlabRole: 'read-only' as const }
  }

  return { providerRole: 'minimal', conlabRole: 'read-only' as const }
}

async function loadGitAccess(connection: GitConnection): Promise<GitAccess> {
  if (connection.provider === 'github') {
    const [user, repo] = await Promise.all([
      gitHubRequest<{ id: number; login: string; name?: string | null }>(connection, '/user'),
      gitHubRequest<{
        permissions?: {
          admin?: boolean
          maintain?: boolean
          push?: boolean
          triage?: boolean
          pull?: boolean
        }
      }>(connection, `/repos/${connection.owner}/${connection.repo}`),
    ])
    const mappedAccess = mapGitHubAccess(repo.permissions)

    return {
      user: {
        id: String(user.id),
        username: user.login,
        name: user.name || user.login,
      },
      ...mappedAccess,
    }
  }

  const user = await gitLabRequest<{ id: number; username: string; name?: string | null }>(
    connection,
    '/user',
  )
  const member = await gitLabRequest<{ access_level?: number }>(
    connection,
    `/projects/${encodePathSegment(connection.projectPath)}/members/all/${encodePathSegment(String(user.id))}`,
  )
  const mappedAccess = mapGitLabAccess(member.access_level)

  return {
    user: {
      id: String(user.id),
      username: user.username,
      name: user.name || user.username,
    },
    ...mappedAccess,
  }
}

async function loadWorkspaceFile(connection: GitConnection) {
  if (connection.provider === 'github') {
    const file = await gitHubRequest<{ content: string; sha: string }>(
      connection,
      `/repos/${connection.owner}/${connection.repo}/contents/${WORKSPACE_FILE}?ref=${encodePathSegment(connection.branch)}`,
    )

    return {
      workspace: JSON.parse(decodeBase64(file.content)) as Workspace,
      sha: file.sha,
    }
  }

  const file = await gitLabRequest<{ content: string; last_commit_id?: string }>(
    connection,
    `/projects/${encodePathSegment(connection.projectPath)}/repository/files/${encodePathSegment(WORKSPACE_FILE)}?ref=${encodePathSegment(connection.branch)}`,
  )

  return {
    workspace: JSON.parse(decodeBase64(file.content)) as Workspace,
    sha: file.last_commit_id,
  }
}

async function commitWorkspaceFile(
  connection: GitConnection,
  workspace: Workspace,
  message: string,
  sha?: string,
) {
  if (connection.provider === 'gitlab') {
    const body: {
      branch: string
      commit_message: string
      content: string
      encoding: 'base64'
      last_commit_id?: string
    } = {
      branch: connection.branch,
      commit_message: message,
      content: encodeBase64(`${JSON.stringify(workspace, null, 2)}\n`),
      encoding: 'base64',
    }

    if (sha) {
      body.last_commit_id = sha
    }

    const result = await gitLabRequest<{ last_commit_id?: string; commit_id?: string }>(
      connection,
      `/projects/${encodePathSegment(connection.projectPath)}/repository/files/${encodePathSegment(WORKSPACE_FILE)}`,
      {
        method: sha ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      },
    )

    return result.last_commit_id ?? result.commit_id
  }

  const body: {
    message: string
    content: string
    branch?: string
    sha?: string
  } = {
    message,
    content: encodeBase64(`${JSON.stringify(workspace, null, 2)}\n`),
  }

  if (connection.useBranchInCommits) {
    body.branch = connection.branch
  }

  if (sha) {
    body.sha = sha
  }

  const result = await gitHubRequest<{ content?: { sha?: string } }>(
    connection,
    `/repos/${connection.owner}/${connection.repo}/contents/${WORKSPACE_FILE}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  )

  return result.content?.sha
}

async function loadOrInitializeWorkspace(connection: GitConnection) {
  try {
    return await loadWorkspaceFile(connection)
  } catch (error) {
    if (!shouldInitializeWorkspace(error)) {
      throw error
    }

    const createdSha = await commitWorkspaceFile(
      connection,
      emptyWorkspace,
      'Initialize Conlab workspace',
    )

    return {
      workspace: emptyWorkspace,
      sha: createdSha,
    }
  }
}

function shouldInitializeWorkspace(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message === 'Not Found' ||
    error.message === 'This repository is empty.' ||
    error.message.includes('API error 404') ||
    error.message.includes('404 File Not Found')
  )
}

function getStoredConnection() {
  const storedConnection =
    localStorage.getItem(CONNECTION_STORAGE_KEY) ??
    localStorage.getItem(LEGACY_CONNECTION_STORAGE_KEY)

  if (!storedConnection) {
    return undefined
  }

  try {
    const parsedConnection = JSON.parse(storedConnection) as Partial<GitConnection> &
      Partial<GitHubConnection>

    if (parsedConnection.provider) {
      return parsedConnection as GitConnection
    }

    if (parsedConnection.owner && parsedConnection.repo && parsedConnection.repoUrl && parsedConnection.token) {
      return {
        ...parsedConnection,
        provider: 'github',
        branch: parsedConnection.branch ?? 'main',
        displayName: `${parsedConnection.owner}/${parsedConnection.repo}`,
        useBranchInCommits: Boolean(parsedConnection.useBranchInCommits),
      } as GitConnection
    }

    return undefined
  } catch {
    localStorage.removeItem(CONNECTION_STORAGE_KEY)
    localStorage.removeItem(LEGACY_CONNECTION_STORAGE_KEY)
    return undefined
  }
}

function getStoredGenAISettings(): GenAISettings {
  const defaults = {
    endpoint: DEFAULT_GENAI_ENDPOINT,
    model: DEFAULT_GENAI_MODEL,
    apiKey: '',
  }
  const storedSettings = localStorage.getItem(GENAI_STORAGE_KEY)

  if (!storedSettings) {
    return defaults
  }

  try {
    const parsedSettings = JSON.parse(storedSettings) as Partial<GenAISettings>

    return {
      endpoint: parsedSettings.endpoint?.trim() || defaults.endpoint,
      model: parsedSettings.model?.trim() || defaults.model,
      apiKey: parsedSettings.apiKey?.trim() || '',
    }
  } catch {
    localStorage.removeItem(GENAI_STORAGE_KEY)
    return defaults
  }
}

function storeGenAISettings(settings: GenAISettings) {
  localStorage.setItem(GENAI_STORAGE_KEY, JSON.stringify({
    endpoint: settings.endpoint.trim() || DEFAULT_GENAI_ENDPOINT,
    model: settings.model.trim() || DEFAULT_GENAI_MODEL,
    apiKey: settings.apiKey.trim(),
  }))
}

function shouldRetryCommitConflict(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()

  return (
    message.includes('sha') ||
    message.includes('last_commit_id') ||
    message.includes('changed since') ||
    message.includes('branch was updated')
  )
}

function getEventAction(event: ContentEvent): EventAction {
  return event.action ?? (event.baseEventId ? 'Revise' : 'Create')
}

function getEventKind(event: ContentEvent): EventKind {
  return event.kind ?? 'Content'
}

function getRootEventId(event: ContentEvent, eventsById: Map<string, ContentEvent>) {
  let rootId = event.baseEventId ?? event.id
  let current = event.baseEventId ? eventsById.get(event.baseEventId) : event
  const seen = new Set<string>([event.id])

  while (current?.baseEventId && !seen.has(current.baseEventId)) {
    seen.add(current.id)
    rootId = current.baseEventId
    current = eventsById.get(current.baseEventId)
  }

  return rootId
}

function getAcceptedEventsAtLimit(
  eventsInDisplayOrder: ContentEvent[],
  acceptedEventLimit?: number,
) {
  const chronologicalEvents = [...eventsInDisplayOrder].reverse()
  const acceptedEvents = chronologicalEvents.filter(
    (event) => event.status === 'Accepted' && getEventKind(event) !== 'Question' && getEventKind(event) !== 'Comment',
  )

  if (typeof acceptedEventLimit !== 'number') {
    return acceptedEvents
  }

  return acceptedEvents.slice(0, acceptedEventLimit)
}

function isEventInvalidated(
  eventId: string,
  acceptedEvents: ContentEvent[],
  memo = new Map<string, boolean>(),
  visiting = new Set<string>(),
): boolean {
  const memoized = memo.get(eventId)

  if (typeof memoized === 'boolean') {
    return memoized
  }

  if (visiting.has(eventId)) {
    return false
  }

  visiting.add(eventId)

  const invalidated = acceptedEvents.some(
    (event) =>
      getEventAction(event) === 'Delete' &&
      event.baseEventId === eventId &&
      !isEventInvalidated(event.id, acceptedEvents, memo, visiting),
  )

  visiting.delete(eventId)
  memo.set(eventId, invalidated)
  return invalidated
}

function getActiveAcceptedEvents(eventsInDisplayOrder: ContentEvent[], acceptedEventLimit?: number) {
  const acceptedEvents = getAcceptedEventsAtLimit(eventsInDisplayOrder, acceptedEventLimit)
  const memo = new Map<string, boolean>()

  return acceptedEvents.filter((event) => !isEventInvalidated(event.id, acceptedEvents, memo))
}

function getRenderedEvents(eventsInDisplayOrder: ContentEvent[], acceptedEventLimit?: number) {
  const activeAcceptedEvents = getActiveAcceptedEvents(eventsInDisplayOrder, acceptedEventLimit)
  const eventsById = new Map(eventsInDisplayOrder.map((event) => [event.id, event]))
  const renderedByRoot = new Map<string, ContentEvent>()
  const renderedRootOrder: string[] = []

  for (const event of activeAcceptedEvents) {
    const rootId = getRootEventId(event, eventsById)

    if (!renderedRootOrder.includes(rootId)) {
      renderedRootOrder.push(rootId)
    }

    if (getEventAction(event) === 'Delete') {
      const targetEvent = event.baseEventId ? eventsById.get(event.baseEventId) : undefined

      if (targetEvent && getEventAction(targetEvent) === 'Delete') {
        continue
      }

      renderedByRoot.delete(rootId)
      continue
    }

    renderedByRoot.set(rootId, event)
  }

  return renderedRootOrder
    .map((rootId) => renderedByRoot.get(rootId))
    .filter((event): event is ContentEvent => Boolean(event))
}

function countAcceptedEvents(events: ContentEvent[], bucketId: string) {
  return events.filter((event) => event.bucketId === bucketId && event.status === 'Accepted').length
}

function generateEventId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)

  return `EV-${timestamp}-${random}`
}

function generateBucketId(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

  return `${slug}-${timestamp}`
}

function getFileSlug(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  return slug || 'bucket'
}

function getTimestampLabel() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function getArchivedBucketName(name: string) {
  const safeName = name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '_')

  return `archived_${safeName}_${getTimestampLabel()}`
}

function getBranchOverride() {
  return new URLSearchParams(window.location.search).get('branch')?.trim() ?? ''
}

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

function includesKnownWorkspace(latest: Workspace, known: Workspace) {
  const bucketIds = new Set(latest.buckets.map((bucket) => bucket.id))
  const eventIds = new Set(latest.events.map((event) => event.id))

  return (
    known.buckets.every((bucket) => bucketIds.has(bucket.id)) &&
    known.events.every((event) => eventIds.has(event.id))
  )
}

function summarizeWorkspaceUpdate(latest: Workspace, current: Workspace) {
  const currentEventIds = new Set(current.events.map((event) => event.id))
  const latestEvent = latest.events.find((event) => !currentEventIds.has(event.id)) ?? latest.events[0]

  if (latestEvent) {
    return `${latestEvent.author} added ${getEventKind(latestEvent).toLowerCase()} ${latestEvent.id} (${latestEvent.status})`
  }

  if (latest.buckets.length !== current.buckets.length) {
    return `Bucket list changed (${latest.buckets.length} buckets)`
  }

  return 'Workspace settings changed'
}

function getEventKindLabel(kind: EventKind) {
  return kind.toLowerCase()
}

function buildVisibleContentContext(events: ContentEvent[]) {
  if (!events.length) {
    return 'No visible rendered content exists in this bucket yet.'
  }

  return events
    .map((event, index) => [
      `Visible block ${index + 1}`,
      `ID: ${event.id}`,
      `Kind: ${getEventKind(event)}`,
      `Action: ${getEventAction(event)}`,
      `Status: ${event.status}`,
      `Base event: ${event.baseEventId ?? 'none'}`,
      `Body:\n${event.body}`,
      `Comment:\n${event.comment}`,
    ].join('\n'))
    .join('\n\n---\n\n')
}

function buildPlausibilityPrompt(
  bucket: Bucket,
  visibleEvents: ContentEvent[],
  selectedTargetEvent: ContentEvent | undefined,
  contribution: ContentEvent,
) {
  const visibleContentContext = buildVisibleContentContext(visibleEvents)
  const targetText = selectedTargetEvent
    ? `Target event ${selectedTargetEvent.id} (${getEventKind(selectedTargetEvent)}, ${getEventAction(selectedTargetEvent)}):\n${selectedTargetEvent.body}`
    : 'No specific target event.'

  return `
You are reviewing one proposed Conlab ${getEventKindLabel(getEventKind(contribution))} contribution before it is posted.

Conlab is a controlled collaboration text editor. Contributions must be small, reviewable event log entries. The desired style is: one contribution, one clear statement, accept or reject, then proceed.

Evaluate exactly these three things:
1. Single-statement discipline: decide whether the new content contains mainly one clear statement. Reject or warn if it tries to insert a long section, a broad essay, a list of many arguments, or multiple independent claims.
2. Overlap with current visible bucket content: compare the new content only against the visible rendered content below. Do not treat deleted, invalidated, superseded, rejected, or non-rendered historical entries as overlap unless their content is still visible below. Detect semantic overlap, near-duplicates, or rephrased repetition. Similar wording is not required. Example: "compliance drives digital sovereignty" overlaps with "regulation and compliance are key requirements sources for digital sovereignty" only if that prior idea is still visible in the current rendered content.
3. Rewrite quality: propose shorter, crisper, less flowery wording. Prefer direct language and one useful statement.

Return only valid JSON with this exact shape:
{
  "ready_to_post": true,
  "confidence": "high | medium | low",
  "single_statement": {
    "ok": true,
    "assessment": ""
  },
  "overlap": {
    "has_overlap": false,
    "assessment": "",
    "similar_events": []
  },
  "contradictions": [],
  "rewrite_suggestions": [],
  "concise_rewrite": "",
  "overall_assessment": ""
}

Use ready_to_post=false when the contribution is too broad, too long, highly overlapping, contradictory, or not useful as a small controlled event.

Bucket:
${bucket.name}

Bucket description:
${bucket.description}

Current visible rendered bucket content:
${visibleContentContext}

Selected target/context:
${targetText}

New contribution:
Kind: ${getEventKind(contribution)}
Action: ${getEventAction(contribution)}
Body:
${contribution.body}

Contributor comment:
${contribution.comment}
`.trim()
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeGenAIResult(value: unknown): GenAICheckResult {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const singleStatement = result.single_statement && typeof result.single_statement === 'object'
    ? result.single_statement as Record<string, unknown>
    : {}
  const overlap = result.overlap && typeof result.overlap === 'object'
    ? result.overlap as Record<string, unknown>
    : {}

  return {
    ready_to_post: Boolean(result.ready_to_post),
    confidence: typeof result.confidence === 'string' ? result.confidence : 'low',
    single_statement: {
      ok: Boolean(singleStatement.ok),
      assessment: typeof singleStatement.assessment === 'string' ? singleStatement.assessment : '',
    },
    overlap: {
      has_overlap: Boolean(overlap.has_overlap),
      assessment: typeof overlap.assessment === 'string' ? overlap.assessment : '',
      similar_events: normalizeStringArray(overlap.similar_events),
    },
    contradictions: normalizeStringArray(result.contradictions),
    rewrite_suggestions: normalizeStringArray(result.rewrite_suggestions),
    concise_rewrite: typeof result.concise_rewrite === 'string' ? result.concise_rewrite : '',
    overall_assessment: typeof result.overall_assessment === 'string' ? result.overall_assessment : '',
  }
}

async function runGenAIPlausibilityCheck(
  settings: GenAISettings,
  bucket: Bucket,
  visibleEvents: ContentEvent[],
  selectedTargetEvent: ContentEvent | undefined,
  contribution: ContentEvent,
) {
  const endpoint = settings.endpoint.trim().replace(/\/$/, '') || DEFAULT_GENAI_ENDPOINT
  const model = settings.model.trim() || DEFAULT_GENAI_MODEL
  const apiKey = settings.apiKey.trim()

  if (!apiKey) {
    throw new Error('Enter a GenAI API key before checking.')
  }

  const response = await fetch(
    `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-02-01`,
    {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are a strict contribution reviewer for a controlled collaboration text editor. Return only valid JSON.',
          },
          {
            role: 'user',
            content: buildPlausibilityPrompt(bucket, visibleEvents, selectedTargetEvent, contribution),
          },
        ],
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`GenAI API error ${response.status}: ${await response.text()}`)
  }

  const data = await response.json() as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content?.trim()

  if (!content) {
    throw new Error('GenAI returned an empty response.')
  }

  try {
    return normalizeGenAIResult(JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')))
  } catch {
    throw new Error(`GenAI returned non-JSON content: ${content}`)
  }
}

function buildNarrativePrompt(promptText: string, sources: NarrativeSource[]) {
  const sourceText = sources.map((source, index) => [
    `Source bucket ${index + 1}: ${source.bucketName}`,
    source.content || 'No visible content.',
  ].join('\n')).join('\n\n---\n\n')

  return `
Use the selected prompt and selected Conlab bucket content to create one narrative.

Selected prompt:
${promptText}

Selected source bucket content in the requested order:
${sourceText}

Return only the narrative text. Do not explain the process. Do not include a preface.
`.trim()
}

async function runGenAINarrativeGeneration(
  settings: GenAISettings,
  promptText: string,
  sources: NarrativeSource[],
) {
  const endpoint = settings.endpoint.trim().replace(/\/$/, '') || DEFAULT_GENAI_ENDPOINT
  const model = settings.model.trim() || DEFAULT_GENAI_MODEL
  const apiKey = settings.apiKey.trim()

  if (!apiKey) {
    throw new Error('Enter a GenAI API key before generating a narrative.')
  }

  if (!promptText.trim()) {
    throw new Error('The selected prompt bucket has no visible prompt text.')
  }

  if (!sources.length) {
    throw new Error('Select at least one content bucket.')
  }

  const response = await fetch(
    `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-02-01`,
    {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You create concise narratives from controlled collaboration source material. Follow the selected prompt strictly.',
          },
          {
            role: 'user',
            content: buildNarrativePrompt(promptText, sources),
          },
        ],
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`GenAI API error ${response.status}: ${await response.text()}`)
  }

  const data = await response.json() as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content?.trim()

  if (!content) {
    throw new Error('GenAI returned an empty narrative.')
  }

  return content.replace(/^```(?:markdown|md|text)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function MarkdownText({ className, text }: { className?: string; text: string }) {
  return (
    <div className={className ? `markdown-text ${className}` : 'markdown-text'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function BusyOverlay({ message }: { message: string }) {
  return (
    <div aria-live="polite" aria-modal="true" className="busy-overlay" role="status">
      <div className="busy-panel">
        <span aria-hidden="true" className="busy-spinner" />
        <span>{message}</span>
      </div>
    </div>
  )
}

function App() {
  const [storedConnection] = useState(getStoredConnection)
  const [storedGenAISettings] = useState(getStoredGenAISettings)
  const [connection, setConnection] = useState<GitConnection | null>(null)
  const [repoUrl, setRepoUrl] = useState(storedConnection?.repoUrl ?? '')
  const [token, setToken] = useState(storedConnection?.token ?? '')
  const [isConnecting, setIsConnecting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [events, setEvents] = useState<ContentEvent[]>([])
  const [selectedBucketId, setSelectedBucketId] = useState('')
  const [bucketName, setBucketName] = useState('')
  const [bucketDescription, setBucketDescription] = useState('')
  const [bucketType, setBucketType] = useState<BucketType>('content')
  const [bucketRequiresReview, setBucketRequiresReview] = useState(true)
  const [bucketSettingsName, setBucketSettingsName] = useState('')
  const [bucketSettingsDescription, setBucketSettingsDescription] = useState('')
  const [bucketSettingsType, setBucketSettingsType] = useState<BucketType>('content')
  const [bucketSettingsRequiresReview, setBucketSettingsRequiresReview] = useState(true)
  const [eventKind, setEventKind] = useState<EventKind>('Content')
  const [changeAction, setChangeAction] = useState<EventAction>('Create')
  const [selectedBaseEventId, setSelectedBaseEventId] = useState('')
  const [contentBody, setContentBody] = useState('')
  const [contentComment, setContentComment] = useState('')
  const [commentTargetEventId, setCommentTargetEventId] = useState('')
  const [commentBody, setCommentBody] = useState('')
  const [historyAcceptedCount, setHistoryAcceptedCount] = useState(0)
  const [isRenderedTextOpen, setIsRenderedTextOpen] = useState(false)
  const [isEventLogOpen, setIsEventLogOpen] = useState(false)
  const [remoteUpdate, setRemoteUpdate] = useState<WorkspaceUpdateNotification | null>(null)
  const [genAIEndpoint, setGenAIEndpoint] = useState(storedGenAISettings.endpoint)
  const [genAIModel, setGenAIModel] = useState(storedGenAISettings.model)
  const [genAIKey, setGenAIKey] = useState(storedGenAISettings.apiKey)
  const [pendingContribution, setPendingContribution] = useState<PendingContribution | null>(null)
  const [genAIResult, setGenAIResult] = useState<GenAICheckResult | null>(null)
  const [genAIError, setGenAIError] = useState('')
  const [isCheckingGenAI, setIsCheckingGenAI] = useState(false)
  const [isNarrativeModalOpen, setIsNarrativeModalOpen] = useState(false)
  const [selectedPromptBucketId, setSelectedPromptBucketId] = useState('')
  const [selectedNarrativeBucketIds, setSelectedNarrativeBucketIds] = useState<string[]>([])
  const [narrativeText, setNarrativeText] = useState('')
  const [narrativeError, setNarrativeError] = useState('')
  const [isGeneratingNarrative, setIsGeneratingNarrative] = useState(false)
  const [hasCopiedNarrative, setHasCopiedNarrative] = useState(false)
  const syncedWorkspaceRef = useRef<LoadedWorkspace | null>(null)
  const notifiedShaRef = useRef<string | undefined>(undefined)

  const selectedBucket = buckets.find((bucket) => bucket.id === selectedBucketId) ?? buckets[0]

  const selectedEvents = useMemo(
    () => events.filter((event) => event.bucketId === selectedBucket?.id),
    [events, selectedBucket?.id],
  )

  const pendingEvent = selectedEvents.find((event) => event.status === 'Proposed')
  const openQuestion = selectedEvents.find((event) => getEventKind(event) === 'Question' && event.status === 'Open')
  const topLevelEvents = selectedEvents.filter((event) => getEventKind(event) !== 'Comment')
  const commentsByTargetId = new Map<string, ContentEvent[]>()

  for (const event of selectedEvents) {
    if (getEventKind(event) !== 'Comment' || !event.baseEventId) {
      continue
    }

    commentsByTargetId.set(event.baseEventId, [
      ...(commentsByTargetId.get(event.baseEventId) ?? []),
      event,
    ])
  }

  const activeDecisionQuestion = openQuestion ?? selectedEvents.find((event) => event.id === selectedBaseEventId && getEventKind(event) === 'Question')
  const activeEventKind = openQuestion ? 'Decision' : eventKind
  const acceptedTimeline = getAcceptedEventsAtLimit(selectedEvents)
  const latestAcceptedCount = acceptedTimeline.length
  const appliedAcceptedCount = Math.min(historyAcceptedCount, latestAcceptedCount)
  const renderedEvents = getRenderedEvents(selectedEvents, appliedAcceptedCount)
  const appliedEvent = appliedAcceptedCount > 0 ? acceptedTimeline[appliedAcceptedCount - 1] : undefined
  const selectedTargetEvent = selectedEvents.find((event) => event.id === selectedBaseEventId)
  const access = connection?.access
  const conlabRole = access?.conlabRole ?? 'read-only'
  const canContribute = conlabRole === 'contributor' || conlabRole === 'reviewer' || conlabRole === 'admin'
  const canReview = conlabRole === 'reviewer' || conlabRole === 'admin'
  const canAdmin = conlabRole === 'admin'
  const selectedBucketIsActive = selectedBucket?.status !== 'archived'
  const eventAuthor = access ? getDisplayUserName(access.user) : 'Unknown user'
  const promptBuckets = buckets.filter((bucket) => bucket.type === 'prompt' && bucket.status !== 'archived')
  const contentBuckets = buckets.filter((bucket) => bucket.type === 'content' && bucket.status !== 'archived')

  function syncBucketSettings(bucket?: Bucket) {
    setBucketSettingsName(bucket?.name ?? '')
    setBucketSettingsDescription(bucket?.description ?? '')
    setBucketSettingsType(bucket?.type ?? 'content')
    setBucketSettingsRequiresReview(bucket?.requiresReview ?? true)
  }

  function applyLoadedWorkspace(loaded: LoadedWorkspace, preferredBucketId = selectedBucketId) {
    const workspace = normalizeWorkspace(loaded.workspace)
    const nextBucketId = workspace.buckets.some((bucket) => bucket.id === preferredBucketId)
      ? preferredBucketId
      : workspace.buckets[0]?.id ?? ''

    syncedWorkspaceRef.current = {
      workspace,
      sha: loaded.sha,
    }
    notifiedShaRef.current = undefined
    setRemoteUpdate(null)
    setBuckets(workspace.buckets)
    setEvents(workspace.events)
    setSelectedBucketId(nextBucketId)
    setHistoryAcceptedCount(countAcceptedEvents(workspace.events, nextBucketId))
    syncBucketSettings(workspace.buckets.find((bucket) => bucket.id === nextBucketId))

    return workspace
  }

  async function loadConsistentWorkspace(activeConnection: GitConnection) {
    const cached = syncedWorkspaceRef.current
    const waits = [0, 300, 800, 1500]
    let loaded: LoadedWorkspace | undefined

    for (const wait of waits) {
      if (wait) {
        await delay(wait)
      }

      loaded = await loadOrInitializeWorkspace(activeConnection)
      const workspace = normalizeWorkspace(loaded.workspace)

      if (!cached || includesKnownWorkspace(workspace, cached.workspace)) {
        return {
          workspace,
          sha: loaded.sha,
        }
      }
    }

    if (cached && loaded) {
      return cached
    }

    return loaded ?? { workspace: emptyWorkspace }
  }

  async function connectToGitRepo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setConnectionError('')
    setSaveError('')
    setIsConnecting(true)

    try {
      const repo = parseGitRepoUrl(repoUrl)
      const requestedBranch = getBranchOverride()
      const trimmedToken = normalizeTokenInput(token)
      const branch = requestedBranch || (await getDefaultBranch({ ...repo, token: trimmedToken }))
      const baseConnection: GitConnection =
        repo.provider === 'github'
          ? {
              ...repo,
              token: trimmedToken,
              branch,
              useBranchInCommits: Boolean(requestedBranch),
            }
          : {
              ...repo,
              token: trimmedToken,
              branch,
              useBranchInCommits: Boolean(requestedBranch),
            }
      const access = await loadGitAccess(baseConnection)
      const nextConnection: GitConnection = {
        ...baseConnection,
        access,
      }

      const loaded = await loadOrInitializeWorkspace(nextConnection)
      const workspace = normalizeWorkspace(loaded.workspace)
      const firstBucketId = workspace.buckets[0]?.id ?? ''
      applyLoadedWorkspace(loaded, firstBucketId)

      setConnection(nextConnection)
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(nextConnection))
      localStorage.removeItem(LEGACY_CONNECTION_STORAGE_KEY)
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not connect to Git repo')
    } finally {
      setIsConnecting(false)
    }
  }

  useEffect(() => {
    if (!connection) {
      return undefined
    }

    let cancelled = false
    const activeConnection = connection

    async function checkForRemoteUpdate() {
      if (cancelled || isSaving || isConnecting) {
        return
      }

      const current = syncedWorkspaceRef.current

      if (!current?.sha) {
        return
      }

      try {
        const latest = await loadWorkspaceFile(activeConnection)

        if (
          latest.sha &&
          latest.sha !== current.sha &&
          latest.sha !== notifiedShaRef.current
        ) {
          const latestWorkspace = normalizeWorkspace(latest.workspace)
          notifiedShaRef.current = latest.sha
          setRemoteUpdate({
            loaded: {
              workspace: latestWorkspace,
              sha: latest.sha,
            },
            summary: summarizeWorkspaceUpdate(latestWorkspace, current.workspace),
          })
        }
      } catch {
        // Polling must not interrupt the main editing flow. Explicit saves still surface errors.
      }
    }

    void checkForRemoteUpdate()
    const intervalId = window.setInterval(checkForRemoteUpdate, 30000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [connection, isConnecting, isSaving])

  function loadRemoteUpdate() {
    if (!remoteUpdate) {
      return
    }

    applyLoadedWorkspace(remoteUpdate.loaded)
  }

  async function saveWorkspace(
    message: string,
    applyCommand: (workspace: Workspace) => Workspace,
  ) {
    if (!connection) {
      return false
    }

    setIsSaving(true)
    setSaveError('')

    let lastLoaded: LoadedWorkspace | undefined

    try {
      let committedWorkspace: LoadedWorkspace | undefined

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const latest = await loadConsistentWorkspace(connection)
        lastLoaded = latest
        const nextWorkspace = applyCommand(latest.workspace)

        try {
          const nextSha = await commitWorkspaceFile(connection, nextWorkspace, message, latest.sha)
          committedWorkspace = {
            workspace: nextWorkspace,
            sha: nextSha,
          }
          break
        } catch (error) {
          if (attempt === 0 && shouldRetryCommitConflict(error)) {
            continue
          }

          throw error
        }
      }

      if (!committedWorkspace) {
        throw new Error('Could not commit workspace update')
      }

      applyLoadedWorkspace(committedWorkspace)
      return true
    } catch (error) {
      if (lastLoaded) {
        applyLoadedWorkspace(lastLoaded)
      }

      setSaveError(error instanceof Error ? error.message : 'Could not save to Git repo')
      return false
    } finally {
      setIsSaving(false)
    }
  }

  function disconnectGitRepo() {
    localStorage.removeItem(CONNECTION_STORAGE_KEY)
    localStorage.removeItem(LEGACY_CONNECTION_STORAGE_KEY)
    setConnection(null)
    setRepoUrl('')
    setToken('')
    setBuckets([])
    setEvents([])
    setSelectedBucketId('')
    syncBucketSettings()
    syncedWorkspaceRef.current = null
  }

  function selectBucket(bucketId: string) {
    setSelectedBucketId(bucketId)
    setEventKind('Content')
    setChangeAction('Create')
    setSelectedBaseEventId('')
    setContentBody('')
    setContentComment('')
    setCommentTargetEventId('')
    setCommentBody('')
    setHistoryAcceptedCount(countAcceptedEvents(events, bucketId))
    syncBucketSettings(buckets.find((bucket) => bucket.id === bucketId))
  }

  function getCurrentGenAISettings() {
    return {
      endpoint: genAIEndpoint.trim() || DEFAULT_GENAI_ENDPOINT,
      model: genAIModel.trim() || DEFAULT_GENAI_MODEL,
      apiKey: genAIKey.trim(),
    }
  }

  function persistCurrentGenAISettings() {
    const settings = getCurrentGenAISettings()

    storeGenAISettings(settings)
    setGenAIEndpoint(settings.endpoint)
    setGenAIModel(settings.model)
    setGenAIKey(settings.apiKey)

    return settings
  }

  function closeGenAIModal() {
    if (isCheckingGenAI || isSaving) {
      return
    }

    setPendingContribution(null)
    setGenAIResult(null)
    setGenAIError('')
  }

  async function checkPendingContributionWithGenAI() {
    if (!selectedBucket || !pendingContribution) {
      return
    }

    setIsCheckingGenAI(true)
    setGenAIError('')
    setGenAIResult(null)

    try {
      const settings = persistCurrentGenAISettings()
      const result = await runGenAIPlausibilityCheck(
        settings,
        selectedBucket,
        renderedEvents,
        getTargetEvent(pendingContribution.contentEvent.baseEventId),
        pendingContribution.contentEvent,
      )

      setGenAIResult(result)
    } catch (error) {
      setGenAIError(error instanceof Error ? error.message : 'Could not run GenAI plausibility check.')
    } finally {
      setIsCheckingGenAI(false)
    }
  }

  async function postPendingContribution() {
    if (!pendingContribution) {
      return
    }

    persistCurrentGenAISettings()
    const saved = await saveContentEvent(pendingContribution.contentEvent, pendingContribution.eventKind)

    if (!saved) {
      return
    }

    setPendingContribution(null)
    setGenAIResult(null)
    setGenAIError('')
  }

  function getRenderedEventsForBucket(bucketId: string) {
    return getRenderedEvents(events.filter((event) => event.bucketId === bucketId))
  }

  function getRenderedTextForBucket(bucketId: string) {
    return getRenderedEventsForBucket(bucketId)
      .map((event) => event.body.trim())
      .filter(Boolean)
      .join('\n\n')
  }

  function openNarrativeModal() {
    const defaultPromptId = selectedPromptBucketId || promptBuckets[0]?.id || ''
    const retainedBucketIds = selectedNarrativeBucketIds.filter((bucketId) =>
      contentBuckets.some((bucket) => bucket.id === bucketId),
    )
    const defaultBucketIds = retainedBucketIds.length
      ? retainedBucketIds
      : selectedBucket?.type === 'content'
        ? [selectedBucket.id]
        : contentBuckets.map((bucket) => bucket.id)

    setSelectedPromptBucketId(defaultPromptId)
    setSelectedNarrativeBucketIds(defaultBucketIds)
    setNarrativeText('')
    setNarrativeError('')
    setHasCopiedNarrative(false)
    setIsNarrativeModalOpen(true)
  }

  function closeNarrativeModal() {
    if (isGeneratingNarrative) {
      return
    }

    setIsNarrativeModalOpen(false)
    setNarrativeError('')
    setHasCopiedNarrative(false)
  }

  function toggleNarrativeBucket(bucketId: string) {
    setSelectedNarrativeBucketIds((current) =>
      current.includes(bucketId)
        ? current.filter((selectedBucketId) => selectedBucketId !== bucketId)
        : [...current, bucketId],
    )
    setNarrativeText('')
    setHasCopiedNarrative(false)
  }

  async function generateNarrative() {
    setIsGeneratingNarrative(true)
    setNarrativeError('')
    setNarrativeText('')
    setHasCopiedNarrative(false)

    try {
      const settings = persistCurrentGenAISettings()
      const promptText = getRenderedTextForBucket(selectedPromptBucketId)
      const sources = selectedNarrativeBucketIds
        .map((bucketId) => {
          const bucket = buckets.find((candidate) => candidate.id === bucketId)

          return bucket
            ? {
                bucketName: bucket.name,
                content: getRenderedTextForBucket(bucket.id),
              }
            : undefined
        })
        .filter((source): source is NarrativeSource => Boolean(source))
      const generatedNarrative = await runGenAINarrativeGeneration(settings, promptText, sources)

      setNarrativeText(generatedNarrative)
    } catch (error) {
      setNarrativeError(error instanceof Error ? error.message : 'Could not generate narrative.')
    } finally {
      setIsGeneratingNarrative(false)
    }
  }

  async function copyNarrative() {
    if (!narrativeText) {
      return
    }

    await navigator.clipboard.writeText(narrativeText)
    setHasCopiedNarrative(true)
  }

  function selectBaseEvent(eventId: string) {
    setSelectedBaseEventId(eventId)
    setContentComment('')

    if (!eventId) {
      if (eventKind !== 'Question') {
        setEventKind('Content')
      }
      setChangeAction('Create')
      setContentBody('')
      return
    }

    const eventToRevise = selectedEvents.find((event) => event.id === eventId)
    if (eventKind === 'Question') {
      setChangeAction('Create')
      setContentBody('')
      return
    }

    if (getEventKind(eventToRevise ?? { kind: 'Content' } as ContentEvent) === 'Question') {
      setEventKind('Decision')
      setChangeAction('Create')
      setContentBody('')
      return
    }

    setEventKind('Content')
    setChangeAction('Revise')
    setContentBody(eventToRevise?.body ?? '')
  }

  function selectEventKind(kind: EventKind) {
    setEventKind(kind)
    setContentBody('')
    setContentComment('')
    setChangeAction('Create')

    if (kind === 'Decision') {
      setSelectedBaseEventId(openQuestion?.id ?? '')
      return
    }

    setSelectedBaseEventId('')
  }

  function getTargetEvent(eventId?: string) {
    return eventId ? selectedEvents.find((event) => event.id === eventId) : undefined
  }

  function getQuestionContext(question?: ContentEvent) {
    return question?.baseEventId ? getTargetEvent(question.baseEventId) : undefined
  }

  function exportVisibleMarkdown() {
    if (!selectedBucket) {
      return
    }

    const historyLabel = appliedEvent
      ? `Showing through ${appliedEvent.id} (${appliedAcceptedCount}/${latestAcceptedCount})`
      : `Before accepted events (0/${latestAcceptedCount})`
    const lines = [
      `# ${selectedBucket.name}`,
      '',
      selectedBucket.description.trim(),
      '',
      `> Exported visible Conlab state: ${historyLabel}`,
      '',
    ].filter((line, index, values) => line !== '' || values[index - 1] !== '')

    if (!renderedEvents.length) {
      lines.push('No accepted content yet.')
    }

    for (const event of renderedEvents) {
      lines.push('---', '', event.body.trim(), '')
      lines.push(`_Rendered from ${event.id}${event.baseEventId ? `, revises ${event.baseEventId}` : ''}_`)

      if (event.comment.trim()) {
        lines.push('', `> Comment: ${event.comment.trim().replace(/\n/g, '\n> ')}`)
      }

      lines.push('')
    }

    const blob = new Blob([`${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`], {
      type: 'text/markdown;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')

    anchor.href = url
    anchor.download = `${getFileSlug(selectedBucket.name)}-${getTimestampLabel()}.md`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  function selectChangeAction(action: EventAction) {
    setChangeAction(action)

    if (action === 'Create') {
      setSelectedBaseEventId('')
      setContentBody('')
      return
    }

    if (!selectedBaseEventId) {
      return
    }

    const selectedEvent = selectedEvents.find((event) => event.id === selectedBaseEventId)
    setContentBody(selectedEvent?.body ?? '')
  }

  async function addBucket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = bucketName.trim()
    const description = bucketDescription.trim()

    if (!name || !description) {
      return
    }

    if (!canAdmin) {
      setSaveError('Your Conlab role must be admin to create buckets.')
      return
    }

    const bucket: Bucket = {
      id: generateBucketId(name),
      name,
      description,
      type: bucketType,
      requiresReview: bucketRequiresReview,
      status: 'active',
    }

    const saved = await saveWorkspace(`Create bucket ${name}`, (workspace) => ({
      ...workspace,
      buckets: [...workspace.buckets, bucket],
    }))

    if (!saved) {
      return
    }

    setBucketName('')
    setBucketDescription('')
    setBucketType('content')
    setBucketRequiresReview(true)
    setSelectedBucketId(bucket.id)
    syncBucketSettings(bucket)
    setChangeAction('Create')
    setSelectedBaseEventId('')
    setContentBody('')
    setContentComment('')
    setHistoryAcceptedCount(0)
  }

  async function proposeContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextEventKind = activeEventKind

    if (
      !selectedBucket ||
      !selectedBucketIsActive ||
      pendingEvent ||
      (openQuestion && nextEventKind !== 'Decision') ||
      (nextEventKind !== 'Question' && contentBody.trim().length < 10) ||
      (nextEventKind === 'Question' && contentBody.trim().length < 3) ||
      (nextEventKind === 'Content' && changeAction !== 'Create' && !selectedBaseEventId) ||
      (nextEventKind === 'Decision' && !activeDecisionQuestion) ||
      contentComment.trim().length < 1
    ) {
      return
    }

    if (!canContribute) {
      setSaveError('Your Conlab role is read-only. You cannot propose content.')
      return
    }

    const createdAt = new Date().toISOString()
    const eventStatus: EventStatus =
      nextEventKind === 'Question'
        ? 'Open'
        : selectedBucket.requiresReview
          ? 'Proposed'
          : 'Accepted'
    const contentEvent: ContentEvent = {
      id: generateEventId(),
      bucketId: selectedBucket.id,
      author: eventAuthor,
      body: contentBody.trim(),
      comment: contentComment.trim(),
      kind: nextEventKind,
      action: nextEventKind === 'Content' ? changeAction : 'Create',
      baseEventId:
        nextEventKind === 'Decision'
          ? activeDecisionQuestion?.id
          : selectedBaseEventId || undefined,
      status: eventStatus,
      createdAt,
      decidedAt: eventStatus === 'Accepted' ? createdAt : undefined,
    }

    if (selectedBucket.type === 'prompt') {
      await saveContentEvent(contentEvent, nextEventKind)
      return
    }

    setPendingContribution({
      contentEvent,
      eventKind: nextEventKind,
    })
    setGenAIResult(null)
    setGenAIError('')
  }

  async function saveContentEvent(contentEvent: ContentEvent, nextEventKind: EventKind) {
    const saved = await saveWorkspace(`${contentEvent.status === 'Accepted' ? 'Accept' : contentEvent.status === 'Open' ? 'Ask' : 'Propose'} ${nextEventKind.toLowerCase()} ${contentEvent.id}`, (workspace) => {
      const latestBucket = workspace.buckets.find((bucket) => bucket.id === contentEvent.bucketId)

      if (!latestBucket) {
        throw new Error('The selected bucket no longer exists. Latest workspace was loaded.')
      }

      if (latestBucket.status === 'archived') {
        throw new Error('This bucket is archived. It cannot accept new content.')
      }

      if (workspace.events.some((event) => event.bucketId === contentEvent.bucketId && event.status === 'Proposed')) {
        throw new Error('This bucket already has a proposed event in the latest workspace.')
      }

      const latestOpenQuestion = workspace.events.find(
        (event) => event.bucketId === contentEvent.bucketId && getEventKind(event) === 'Question' && event.status === 'Open',
      )

      if (latestOpenQuestion && nextEventKind !== 'Decision') {
        throw new Error('This bucket has an open question. Add a decision before adding more content.')
      }

      if (nextEventKind === 'Decision' && (!contentEvent.baseEventId || !latestOpenQuestion || latestOpenQuestion.id !== contentEvent.baseEventId)) {
        throw new Error('The open question changed in the latest workspace.')
      }

      const latestEvent = {
        ...contentEvent,
        status:
          nextEventKind === 'Question'
            ? 'Open'
            : latestBucket.requiresReview
              ? 'Proposed'
              : 'Accepted',
        decidedAt: nextEventKind !== 'Question' && !latestBucket.requiresReview ? contentEvent.createdAt : undefined,
      } satisfies ContentEvent

      if (
        latestEvent.baseEventId &&
        !workspace.events.some((event) => event.id === latestEvent.baseEventId)
      ) {
        throw new Error('The selected target event no longer exists in the latest workspace.')
      }

      return {
        ...workspace,
        events: [
          latestEvent,
          ...workspace.events.map((event) =>
            nextEventKind === 'Decision' &&
            latestEvent.status === 'Accepted' &&
            event.id === latestEvent.baseEventId
              ? {
                  ...event,
                  status: 'Resolved' as const,
                  decidedAt: latestEvent.createdAt,
                }
              : event,
          ),
        ],
      }
    })

    if (!saved) {
      return false
    }

    setEventKind('Content')
    setChangeAction('Create')
    setSelectedBaseEventId('')
    setContentBody('')
    setContentComment('')

    return true
  }

  async function decideEvent(eventId: string, status: 'Accepted' | 'Rejected') {
    if (!canReview) {
      setSaveError('Your Conlab role must be reviewer to accept or reject events.')
      return
    }

    await saveWorkspace(`${status} event ${eventId}`, (workspace) => {
      const targetEvent = workspace.events.find((event) => event.id === eventId)

      if (!targetEvent) {
        throw new Error('The selected event no longer exists in the latest workspace.')
      }

      if (targetEvent.status !== 'Proposed') {
        throw new Error('The selected event was already decided in the latest workspace.')
      }

      return {
        ...workspace,
        events: workspace.events.map((event) =>
          event.id === eventId
            ? {
                ...event,
                status,
                decidedAt: new Date().toISOString(),
              }
            : status === 'Accepted' &&
                targetEvent &&
                getEventKind(targetEvent) === 'Decision' &&
                event.id === targetEvent.baseEventId
              ? {
                  ...event,
                  status: 'Resolved',
                  decidedAt: new Date().toISOString(),
                }
            : event,
        ),
      }
    })
  }

  async function addEventComment(targetEventId: string) {
    if (!selectedBucket || !selectedBucketIsActive) {
      return
    }

    if (!canContribute) {
      setSaveError('Your Conlab role is read-only. You cannot add comments.')
      return
    }

    const body = commentBody.trim()

    if (!body || commentTargetEventId !== targetEventId) {
      return
    }

    const createdAt = new Date().toISOString()
    const commentEvent: ContentEvent = {
      id: generateEventId(),
      bucketId: selectedBucket.id,
      author: eventAuthor,
      body,
      comment: '',
      kind: 'Comment',
      action: 'Create',
      baseEventId: targetEventId,
      status: 'Accepted',
      createdAt,
      decidedAt: createdAt,
    }

    const saved = await saveWorkspace(`Comment on event ${targetEventId}`, (workspace) => {
      const latestBucket = workspace.buckets.find((bucket) => bucket.id === selectedBucket.id)

      if (!latestBucket) {
        throw new Error('The selected bucket no longer exists. Latest workspace was loaded.')
      }

      if (latestBucket.status === 'archived') {
        throw new Error('This bucket is archived. It cannot accept new comments.')
      }

      if (!workspace.events.some((event) => event.id === targetEventId && event.bucketId === selectedBucket.id)) {
        throw new Error('The selected target event no longer exists in the latest workspace.')
      }

      return {
        ...workspace,
        events: [commentEvent, ...workspace.events],
      }
    })

    if (!saved) {
      return
    }

    setCommentTargetEventId('')
    setCommentBody('')
  }

  async function updateBucketSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedBucket) {
      return
    }

    if (!canAdmin) {
      setSaveError('Your Conlab role must be admin to change bucket settings.')
      return
    }

    const name = bucketSettingsName.trim()
    const description = bucketSettingsDescription.trim()

    if (!name || !description) {
      return
    }

    await saveWorkspace(`Update bucket ${selectedBucket.id}`, (workspace) => {
      const targetBucket = workspace.buckets.find((bucket) => bucket.id === selectedBucket.id)

      if (!targetBucket) {
        throw new Error('The selected bucket no longer exists in the latest workspace.')
      }

      if (targetBucket.status === 'archived') {
        throw new Error('Archived buckets cannot be changed.')
      }

      return {
        ...workspace,
        buckets: workspace.buckets.map((bucket) =>
          bucket.id === selectedBucket.id
            ? {
                ...bucket,
                name,
                description,
                type: bucketSettingsType,
                requiresReview: bucketSettingsRequiresReview,
              }
            : bucket,
        ),
      }
    })
  }

  async function archiveBucket() {
    if (!selectedBucket) {
      return
    }

    if (!canAdmin) {
      setSaveError('Your Conlab role must be admin to archive buckets.')
      return
    }

    const archivedAt = new Date().toISOString()
    const archivedName = getArchivedBucketName(selectedBucket.name)

    await saveWorkspace(`Archive bucket ${selectedBucket.id}`, (workspace) => {
      const targetBucket = workspace.buckets.find((bucket) => bucket.id === selectedBucket.id)

      if (!targetBucket) {
        throw new Error('The selected bucket no longer exists in the latest workspace.')
      }

      if (targetBucket.status === 'archived') {
        throw new Error('This bucket is already archived.')
      }

      return {
        ...workspace,
        buckets: workspace.buckets.map((bucket) =>
          bucket.id === selectedBucket.id
            ? {
                ...bucket,
                name: archivedName,
                status: 'archived',
                archivedAt,
              }
            : bucket,
        ),
      }
    })
  }

  if (!connection) {
    return (
      <main aria-busy={isConnecting} className={isConnecting ? 'setup-shell is-busy' : 'setup-shell'}>
        {isConnecting ? <BusyOverlay message="Connecting to Git..." /> : null}
        <section className="setup-panel">
          <p className="eyebrow">Install Workspace</p>
          <h1>Connect a Git repo</h1>
          <p>
            Paste an empty or existing GitHub or GitLab repository URL and an access token with
            repository contents read/write access. The app will create or load {WORKSPACE_FILE}.
          </p>

          <form className="setup-form" onSubmit={connectToGitRepo}>
            <label>
              Git repo URL
              <input
                disabled={isConnecting}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo or https://git.example.com/group/project"
                value={repoUrl}
              />
            </label>
            <label>
              Access token
              <input
                disabled={isConnecting}
                onChange={(event) => setToken(event.target.value)}
                placeholder="GitHub PAT or GitLab project/personal access token"
                type="password"
                value={token}
              />
            </label>
            {connectionError ? <p className="error-text">{connectionError}</p> : null}
            <button disabled={isConnecting || !repoUrl.trim() || !token.trim()} type="submit">
              {isConnecting ? 'Connecting...' : 'Connect workspace'}
            </button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <main
      aria-busy={isSaving || isCheckingGenAI || isGeneratingNarrative}
      className={isSaving || isCheckingGenAI || isGeneratingNarrative ? 'app-shell is-busy' : 'app-shell'}
    >
      {isSaving ? <BusyOverlay message="Saving to Git..." /> : null}
      {pendingContribution ? (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <section className="modal-panel" aria-labelledby="genai-check-title">
            <div className="modal-header">
              <div>
                <p className="eyebrow">GenAI Plausibility Check</p>
                <h2 id="genai-check-title">Review before posting</h2>
              </div>
              <button
                aria-label="Close GenAI review"
                className="icon-button"
                disabled={isCheckingGenAI || isSaving}
                onClick={closeGenAIModal}
                type="button"
              >
                x
              </button>
            </div>

            <p className="modal-copy">
              Check whether this {pendingContribution.eventKind.toLowerCase()} is one clear statement, overlaps with existing bucket history,
              and can be rewritten more crisply before it is written to Git. You can also post without a GenAI check.
            </p>

            <div className="genai-settings">
              <label>
                Endpoint
                <input
                  disabled={isCheckingGenAI || isSaving}
                  onChange={(event) => setGenAIEndpoint(event.target.value)}
                  value={genAIEndpoint}
                />
              </label>
              <label>
                Model
                <input
                  disabled={isCheckingGenAI || isSaving}
                  onChange={(event) => setGenAIModel(event.target.value)}
                  value={genAIModel}
                />
              </label>
              <label>
                API key
                <input
                  disabled={isCheckingGenAI || isSaving}
                  onChange={(event) => setGenAIKey(event.target.value)}
                  placeholder="Stored locally in this browser"
                  type="password"
                  value={genAIKey}
                />
              </label>
            </div>

            <div className="genai-preview">
              <span>Contribution preview</span>
              <MarkdownText text={pendingContribution.contentEvent.body} />
              <small>{pendingContribution.contentEvent.comment}</small>
            </div>

            {genAIError ? <p className="error-text">{genAIError}</p> : null}

            {genAIResult ? (
              <div className={genAIResult.ready_to_post ? 'genai-result positive' : 'genai-result warning'}>
                <strong>
                  {genAIResult.ready_to_post ? 'Ready to post' : 'Needs attention'} · {genAIResult.confidence} confidence
                </strong>

                <div className="genai-result-section">
                  <span>Single-statement discipline</span>
                  <p>{genAIResult.single_statement.assessment || (genAIResult.single_statement.ok ? 'The contribution is focused on one statement.' : 'The contribution appears too broad.')}</p>
                </div>

                <div className="genai-result-section">
                  <span>Overlap with bucket history</span>
                  <p>{genAIResult.overlap.assessment || (genAIResult.overlap.has_overlap ? 'Potential overlap found.' : 'No meaningful overlap found.')}</p>
                  {genAIResult.overlap.similar_events.length ? (
                    <ul>
                      {genAIResult.overlap.similar_events.map((eventId) => (
                        <li key={eventId}>{eventId}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {genAIResult.contradictions.length ? (
                  <div className="genai-result-section">
                    <span>Contradictions</span>
                    <ul>
                      {genAIResult.contradictions.map((contradiction) => (
                        <li key={contradiction}>{contradiction}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {genAIResult.rewrite_suggestions.length ? (
                  <div className="genai-result-section">
                    <span>Rewrite suggestions</span>
                    <ul>
                      {genAIResult.rewrite_suggestions.map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {genAIResult.concise_rewrite ? (
                  <div className="genai-result-section">
                    <span>Concise rewrite</span>
                    <p>{genAIResult.concise_rewrite}</p>
                  </div>
                ) : null}

                <div className="genai-result-section">
                  <span>Overall assessment</span>
                  <p>{genAIResult.overall_assessment}</p>
                </div>
              </div>
            ) : null}

            <div className="modal-actions">
              <button
                className="secondary-button compact"
                disabled={isCheckingGenAI || isSaving}
                onClick={closeGenAIModal}
                type="button"
              >
                Cancel
              </button>
              <button
                className="secondary-button compact"
                disabled={isCheckingGenAI || isSaving}
                onClick={postPendingContribution}
                type="button"
              >
                Post without check
              </button>
              <button
                disabled={isCheckingGenAI || isSaving || !genAIKey.trim()}
                onClick={checkPendingContributionWithGenAI}
                type="button"
              >
                {isCheckingGenAI ? 'Checking...' : genAIResult ? 'Run check again' : 'Check with GenAI'}
              </button>
              {genAIResult ? (
                <button
                  disabled={isCheckingGenAI || isSaving}
                  onClick={postPendingContribution}
                  type="button"
                >
                  Post contribution
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {isNarrativeModalOpen ? (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <section className="modal-panel narrative-modal" aria-labelledby="narrative-title">
            <div className="modal-header">
              <div>
                <p className="eyebrow">Narrative</p>
                <h2 id="narrative-title">Create narrative</h2>
              </div>
              <button
                aria-label="Close narrative generator"
                className="icon-button"
                disabled={isGeneratingNarrative}
                onClick={closeNarrativeModal}
                type="button"
              >
                x
              </button>
            </div>

            <p className="modal-copy">
              Select one prompt bucket and one or more content buckets. Content buckets are used in the order shown here.
            </p>

            <div className="genai-settings">
              <label>
                Endpoint
                <input
                  disabled={isGeneratingNarrative}
                  onChange={(event) => setGenAIEndpoint(event.target.value)}
                  value={genAIEndpoint}
                />
              </label>
              <label>
                Model
                <input
                  disabled={isGeneratingNarrative}
                  onChange={(event) => setGenAIModel(event.target.value)}
                  value={genAIModel}
                />
              </label>
              <label>
                API key
                <input
                  disabled={isGeneratingNarrative}
                  onChange={(event) => setGenAIKey(event.target.value)}
                  placeholder="Stored locally in this browser"
                  type="password"
                  value={genAIKey}
                />
              </label>
            </div>

            <label>
              Prompt bucket
              <select
                disabled={isGeneratingNarrative}
                onChange={(event) => {
                  setSelectedPromptBucketId(event.target.value)
                  setNarrativeText('')
                  setHasCopiedNarrative(false)
                }}
                value={selectedPromptBucketId}
              >
                <option value="">Select a prompt bucket</option>
                {promptBuckets.map((bucket) => (
                  <option key={bucket.id} value={bucket.id}>
                    {bucket.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="narrative-source-list">
              <span>Content buckets</span>
              {contentBuckets.length ? (
                contentBuckets.map((bucket) => {
                  const renderedBlockCount = getRenderedEventsForBucket(bucket.id).length

                  return (
                    <label className="checkbox-label narrative-source-item" key={bucket.id}>
                      <input
                        checked={selectedNarrativeBucketIds.includes(bucket.id)}
                        disabled={isGeneratingNarrative}
                        onChange={() => toggleNarrativeBucket(bucket.id)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{bucket.name}</strong>
                        <small>{renderedBlockCount} visible blocks</small>
                      </span>
                    </label>
                  )
                })
              ) : (
                <p className="empty">No content buckets available.</p>
              )}
            </div>

            {narrativeError ? <p className="error-text">{narrativeError}</p> : null}

            {narrativeText ? (
              <div className="narrative-output">
                <span>Generated narrative</span>
                <textarea readOnly rows={8} value={narrativeText} />
              </div>
            ) : null}

            <div className="modal-actions">
              <button
                className="secondary-button compact"
                disabled={isGeneratingNarrative}
                onClick={closeNarrativeModal}
                type="button"
              >
                Close
              </button>
              {narrativeText ? (
                <button
                  className="secondary-button compact"
                  disabled={isGeneratingNarrative}
                  onClick={copyNarrative}
                  type="button"
                >
                  {hasCopiedNarrative ? 'Copied' : 'Copy narrative'}
                </button>
              ) : null}
              <button
                disabled={
                  isGeneratingNarrative ||
                  !genAIKey.trim() ||
                  !selectedPromptBucketId ||
                  selectedNarrativeBucketIds.length < 1
                }
                onClick={generateNarrative}
                type="button"
              >
                {isGeneratingNarrative ? 'Generating...' : narrativeText ? 'Regenerate narrative' : 'Generate narrative'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {remoteUpdate ? (
        <aside className="update-banner" aria-live="polite">
          <span>
            New workspace update: <strong>{remoteUpdate.summary}</strong>
          </span>
          <span className="update-actions">
            <button onClick={loadRemoteUpdate} type="button">
              Load latest
            </button>
            <button className="secondary-inline-button" onClick={() => setRemoteUpdate(null)} type="button">
              Dismiss
            </button>
          </span>
        </aside>
      ) : null}
      <aside className="bucket-panel" aria-label="Buckets">
        <div className="panel-header">
          <p className="eyebrow">Level 1 MVP</p>
          <h1>Contribution Ledger</h1>
          <p className="repo-link">
            {connection.provider === 'github' ? 'GitHub' : 'GitLab'} · {connection.displayName} · {connection.branch}
          </p>
          {access ? (
            <dl className="access-summary" aria-label="Current access">
              <div>
                <dt>User</dt>
                <dd>{getDisplayUserName(access.user)}</dd>
              </div>
              <div>
                <dt>Git role</dt>
                <dd>{access.providerRole}</dd>
              </div>
              <div>
                <dt>Conlab role</dt>
                <dd>{access.conlabRole}</dd>
              </div>
            </dl>
          ) : null}
          <button className="secondary-button" onClick={disconnectGitRepo} type="button">
            Disconnect
          </button>
          {isSaving ? <p className="save-state">Saving to Git...</p> : null}
          {saveError ? <p className="error-text">{saveError}</p> : null}
        </div>

        <form className="bucket-form" onSubmit={addBucket}>
          <label>
            Bucket name
            <input
              disabled={isSaving || !canAdmin}
              value={bucketName}
              onChange={(event) => setBucketName(event.target.value)}
              placeholder="e.g. Customer Signals"
            />
          </label>
          <label>
            Description
            <textarea
              disabled={isSaving || !canAdmin}
              value={bucketDescription}
              onChange={(event) => setBucketDescription(event.target.value)}
              placeholder="What text are we trying to create here?"
              rows={3}
            />
          </label>
          <label>
            Bucket type
            <select
              disabled={isSaving || !canAdmin}
              onChange={(event) => setBucketType(event.target.value as BucketType)}
              value={bucketType}
            >
              <option value="content">Content</option>
              <option value="prompt">Prompt</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              checked={bucketRequiresReview}
              disabled={isSaving || !canAdmin}
              onChange={(event) => setBucketRequiresReview(event.target.checked)}
              type="checkbox"
            />
            Require reviewer acceptance for content
          </label>
          <button disabled={isSaving || !canAdmin} type="submit">Create bucket</button>
        </form>
        {!canAdmin ? (
          <p className="permission-note">Only admins can create and configure buckets.</p>
        ) : null}

        <nav className="bucket-list">
          {buckets.map((bucket) => {
            const bucketEvents = events.filter((event) => event.bucketId === bucket.id)
            const hasPending = bucketEvents.some((event) => event.status === 'Proposed')

            return (
              <button
                className={bucket.id === selectedBucket?.id ? 'bucket-item active' : 'bucket-item'}
                key={bucket.id}
                onClick={() => selectBucket(bucket.id)}
                type="button"
              >
                <span>
                  <strong>{bucket.name}</strong>
                  <small className="bucket-type-label">{bucket.type === 'prompt' ? 'Prompt bucket' : 'Content bucket'}</small>
                  <MarkdownText className="bucket-description" text={bucket.description} />
                </span>
                <em>
                  {bucket.status === 'archived'
                    ? 'Archived'
                    : hasPending
                      ? 'Needs acceptance'
                      : `${bucketEvents.length} events`}
                </em>
              </button>
            )
          })}
        </nav>

        {canAdmin && selectedBucket ? (
          <form className="bucket-settings bucket-settings-panel" onSubmit={updateBucketSettings}>
            <div className="section-title">
              <h3>Bucket Settings</h3>
              <span>{selectedBucket.status === 'archived' ? 'Archived' : 'Admin'}</span>
            </div>
            <label>
              Bucket name
              <input
                disabled={isSaving || selectedBucket.status === 'archived'}
                onChange={(event) => setBucketSettingsName(event.target.value)}
                value={bucketSettingsName}
              />
            </label>
            <label>
              Description
              <textarea
                disabled={isSaving || selectedBucket.status === 'archived'}
                onChange={(event) => setBucketSettingsDescription(event.target.value)}
                rows={3}
                value={bucketSettingsDescription}
              />
            </label>
            <label>
              Bucket type
              <select
                disabled={isSaving || selectedBucket.status === 'archived'}
                onChange={(event) => setBucketSettingsType(event.target.value as BucketType)}
                value={bucketSettingsType}
              >
                <option value="content">Content</option>
                <option value="prompt">Prompt</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input
                checked={bucketSettingsRequiresReview}
                disabled={isSaving || selectedBucket.status === 'archived'}
                onChange={(event) => setBucketSettingsRequiresReview(event.target.checked)}
                type="checkbox"
              />
              Require reviewer acceptance for content
            </label>
            <div className="settings-actions">
              <button
                disabled={
                  isSaving ||
                  selectedBucket.status === 'archived' ||
                  !bucketSettingsName.trim() ||
                  !bucketSettingsDescription.trim()
                }
                type="submit"
              >
                Save settings
              </button>
              <button
                className="danger-button"
                disabled={isSaving || selectedBucket.status === 'archived'}
                onClick={archiveBucket}
                type="button"
              >
                Archive bucket
              </button>
            </div>
          </form>
        ) : null}
      </aside>

      <section className="workspace">
        {selectedBucket ? (
          <>
            <header className="workspace-header">
              <div>
                <p className="eyebrow">Bucket</p>
                <h2>{selectedBucket.name}</h2>
                <MarkdownText className="workspace-description" text={selectedBucket.description} />
              </div>
              <span className={pendingEvent ? 'status pending' : 'status open'}>
                {selectedBucket.status === 'archived'
                  ? 'Archived'
                  : pendingEvent
                    ? 'Acceptance pending'
                    : selectedBucket.type === 'prompt'
                      ? selectedBucket.requiresReview
                        ? 'Prompt review required'
                        : 'Auto-accepting prompt'
                      : selectedBucket.requiresReview
                        ? 'Review required'
                        : 'Auto-accepting content'}
              </span>
            </header>

            <section className="accepted-text" aria-label="Accepted text">
              <div className="section-title">
                <div>
                  <h3>Rendered Bucket Text</h3>
                  <span>{renderedEvents.length} rendered blocks</span>
                </div>
                <div className="section-actions">
                  <button className="export-button" onClick={exportVisibleMarkdown} type="button">
                    Export .md
                  </button>
                  <button
                    aria-expanded={isRenderedTextOpen}
                    className="collapse-button"
                    onClick={() => setIsRenderedTextOpen((isOpen) => !isOpen)}
                    type="button"
                  >
                    {isRenderedTextOpen ? 'Collapse' : 'Open'}
                  </button>
                </div>
              </div>
              {isRenderedTextOpen ? (
                <>
                  <div className="history-controls" aria-label="Rendered history controls">
                    <button
                      disabled={appliedAcceptedCount === 0}
                      onClick={() => setHistoryAcceptedCount((current) => Math.max(0, current - 1))}
                      type="button"
                    >
                      &lt;&lt;
                    </button>
                    <span>
                      {appliedEvent
                        ? `Showing through ${appliedEvent.id} (${appliedAcceptedCount}/${latestAcceptedCount})`
                        : `Before accepted events (0/${latestAcceptedCount})`}
                    </span>
                    <button
                      disabled={appliedAcceptedCount >= latestAcceptedCount}
                      onClick={() =>
                        setHistoryAcceptedCount((current) =>
                          Math.min(latestAcceptedCount, current + 1),
                        )
                      }
                      type="button"
                    >
                      &gt;&gt;
                    </button>
                  </div>
                  {renderedEvents.length ? (
                    renderedEvents.map((event) => (
                      <article className="rendered-change" key={event.id}>
                        <MarkdownText text={event.body} />
                        <small>
                          Rendered from {event.id}
                          {event.baseEventId ? `, revises ${event.baseEventId}` : ''}
                        </small>
                        <MarkdownText className="rendered-comment" text={event.comment} />
                      </article>
                    ))
                  ) : (
                    <p className="empty">No accepted content yet.</p>
                  )}
                </>
              ) : null}
            </section>

            <form className="content-form" onSubmit={proposeContent}>
              {openQuestion ? (
                <p className="permission-note">This bucket has an open question. Add a decision before adding more content.</p>
              ) : null}
              <fieldset className="change-action-group" disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive || Boolean(openQuestion)}>
                <legend>Entry type</legend>
                <label>
                  <input
                    checked={activeEventKind === 'Content'}
                    name="event-kind"
                    onChange={() => selectEventKind('Content')}
                    type="radio"
                  />
                  Content
                </label>
                <label>
                  <input
                    checked={activeEventKind === 'Question'}
                    name="event-kind"
                    onChange={() => selectEventKind('Question')}
                    type="radio"
                  />
                  Question
                </label>
              </fieldset>
              {activeEventKind === 'Content' ? (
                <fieldset className="change-action-group" disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive}>
                  <legend>Content action</legend>
                  <label>
                    <input
                      checked={changeAction === 'Create'}
                      name="change-action"
                      onChange={() => selectChangeAction('Create')}
                      type="radio"
                    />
                    Create
                  </label>
                  <label>
                    <input
                      checked={changeAction === 'Revise'}
                      disabled={!selectedBaseEventId}
                      name="change-action"
                      onChange={() => selectChangeAction('Revise')}
                      type="radio"
                    />
                    Revise
                  </label>
                  <label>
                    <input
                      checked={changeAction === 'Delete'}
                      disabled={!selectedBaseEventId}
                      name="change-action"
                      onChange={() => selectChangeAction('Delete')}
                      type="radio"
                    />
                    Delete
                  </label>
                </fieldset>
              ) : null}
              <label>
                {activeEventKind === 'Question'
                  ? 'Question context'
                  : activeEventKind === 'Decision'
                    ? 'Question to answer'
                    : 'Change target'}
                <select
                  disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive || activeEventKind === 'Decision'}
                  onChange={(event) => selectBaseEvent(event.target.value)}
                  value={activeEventKind === 'Decision' ? activeDecisionQuestion?.id ?? '' : selectedBaseEventId}
                >
                  <option value="">
                    {activeEventKind === 'Question' ? 'No related event' : 'New content block'}
                  </option>
                  {activeEventKind === 'Decision' && activeDecisionQuestion ? (
                    <option value={activeDecisionQuestion.id}>
                      {activeDecisionQuestion.id} [Question, Open] {truncate(activeDecisionQuestion.body, 70)}
                    </option>
                  ) : null}
                  {topLevelEvents.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.id} [{getEventKind(event)}, {event.status}] {truncate(getEventKind(event) === 'Question' ? event.body : event.comment, 70)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {activeEventKind === 'Question'
                  ? selectedBaseEventId
                    ? `Ask question about ${selectedBaseEventId}`
                    : 'Ask question'
                  : activeEventKind === 'Decision'
                    ? `Decision for ${activeDecisionQuestion?.id ?? 'open question'}`
                    : changeAction === 'Delete'
                      ? selectedTargetEvent && getEventAction(selectedTargetEvent) === 'Delete'
                        ? `Delete delete event ${selectedBaseEventId}`
                        : `Delete content from ${selectedBaseEventId}`
                      : selectedBaseEventId
                        ? `Revise content from ${selectedBaseEventId}`
                        : 'Add proposed content'}
                <textarea
                  disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive || (activeEventKind === 'Content' && changeAction === 'Delete')}
                  onChange={(event) => setContentBody(event.target.value)}
                  placeholder={
                    pendingEvent
                      ? 'Accept or reject the active proposal before adding more content.'
                      : activeEventKind === 'Question'
                        ? 'Ask what needs to be decided before this bucket can move forward.'
                        : activeEventKind === 'Decision'
                          ? 'Record the decision that answers the open question.'
                          : changeAction === 'Delete'
                            ? selectedTargetEvent && getEventAction(selectedTargetEvent) === 'Delete'
                              ? 'The selected delete event will be invalidated if accepted.'
                              : 'Selected content will be removed from the rendered bucket text if accepted.'
                          : selectedBaseEventId
                            ? 'Edit the selected content. The original event stays unchanged.'
                          : 'Record the next content change for this bucket.'
                  }
                  rows={5}
                  value={contentBody}
                />
              </label>
              <label>
                Comment
                <textarea
                  disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive}
                  onChange={(event) => setContentComment(event.target.value)}
                  placeholder={
                    pendingEvent
                      ? 'Accept or reject the active proposal before adding a new comment.'
                      : 'Explain why this content change is useful.'
                  }
                  rows={3}
                  value={contentComment}
                />
              </label>
              <button
                  disabled={
                  isSaving ||
                  Boolean(pendingContribution) ||
                  !canContribute ||
                  !selectedBucketIsActive ||
                  Boolean(pendingEvent) ||
                  (openQuestion && activeEventKind !== 'Decision') ||
                  (activeEventKind !== 'Question' && contentBody.trim().length < 10) ||
                  (activeEventKind === 'Question' && contentBody.trim().length < 3) ||
                  (activeEventKind === 'Content' && changeAction !== 'Create' && !selectedBaseEventId) ||
                  (activeEventKind === 'Decision' && !activeDecisionQuestion) ||
                  contentComment.trim().length < 1
                }
                type="submit"
              >
                {activeEventKind === 'Question'
                  ? 'Ask question'
                  : activeEventKind === 'Decision'
                    ? selectedBucket.requiresReview
                      ? 'Propose decision'
                      : 'Add decision'
                    : 'Propose content'}
              </button>
              {!canContribute ? (
                <p className="permission-note">Your Conlab role is read-only. You can view this bucket but cannot propose changes.</p>
              ) : null}
              {canContribute && !selectedBucketIsActive ? (
                <p className="permission-note">This bucket is archived and does not accept new content.</p>
              ) : null}
            </form>

            <section className="event-log" aria-label="Event log">
              <div className="section-title">
                <div>
                  <h3>Event Log</h3>
                  <span>{selectedEvents.length} events</span>
                </div>
                <button
                  aria-expanded={isEventLogOpen}
                  className="collapse-button"
                  onClick={() => setIsEventLogOpen((isOpen) => !isOpen)}
                  type="button"
                >
                  {isEventLogOpen ? 'Collapse' : 'Open'}
                </button>
              </div>

              {isEventLogOpen && topLevelEvents.length ? (
                topLevelEvents.map((event) => {
                  const kind = getEventKind(event)
                  const targetEvent = getTargetEvent(event.baseEventId)
                  const questionForDecision = kind === 'Decision' ? targetEvent : undefined
                  const contextEvent =
                    kind === 'Question'
                      ? targetEvent
                      : kind === 'Decision'
                        ? getQuestionContext(questionForDecision)
                        : undefined
                  const eventComments = commentsByTargetId.get(event.id) ?? []
                  const isCommenting = commentTargetEventId === event.id

                  return (
                    <article className="event-card" key={event.id}>
                      <div className="event-meta">
                        <span className="event-title">
                          <strong>{event.id}</strong>
                          {kind === 'Question' ? (
                            <em>{event.baseEventId ? `Question about ${event.baseEventId}` : 'Question'}</em>
                          ) : kind === 'Decision' ? (
                            <em>Decision for {event.baseEventId}</em>
                          ) : getEventAction(event) === 'Delete' ? (
                            <em>Deletes {event.baseEventId}</em>
                          ) : event.baseEventId ? (
                            <em>Revises {event.baseEventId}</em>
                          ) : (
                            <em>New block</em>
                          )}
                        </span>
                        <span className={`pill ${event.status.toLowerCase()}`}>{event.status}</span>
                      </div>
                      {contextEvent ? (
                        <div className="event-context">
                          <span>Context</span>
                          <MarkdownText text={contextEvent.body} />
                        </div>
                      ) : null}
                      {questionForDecision ? (
                        <div className="event-question">
                          <span>Question</span>
                          <MarkdownText text={questionForDecision.body} />
                        </div>
                      ) : null}
                      <div className="event-change">
                        <span>
                          {kind === 'Question'
                            ? 'Question'
                            : kind === 'Decision'
                              ? 'Decision'
                              : getEventAction(event) === 'Delete'
                                ? 'Deleted content'
                                : 'Content change'}
                        </span>
                        <MarkdownText text={event.body} />
                      </div>
                      <div className="event-comment">
                        <span>Comment</span>
                        <MarkdownText text={event.comment} />
                      </div>
                      {eventComments.length ? (
                        <div className="event-discussion">
                          <span>Discussion</span>
                          {eventComments.map((commentEvent) => (
                            <article className="event-discussion-comment" key={commentEvent.id}>
                              <MarkdownText text={commentEvent.body} />
                              <footer>
                                {commentEvent.author} · {formatDate(commentEvent.createdAt)}
                              </footer>
                            </article>
                          ))}
                        </div>
                      ) : null}
                      {isCommenting ? (
                        <form
                          className="event-comment-form"
                          onSubmit={(formEvent) => {
                            formEvent.preventDefault()
                            void addEventComment(event.id)
                          }}
                        >
                          <label>
                            Add comment
                            <textarea
                              disabled={isSaving || !canContribute || !selectedBucketIsActive}
                              onChange={(inputEvent) => setCommentBody(inputEvent.target.value)}
                              rows={3}
                              value={commentBody}
                            />
                          </label>
                          <div className="event-comment-actions">
                            <button
                              className="secondary-button compact"
                              disabled={isSaving}
                              onClick={() => {
                                setCommentTargetEventId('')
                                setCommentBody('')
                              }}
                              type="button"
                            >
                              Cancel
                            </button>
                            <button
                              disabled={isSaving || !canContribute || !selectedBucketIsActive || commentBody.trim().length < 1}
                              type="submit"
                            >
                              Add comment
                            </button>
                          </div>
                        </form>
                      ) : null}
                      <footer>
                        <span>
                          {event.author} · {formatDate(event.createdAt)}
                        </span>
                        <div className="decision-actions">
                          <button
                            className="secondary-inline-action"
                            disabled={isSaving || !canContribute || !selectedBucketIsActive}
                            onClick={() => {
                              setCommentTargetEventId(event.id)
                              setCommentBody('')
                            }}
                            type="button"
                          >
                            Comment{eventComments.length ? ` (${eventComments.length})` : ''}
                          </button>
                          {event.status === 'Proposed' ? (
                            <>
                              <button
                                disabled={isSaving || !canReview}
                                onClick={() => decideEvent(event.id, 'Rejected')}
                                type="button"
                              >
                                Reject
                              </button>
                              <button
                                disabled={isSaving || !canReview}
                                onClick={() => decideEvent(event.id, 'Accepted')}
                                type="button"
                              >
                                Accept
                              </button>
                            </>
                          ) : event.status === 'Open' ? (
                            <span>Awaiting decision</span>
                          ) : (
                            <span>Decided {event.decidedAt ? formatDate(event.decidedAt) : ''}</span>
                          )}
                        </div>
                      </footer>
                    </article>
                  )
                })
              ) : isEventLogOpen ? (
                <p className="empty">No events recorded for this bucket.</p>
              ) : null}
            </section>
          </>
        ) : (
          <p className="empty">Create a bucket to start.</p>
        )}
      </section>

      <aside className="rules-panel">
        <h3>Current Rule</h3>
        <p>
          A bucket can have one proposed content event at a time. Each event carries the content
          change and a comment explaining it. Accept or reject it before adding the next change.
          A new event may also revise or delete any previous event without mutating the original
          history entry.
        </p>
        <button
          className="secondary-button"
          disabled={!promptBuckets.length || !contentBuckets.length}
          onClick={openNarrativeModal}
          type="button"
        >
          Create narrative
        </button>
        <dl>
          <div>
            <dt>Buckets</dt>
            <dd>{buckets.length}</dd>
          </div>
          <div>
            <dt>Total events</dt>
            <dd>{events.length}</dd>
          </div>
          <div>
            <dt>Active bucket</dt>
            <dd>{selectedBucket?.name ?? 'None'}</dd>
          </div>
        </dl>
      </aside>
    </main>
  )
}

export default App
