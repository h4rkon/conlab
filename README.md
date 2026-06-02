# conlab

Controlled collaboration platform prototype.

## Current MVP Slice

This first slice models buckets as the texts being created. Contributors do not edit a shared document directly. They record proposed content events inside a bucket, add a comment explaining the change, then accept or reject the active proposal before another content proposal can be added.

Events can create a new content block, revise a previous event, or delete a previous event from the rendered bucket text. Revisions and deletes never mutate old events; they add new history entries that can be accepted or rejected. Deleting a delete event invalidates that delete, which restores the previously removed content in the rendered view.

Implemented:

- create a bucket with name and description
- see all buckets
- open a bucket workspace
- propose one content event at a time with an explanatory comment
- select a previous event and propose a revision with a new comment
- select a previous event and propose a delete with a new comment
- delete a previous delete event to restore its target content
- accept or reject proposed content
- view rendered bucket text with the accepted events that produced it
- navigate the rendered bucket text backward and forward through accepted event history
- view the bucket event log with content changes and comments

## Run

```bash
npm install
npm run dev
```
