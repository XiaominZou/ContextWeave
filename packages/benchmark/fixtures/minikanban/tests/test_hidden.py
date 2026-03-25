def test_add_duplicate_tag(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    response = client.post(
        f"/boards/{board['id']}/tasks",
        json={"title": "Ship v1", "tags": ["api", "api"]},
    )
    assert response.status_code == 422


def test_add_too_many_tags(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    response = client.post(
        f"/boards/{board['id']}/tasks",
        json={"title": "Ship v1", "tags": ["a", "b", "c", "d", "e", "f"]},
    )
    assert response.status_code == 422


def test_delete_board_cascades_tasks(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    task = client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v1"}).json()
    client.delete(f"/boards/{board['id']}")
    response = client.delete(f"/tasks/{task['id']}")
    assert response.status_code == 404


def test_filter_missing_tag_returns_empty_list(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v1", "tags": ["api"]})
    response = client.get(f"/boards/{board['id']}/tasks?tag=missing")
    assert response.status_code == 200
    assert response.json() == []
