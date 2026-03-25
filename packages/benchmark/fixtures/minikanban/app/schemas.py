from pydantic import BaseModel, Field


class CreateBoardRequest(BaseModel):
    name: str


class BoardResponse(BaseModel):
    id: int
    name: str


class CreateTaskRequest(BaseModel):
    title: str
    status: str = "todo"
    tags: list[str] = Field(default_factory=list)


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    status: str | None = None
    tags: list[str] | None = None


class TaskResponse(BaseModel):
    id: int
    board_id: int
    title: str
    status: str
    tags: list[str]


class StatsResponse(BaseModel):
    todo: int
    doing: int
    done: int
