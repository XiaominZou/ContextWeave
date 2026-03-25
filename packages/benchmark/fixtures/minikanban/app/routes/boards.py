from fastapi import APIRouter, HTTPException

from app.schemas import BoardResponse, CreateBoardRequest, StatsResponse, TaskResponse
from app.store import InMemoryStore


def build_board_router(store: InMemoryStore) -> APIRouter:
    router = APIRouter()

    @router.post("/boards", response_model=BoardResponse)
    def create_board(request: CreateBoardRequest) -> BoardResponse:
        board = store.create_board(request.name)
        return BoardResponse.model_validate(board.model_dump())

    @router.get("/boards/{board_id}", response_model=BoardResponse)
    def get_board(board_id: int) -> BoardResponse:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        return BoardResponse.model_validate(board.model_dump())

    @router.delete("/boards/{board_id}")
    def delete_board(board_id: int) -> dict[str, bool]:
        deleted = store.delete_board(board_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="board not found")
        return {"ok": True}

    @router.get("/boards/{board_id}/tasks", response_model=list[TaskResponse])
    def list_tasks(board_id: int, tag: str | None = None) -> list[TaskResponse]:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        return [TaskResponse.model_validate(task.model_dump()) for task in store.list_tasks(board_id, tag=tag)]

    @router.get("/boards/{board_id}/stats", response_model=StatsResponse)
    def board_stats(board_id: int) -> StatsResponse:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        return StatsResponse.model_validate(store.board_stats(board_id))

    return router
