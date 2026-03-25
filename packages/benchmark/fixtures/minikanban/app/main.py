from fastapi import FastAPI

from app.routes.boards import build_board_router
from app.routes.tasks import build_task_router
from app.store import InMemoryStore


store = InMemoryStore()
app = FastAPI(title="MiniKanban")
app.include_router(build_board_router(store))
app.include_router(build_task_router(store))
