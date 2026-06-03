import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type Bucket = {
  id: string
  name: string
  description: string
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

type EventAction = 'Create' | 'Revise' | 'Delete'

type ContentEvent = {
  id: string
  bucketId: string
  author: string
  body: string
  comment: string
  action: EventAction
  baseEventId?: string
  status: 'Proposed' | 'Accepted' | 'Rejected'
  createdAt: string
  decidedAt?: string
}

const WORKSPACE_FILE = 'conlab.json'
const CONNECTION_STORAGE_KEY = 'conlab.gitConnection'
const LEGACY_CONNECTION_STORAGE_KEY = 'conlab.githubConnection'

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
  const acceptedEvents = chronologicalEvents.filter((event) => event.status === 'Accepted')

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
  const [bucketRequiresReview, setBucketRequiresReview] = useState(true)
  const [bucketSettingsName, setBucketSettingsName] = useState('')
  const [bucketSettingsDescription, setBucketSettingsDescription] = useState('')
  const [bucketSettingsRequiresReview, setBucketSettingsRequiresReview] = useState(true)
  const [changeAction, setChangeAction] = useState<EventAction>('Create')
  const [selectedBaseEventId, setSelectedBaseEventId] = useState('')
  const [contentBody, setContentBody] = useState('')
  const [contentComment, setContentComment] = useState('')
  const [historyAcceptedCount, setHistoryAcceptedCount] = useState(0)
  const syncedWorkspaceRef = useRef<LoadedWorkspace | null>(null)

  const selectedBucket = buckets.find((bucket) => bucket.id === selectedBucketId) ?? buckets[0]

  const selectedEvents = useMemo(
    () => events.filter((event) => event.bucketId === selectedBucket?.id),
    [events, selectedBucket?.id],
  )

  const pendingEvent = selectedEvents.find((event) => event.status === 'Proposed')
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

  function syncBucketSettings(bucket?: Bucket) {
    setBucketSettingsName(bucket?.name ?? '')
    setBucketSettingsDescription(bucket?.description ?? '')
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
    setChangeAction('Create')
    setSelectedBaseEventId('')
    setContentBody('')
    setContentComment('')
    setHistoryAcceptedCount(countAcceptedEvents(events, bucketId))
    syncBucketSettings(buckets.find((bucket) => bucket.id === bucketId))
  }

  function selectBaseEvent(eventId: string) {
    setSelectedBaseEventId(eventId)
    setContentComment('')

    if (!eventId) {
      setChangeAction('Create')
      setContentBody('')
      return
    }

    setChangeAction('Revise')
    const eventToRevise = selectedEvents.find((event) => event.id === eventId)
    setContentBody(eventToRevise?.body ?? '')
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

    if (
      !selectedBucket ||
      !selectedBucketIsActive ||
      pendingEvent ||
      (changeAction !== 'Delete' && contentBody.trim().length < 10) ||
      (changeAction !== 'Create' && !selectedBaseEventId) ||
      contentComment.trim().length < 1
    ) {
      return
    }

    if (!canContribute) {
      setSaveError('Your Conlab role is read-only. You cannot propose content.')
      return
    }

    const createdAt = new Date().toISOString()
    const contentEvent: ContentEvent = {
      id: generateEventId(),
      bucketId: selectedBucket.id,
      author: eventAuthor,
      body: contentBody.trim(),
      comment: contentComment.trim(),
      action: changeAction,
      baseEventId: selectedBaseEventId || undefined,
      status: selectedBucket.requiresReview ? 'Proposed' : 'Accepted',
      createdAt,
      decidedAt: selectedBucket.requiresReview ? undefined : createdAt,
    }

    const saved = await saveWorkspace(`${contentEvent.status === 'Accepted' ? 'Accept' : 'Propose'} ${changeAction.toLowerCase()} ${contentEvent.id}`, (workspace) => {
      const latestBucket = workspace.buckets.find((bucket) => bucket.id === selectedBucket.id)

      if (!latestBucket) {
        throw new Error('The selected bucket no longer exists. Latest workspace was loaded.')
      }

      if (latestBucket.status === 'archived') {
        throw new Error('This bucket is archived. It cannot accept new content.')
      }

      if (latestBucket.requiresReview && workspace.events.some((event) => event.bucketId === selectedBucket.id && event.status === 'Proposed')) {
        throw new Error('This bucket already has a proposed event in the latest workspace.')
      }

      const latestEvent = {
        ...contentEvent,
        status: latestBucket.requiresReview ? 'Proposed' : 'Accepted',
        decidedAt: latestBucket.requiresReview ? undefined : contentEvent.createdAt,
      } satisfies ContentEvent

      if (
        latestEvent.baseEventId &&
        !workspace.events.some((event) => event.id === latestEvent.baseEventId)
      ) {
        throw new Error('The selected target event no longer exists in the latest workspace.')
      }

      return {
        ...workspace,
        events: [latestEvent, ...workspace.events],
      }
    })

    if (!saved) {
      return
    }

    setChangeAction('Create')
    setSelectedBaseEventId('')
    setContentBody('')
    setContentComment('')
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
            : event,
        ),
      }
    })
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
    <main aria-busy={isSaving} className={isSaving ? 'app-shell is-busy' : 'app-shell'}>
      {isSaving ? <BusyOverlay message="Saving to Git..." /> : null}
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
                    : selectedBucket.requiresReview
                      ? 'Review required'
                      : 'Auto-accepting content'}
              </span>
            </header>

            {canAdmin ? (
              <form className="bucket-settings" onSubmit={updateBucketSettings}>
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

            <section className="accepted-text" aria-label="Accepted text">
              <div className="section-title">
                <h3>Rendered Bucket Text</h3>
                <span>{renderedEvents.length} rendered blocks</span>
              </div>
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
            </section>

            <form className="content-form" onSubmit={proposeContent}>
              <fieldset className="change-action-group" disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive}>
                <legend>Change action</legend>
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
              <label>
                Change target
                <select
                  disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive}
                  onChange={(event) => selectBaseEvent(event.target.value)}
                  value={selectedBaseEventId}
                >
                  <option value="">New content block</option>
                  {selectedEvents.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.id} [{getEventAction(event)}, {event.status}] {truncate(event.comment, 70)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {changeAction === 'Delete'
                  ? selectedTargetEvent && getEventAction(selectedTargetEvent) === 'Delete'
                    ? `Delete delete event ${selectedBaseEventId}`
                    : `Delete content from ${selectedBaseEventId}`
                  : selectedBaseEventId
                    ? `Revise content from ${selectedBaseEventId}`
                    : 'Add proposed content'}
                <textarea
                  disabled={Boolean(pendingEvent) || !canContribute || !selectedBucketIsActive || changeAction === 'Delete'}
                  onChange={(event) => setContentBody(event.target.value)}
                  placeholder={
                    pendingEvent
                      ? 'Accept or reject the active proposal before adding more content.'
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
                  !canContribute ||
                  !selectedBucketIsActive ||
                  Boolean(pendingEvent) ||
                  (changeAction !== 'Delete' && contentBody.trim().length < 10) ||
                  (changeAction !== 'Create' && !selectedBaseEventId) ||
                  contentComment.trim().length < 1
                }
                type="submit"
              >
                Propose content
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
                <h3>Event Log</h3>
                <span>{selectedEvents.length} events</span>
              </div>

              {selectedEvents.length ? (
                selectedEvents.map((event) => (
                  <article className="event-card" key={event.id}>
                    <div className="event-meta">
                      <span className="event-title">
                        <strong>{event.id}</strong>
                        {getEventAction(event) === 'Delete' ? (
                          <em>Deletes {event.baseEventId}</em>
                        ) : event.baseEventId ? (
                          <em>Revises {event.baseEventId}</em>
                        ) : (
                          <em>New block</em>
                        )}
                      </span>
                      <span className={`pill ${event.status.toLowerCase()}`}>{event.status}</span>
                    </div>
                    <div className="event-change">
                      <span>{getEventAction(event) === 'Delete' ? 'Deleted content' : 'Content change'}</span>
                      <MarkdownText text={event.body} />
                    </div>
                    <div className="event-comment">
                      <span>Comment</span>
                      <MarkdownText text={event.comment} />
                    </div>
                    <footer>
                      <span>
                        {event.author} · {formatDate(event.createdAt)}
                      </span>
                      {event.status === 'Proposed' ? (
                        <span className="decision-actions">
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
                        </span>
                      ) : (
                        <span>Decided {event.decidedAt ? formatDate(event.decidedAt) : ''}</span>
                      )}
                    </footer>
                  </article>
                ))
              ) : (
                <p className="empty">No events recorded for this bucket.</p>
              )}
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
