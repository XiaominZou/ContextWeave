from pydantic import BaseModel, Field


class Board(BaseModel):
    id: int
    name: str


class Task(BaseModel):
    id: int
    board_id: int
    title: str
    status: str = "todo"
    tags: list[str] = Field(default_factory=list)
