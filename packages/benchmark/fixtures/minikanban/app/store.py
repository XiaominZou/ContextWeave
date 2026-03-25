from __future__ import annotations

from app.models import Board, Task


class InMemoryStore:
    def __init__(self) -> None:
        self.boards: dict[int, Board] = {}
        self.tasks: dict[int, Task] = {}
        self._board_seq = 1
        self._task_seq = 1

    def create_board(self, name: str) -> Board:
        board = Board(id=self._board_seq, name=name)
        self.boards[board.id] = board
        self._board_seq += 1
        return board

    def get_board(self, board_id: int) -> Board | None:
        return self.boards.get(board_id)

    def delete_board(self, board_id: int) -> bool:
        if board_id not in self.boards:
            return False
        del self.boards[board_id]
        task_ids = [task.id for task in self.tasks.values() if task.board_id == board_id]
        for task_id in task_ids:
            del self.tasks[task_id]
        return True

    def create_task(self, board_id: int, title: str, status: str = "todo", tags: list[str] | None = None) -> Task:
        task = Task(
            id=self._task_seq,
            board_id=board_id,
            title=title,
            status=status,
            tags=list(tags or []),
        )
        self.tasks[task.id] = task
        self._task_seq += 1
        return task

    def get_task(self, task_id: int) -> Task | None:
        return self.tasks.get(task_id)

    def list_tasks(self, board_id: int, tag: str | None = None) -> list[Task]:
        tasks = [task for task in self.tasks.values() if task.board_id == board_id]
        if tag:
          return [task for task in tasks if tag in task.tags]
        return tasks

    def update_task(
        self,
        task_id: int,
        *,
        title: str | None = None,
        status: str | None = None,
        tags: list[str] | None = None,
    ) -> Task | None:
        task = self.tasks.get(task_id)
        if not task:
            return None
        if title is not None:
            task.title = title
        if status is not None:
            task.status = status
        if tags is not None:
            task.tags = list(tags)
        self.tasks[task_id] = task
        return task

    def delete_task(self, task_id: int) -> bool:
        if task_id not in self.tasks:
            return False
        del self.tasks[task_id]
        return True

    def board_stats(self, board_id: int) -> dict[str, int]:
        stats = {"todo": 0, "doing": 0, "done": 0}
        for task in self.tasks.values():
            if task.board_id == board_id and task.status in stats:
                stats[task.status] += 1
        return stats
