import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Bucket = {
  id: string
  name: string
  description: string
}

type ContentEvent = {
  id: string
  bucketId: string
  author: string
  body: string
  comment: string
  status: 'Proposed' | 'Accepted' | 'Rejected'
  createdAt: string
  decidedAt?: string
}

const initialBuckets: Bucket[] = [
  {
    id: 'problem-space',
    name: 'Problem Space',
    description: 'Customer pains, market triggers, and reasons why this topic matters.',
  },
  {
    id: 'ambition',
    name: 'Ambition',
    description: 'Target outcomes, principles, and future-state statements.',
  },
  {
    id: 'questions',
    name: 'Questions',
    description: 'Open points that need clarification before the text can move forward.',
  },
]

const initialEvents: ContentEvent[] = [
  {
    id: 'EV-001',
    bucketId: 'problem-space',
    author: 'System',
    body: 'Multi-cloud should be framed around resilience, continuity, and control across provider, region, sovereign, and enterprise platform boundaries.',
    comment:
      'Seed proposal to test the acceptance loop before adding richer collaboration rules.',
    status: 'Proposed',
    createdAt: new Date().toISOString(),
  },
]

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function App() {
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets)
  const [events, setEvents] = useState<ContentEvent[]>(initialEvents)
  const [selectedBucketId, setSelectedBucketId] = useState(initialBuckets[0].id)
  const [bucketName, setBucketName] = useState('')
  const [bucketDescription, setBucketDescription] = useState('')
  const [contentBody, setContentBody] = useState('')
  const [contentComment, setContentComment] = useState('')

  const selectedBucket = buckets.find((bucket) => bucket.id === selectedBucketId) ?? buckets[0]

  const selectedEvents = useMemo(
    () => events.filter((event) => event.bucketId === selectedBucket?.id),
    [events, selectedBucket?.id],
  )

  const pendingEvent = selectedEvents.find((event) => event.status === 'Proposed')
  const acceptedEvents = selectedEvents.filter((event) => event.status === 'Accepted')
  const renderedEvents = [...acceptedEvents].reverse()

  function addBucket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = bucketName.trim()
    const description = bucketDescription.trim()

    if (!name || !description) {
      return
    }

    const bucket: Bucket = {
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Date.now()}`,
      name,
      description,
    }

    setBuckets((current) => [...current, bucket])
    setSelectedBucketId(bucket.id)
    setBucketName('')
    setBucketDescription('')
  }

  function proposeContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (
      !selectedBucket ||
      pendingEvent ||
      contentBody.trim().length < 10 ||
      contentComment.trim().length < 5
    ) {
      return
    }

    const nextNumber = String(events.length + 1).padStart(3, '0')
    const contentEvent: ContentEvent = {
      id: `EV-${nextNumber}`,
      bucketId: selectedBucket.id,
      author: 'You',
      body: contentBody.trim(),
      comment: contentComment.trim(),
      status: 'Proposed',
      createdAt: new Date().toISOString(),
    }

    setEvents((current) => [contentEvent, ...current])
    setContentBody('')
    setContentComment('')
  }

  function decideEvent(eventId: string, status: 'Accepted' | 'Rejected') {
    setEvents((current) =>
      current.map((event) =>
        event.id === eventId
          ? {
              ...event,
              status,
              decidedAt: new Date().toISOString(),
            }
          : event,
      ),
    )
  }

  return (
    <main className="app-shell">
      <aside className="bucket-panel" aria-label="Buckets">
        <div className="panel-header">
          <p className="eyebrow">Level 1 MVP</p>
          <h1>Contribution Ledger</h1>
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
          <button type="submit">Create bucket</button>
        </form>

        <nav className="bucket-list">
          {buckets.map((bucket) => {
            const bucketEvents = events.filter((event) => event.bucketId === bucket.id)
            const hasPending = bucketEvents.some((event) => event.status === 'Proposed')

            return (
              <button
                className={bucket.id === selectedBucket?.id ? 'bucket-item active' : 'bucket-item'}
                key={bucket.id}
                onClick={() => setSelectedBucketId(bucket.id)}
                type="button"
              >
                <span>
                  <strong>{bucket.name}</strong>
                  <small>{bucket.description}</small>
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
                <p>{selectedBucket.description}</p>
              </div>
              <span className={pendingEvent ? 'status pending' : 'status open'}>
                {pendingEvent ? 'Acceptance pending' : 'Open for content'}
              </span>
            </header>

            <section className="accepted-text" aria-label="Accepted text">
              <div className="section-title">
                <h3>Rendered Bucket Text</h3>
                <span>{renderedEvents.length} accepted</span>
              </div>
              {renderedEvents.length ? (
                renderedEvents.map((event) => (
                  <article className="rendered-change" key={event.id}>
                    <p>{event.body}</p>
                    <small>
                      Rendered from {event.id} · {event.comment}
                    </small>
                  </article>
                ))
              ) : (
                <p className="empty">No accepted content yet.</p>
              )}
            </section>

            <form className="content-form" onSubmit={proposeContent}>
              <label>
                Add proposed content
                <textarea
                  disabled={Boolean(pendingEvent)}
                  onChange={(event) => setContentBody(event.target.value)}
                  placeholder={
                    pendingEvent
                      ? 'Accept or reject the active proposal before adding more content.'
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
                  Boolean(pendingEvent) ||
                  contentBody.trim().length < 10 ||
                  contentComment.trim().length < 5
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
                      <strong>{event.id}</strong>
                      <span className={`pill ${event.status.toLowerCase()}`}>{event.status}</span>
                    </div>
                    <div className="event-change">
                      <span>Content change</span>
                      <p>{event.body}</p>
                    </div>
                    <div className="event-comment">
                      <span>Comment</span>
                      <p>{event.comment}</p>
                    </div>
                    <footer>
                      <span>
                        {event.author} · {formatDate(event.createdAt)}
                      </span>
                      {event.status === 'Proposed' ? (
                        <span className="decision-actions">
                          <button onClick={() => decideEvent(event.id, 'Rejected')} type="button">
                            Reject
                          </button>
                          <button onClick={() => decideEvent(event.id, 'Accepted')} type="button">
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
