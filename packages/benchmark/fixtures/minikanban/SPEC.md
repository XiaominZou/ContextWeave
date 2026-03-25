# MiniKanban Benchmark Fixture

MiniKanban is the reference coding task used for the real benchmark path.

## Goal

The project is intentionally incomplete. An agent is expected to iteratively:
- understand the API surface
- implement missing routes and storage methods
- satisfy business constraints
- fix tests
- complete the README

## Tech Stack

- Python 3.11
- FastAPI
- Pydantic
- pytest

## Data Model

### Board
- `id`
- `name`

### Task
- `id`
- `board_id`
- `title`
- `status`
- `tags`

Valid statuses:
- `todo`
- `doing`
- `done`

## Required Routes

- `POST /boards`
- `GET /boards/{id}`
- `DELETE /boards/{id}`
- `POST /boards/{id}/tasks`
- `GET /boards/{id}/tasks`
- `GET /boards/{id}/stats`
- `PUT /tasks/{id}`
- `DELETE /tasks/{id}`

## Business Rules

- A board must exist before tasks can be created on it
- A task can have at most 5 tags
- Tags must be unique
- A `done` task cannot change title
- Deleting a board must cascade-delete its tasks
- Filtering by a missing tag returns an empty list, not an error

## Benchmark Intent

This fixture is designed to create a real multi-step implementation and debug flow.
It is not optimized for difficulty; it is optimized for producing meaningful context growth.
