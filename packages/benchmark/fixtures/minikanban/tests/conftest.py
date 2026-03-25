import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import app, store


@pytest.fixture(autouse=True)
def reset_store():
    store.boards.clear()
    store.tasks.clear()
    store._board_seq = 1
    store._task_seq = 1


@pytest.fixture()
def client():
    return TestClient(app)
