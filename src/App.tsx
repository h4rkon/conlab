import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type Bucket = {
  id: string
  name: string
  description: string
}

type Workspace = {
  version: 1
  buckets: Bucket[]
  events: ContentEvent[]
}

type GitHubRepo = {
  owner: string
  repo: string
}

type GitHubConnection = GitHubRepo & {
  repoUrl: string
  token: string
  branch: string
  useBranchInCommits: boolean
}

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
const CONNECTION_STORAGE_KEY = 'conlab.githubConnection'

const emptyWorkspace: Workspace = {
  version: 1,
  buckets: [],
  events: [],
}

function normalizeWorkspace(workspace?: Partial<Workspace>): Workspace {
  return {
    version: 1,
    buckets: [...(workspace?.buckets ?? [])],
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

function parseGitHubRepoUrl(repoUrl: string): GitHubRepo {
  const normalizedUrl = repoUrl.trim().replace(/\.git$/, '')
  const parsedUrl = new URL(normalizedUrl)
  const [owner, repo] = parsedUrl.pathname.split('/').filter(Boolean)

  if (parsedUrl.hostname !== 'github.com' || !owner || !repo) {
    throw new Error('Use a GitHub repo URL like https://github.com/owner/repo')
  }

  return { owner, repo }
}

async function githubRequest<T>(connection: GitHubConnection, path: string, init?: RequestInit) {
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
    const message = typeof details?.message === 'string' ? details.message : response.statusText
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

async function getDefaultBranch(connection: GitHubRepo & { repoUrl: string; token: string }) {
  const repo = await githubRequest<{ default_branch?: string }>(
    { ...connection, branch: 'main', useBranchInCommits: false },
    `/repos/${connection.owner}/${connection.repo}`,
  )

  return repo.default_branch || 'main'
}

async function loadWorkspaceFile(connection: GitHubConnection) {
  const file = await githubRequest<{ content: string; sha: string }>(
    connection,
    `/repos/${connection.owner}/${connection.repo}/contents/${WORKSPACE_FILE}?ref=${connection.branch}`,
  )

  return {
    workspace: JSON.parse(decodeBase64(file.content)) as Workspace,
    sha: file.sha,
  }
}

async function commitWorkspaceFile(
  connection: GitHubConnection,
  workspace: Workspace,
  message: string,
  sha?: string,
) {
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

  const result = await githubRequest<{ content?: { sha?: string } }>(
    connection,
    `/repos/${connection.owner}/${connection.repo}/contents/${WORKSPACE_FILE}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  )

  return result.content?.sha
}

async function loadOrInitializeWorkspace(connection: GitHubConnection) {
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

  return error.message === 'Not Found' || error.message === 'This repository is empty.'
}

function getStoredConnection() {
  const storedConnection = localStorage.getItem(CONNECTION_STORAGE_KEY)

  if (!storedConnection) {
    return undefined
  }

  try {
    return JSON.parse(storedConnection) as GitHubConnection
  } catch {
    localStorage.removeItem(CONNECTION_STORAGE_KEY)
    return undefined
  }
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

function App() {
  const [storedConnection] = useState(getStoredConnection)
  const [connection, setConnection] = useState<GitHubConnection | null>(null)
  const [repoUrl, setRepoUrl] = useState(storedConnection?.repoUrl ?? '')
  const [token, setToken] = useState(storedConnection?.token ?? '')
  const [branchInput, setBranchInput] = useState(
    storedConnection?.useBranchInCommits ? storedConnection.branch : '',
  )
  const [isConnecting, setIsConnecting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [events, setEvents] = useState<ContentEvent[]>([])
  const [selectedBucketId, setSelectedBucketId] = useState('')
  const [bucketName, setBucketName] = useState('')
  const [bucketDescription, setBucketDescription] = useState('')
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

    return workspace
  }

  async function loadConsistentWorkspace(activeConnection: GitHubConnection) {
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

  async function connectToGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setConnectionError('')
    setSaveError('')
    setIsConnecting(true)

    try {
      const repo = parseGitHubRepoUrl(repoUrl)
      const baseConnection = {
        ...repo,
        repoUrl: repoUrl.trim(),
        token: token.trim(),
      }
      const requestedBranch = branchInput.trim()
      const branch = requestedBranch || (await getDefaultBranch(baseConnection))
      const nextConnection: GitHubConnection = {
        ...baseConnection,
        branch,
        useBranchInCommits: Boolean(requestedBranch),
      }

      const loaded = await loadOrInitializeWorkspace(nextConnection)
      const workspace = normalizeWorkspace(loaded.workspace)
      const firstBucketId = workspace.buckets[0]?.id ?? ''
      applyLoadedWorkspace(loaded, firstBucketId)

      setConnection(nextConnection)
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(nextConnection))
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not connect to GitHub')
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
          if (attempt === 0 && error instanceof Error && error.message.includes('sha')) {
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

      setSaveError(error instanceof Error ? error.message : 'Could not save to GitHub')
      return false
    } finally {
      setIsSaving(false)
    }
  }

  function disconnectGitHub() {
    localStorage.removeItem(CONNECTION_STORAGE_KEY)
    setConnection(null)
    setRepoUrl('')
    setToken('')
    setBranchInput('')
    setBuckets([])
    setEvents([])
    setSelectedBucketId('')
    syncedWorkspaceRef.current = null
  }

  function selectBucket(bucketId: string) {
    setSelectedBucketId(bucketId)
    setChangeAction('Create')
    setSelectedBaseEventId('')
    setContentBody('')
    setContentComment('')
    setHistoryAcceptedCount(countAcceptedEvents(events, bucketId))
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

    const bucket: Bucket = {
      id: generateBucketId(name),
      name,
      description,
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
    setSelectedBucketId(bucket.id)
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
      pendingEvent ||
      (changeAction !== 'Delete' && contentBody.trim().length < 10) ||
      (changeAction !== 'Create' && !selectedBaseEventId) ||
      contentComment.trim().length < 1
    ) {
      return
    }

    const contentEvent: ContentEvent = {
      id: generateEventId(),
      bucketId: selectedBucket.id,
      author: 'You',
      body: contentBody.trim(),
      comment: contentComment.trim(),
      action: changeAction,
      baseEventId: selectedBaseEventId || undefined,
      status: 'Proposed',
      createdAt: new Date().toISOString(),
    }

    const saved = await saveWorkspace(`Propose ${changeAction.toLowerCase()} ${contentEvent.id}`, (workspace) => {
      const bucketExists = workspace.buckets.some((bucket) => bucket.id === selectedBucket.id)

      if (!bucketExists) {
        throw new Error('The selected bucket no longer exists. Latest workspace was loaded.')
      }

      if (workspace.events.some((event) => event.bucketId === selectedBucket.id && event.status === 'Proposed')) {
        throw new Error('This bucket already has a proposed event in the latest workspace.')
      }

      if (
        contentEvent.baseEventId &&
        !workspace.events.some((event) => event.id === contentEvent.baseEventId)
      ) {
        throw new Error('The selected target event no longer exists in the latest workspace.')
      }

      return {
        ...workspace,
        events: [contentEvent, ...workspace.events],
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

  if (!connection) {
    return (
      <main className="setup-shell">
        <section className="setup-panel">
          <p className="eyebrow">Install Workspace</p>
          <h1>Connect a GitHub repo</h1>
          <p>
            Paste an empty or existing GitHub repository URL and a PAT with repository contents
            read/write access. The app will create or load {WORKSPACE_FILE}.
          </p>

          <form className="setup-form" onSubmit={connectToGitHub}>
            <label>
              GitHub repo URL
              <input
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                value={repoUrl}
              />
            </label>
            <label>
              GitHub PAT
              <input
                onChange={(event) => setToken(event.target.value)}
                placeholder="ghp_... or github_pat_..."
                type="password"
                value={token}
              />
            </label>
            <label>
              Branch
              <input
                onChange={(event) => setBranchInput(event.target.value)}
                placeholder="Leave blank for default branch"
                value={branchInput}
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
    <main className="app-shell">
      <aside className="bucket-panel" aria-label="Buckets">
        <div className="panel-header">
          <p className="eyebrow">Level 1 MVP</p>
          <h1>Contribution Ledger</h1>
          <p className="repo-link">
            {connection.owner}/{connection.repo} · {connection.branch}
          </p>
          <button className="secondary-button" onClick={disconnectGitHub} type="button">
            Disconnect
          </button>
          {isSaving ? <p className="save-state">Saving to GitHub...</p> : null}
          {saveError ? <p className="error-text">{saveError}</p> : null}
        </div>

        <form className="bucket-form" onSubmit={addBucket}>
          <label>
            Bucket name
            <input
              value={bucketName}
              onChange={(event) => setBucketName(event.target.value)}
              placeholder="e.g. Customer Signals"
            />
          </label>
          <label>
            Description
            <textarea
              value={bucketDescription}
              onChange={(event) => setBucketDescription(event.target.value)}
              placeholder="What text are we trying to create here?"
              rows={3}
            />
          </label>
          <button disabled={isSaving} type="submit">Create bucket</button>
        </form>

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
                <em>{hasPending ? 'Needs acceptance' : `${bucketEvents.length} events`}</em>
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
                {pendingEvent ? 'Acceptance pending' : 'Open for content'}
              </span>
            </header>

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
              <fieldset className="change-action-group" disabled={Boolean(pendingEvent)}>
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
                  disabled={Boolean(pendingEvent)}
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
                  disabled={Boolean(pendingEvent) || changeAction === 'Delete'}
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
                  disabled={Boolean(pendingEvent)}
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
                  Boolean(pendingEvent) ||
                  (changeAction !== 'Delete' && contentBody.trim().length < 10) ||
                  (changeAction !== 'Create' && !selectedBaseEventId) ||
                  contentComment.trim().length < 1
                }
                type="submit"
              >
                Propose content
              </button>
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
                            disabled={isSaving}
                            onClick={() => decideEvent(event.id, 'Rejected')}
                            type="button"
                          >
                            Reject
                          </button>
                          <button
                            disabled={isSaving}
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
