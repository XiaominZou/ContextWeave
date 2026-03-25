from fastapi import APIRouter, HTTPException

from app.schemas import CreateTaskRequest, TaskResponse, UpdateTaskRequest
from app.store import InMemoryStore


VALID_STATUSES = {"todo", "doing", "done"}


def build_task_router(store: InMemoryStore) -> APIRouter:
    router = APIRouter()

    @router.post("/boards/{board_id}/tasks", response_model=TaskResponse)
    def create_task(board_id: int, request: CreateTaskRequest) -> TaskResponse:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        validate_tags(request.tags)
        if request.status not in VALID_STATUSES:
            raise HTTPException(status_code=422, detail="invalid status")
        task = store.create_task(board_id, request.title, request.status, request.tags)
        return TaskResponse.model_validate(task.model_dump())

    @router.put("/tasks/{task_id}", response_model=TaskResponse)
    def update_task(task_id: int, request: UpdateTaskRequest) -> TaskResponse:
        current = store.get_task(task_id)
        if not current:
            raise HTTPException(status_code=404, detail="task not found")

        next_title = request.title if request.title is not None else current.title
        next_status = request.status if request.status is not None else current.status
        next_tags = request.tags if request.tags is not None else current.tags

        if next_status not in VALID_STATUSES:
            raise HTTPException(status_code=422, detail="invalid status")
        validate_tags(next_tags)
        if current.status == "done" and request.title is not None and request.title != current.title:
            raise HTTPException(status_code=409, detail="done task title cannot change")

        updated = store.update_task(task_id, title=next_title, status=next_status, tags=next_tags)
        return TaskResponse.model_validate(updated.model_dump())

    @router.delete("/tasks/{task_id}")
    def delete_task(task_id: int) -> dict[str, bool]:
        deleted = store.delete_task(task_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="task not found")
        return {"ok": True}

    return router


def validate_tags(tags: list[str]) -> None:
    if len(tags) > 5:
        raise HTTPException(status_code=422, detail="too many tags")
    if len(set(tags)) != len(tags):
        raise HTTPException(status_code=422, detail="duplicate tags")
