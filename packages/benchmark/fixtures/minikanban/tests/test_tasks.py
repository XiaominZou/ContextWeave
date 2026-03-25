def test_create_task(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    response = client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v1"})
    assert response.status_code == 200
    assert response.json()["title"] == "Ship v1"


def test_create_task_requires_board(client):
    response = client.post("/boards/999/tasks", json={"title": "Ship v1"})
    assert response.status_code == 404


def test_update_task_status(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    task = client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v1"}).json()
    response = client.put(f"/tasks/{task['id']}", json={"status": "doing"})
    assert response.status_code == 200
    assert response.json()["status"] == "doing"


def test_done_title_cannot_change(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    task = client.post(
        f"/boards/{board['id']}/tasks",
        json={"title": "Ship v1", "status": "done"},
    ).json()
    response = client.put(f"/tasks/{task['id']}", json={"title": "Ship v2"})
    assert response.status_code == 409


def test_delete_task(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    task = client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v1"}).json()
    response = client.delete(f"/tasks/{task['id']}")
    assert response.status_code == 200
    assert response.json()["ok"] is True
