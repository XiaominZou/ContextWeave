def test_list_tasks(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v1", "tags": ["api"]})
    response = client.get(f"/boards/{board['id']}/tasks")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_filter_tasks_by_tag(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v1", "tags": ["api"]})
    client.post(f"/boards/{board['id']}/tasks", json={"title": "Ship v2", "tags": ["ui"]})
    response = client.get(f"/boards/{board['id']}/tasks?tag=api")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["title"] == "Ship v1"


def test_stats(client):
    board = client.post("/boards", json={"name": "Roadmap"}).json()
    client.post(f"/boards/{board['id']}/tasks", json={"title": "T1", "status": "todo"})
    client.post(f"/boards/{board['id']}/tasks", json={"title": "T2", "status": "doing"})
    client.post(f"/boards/{board['id']}/tasks", json={"title": "T3", "status": "done"})
    response = client.get(f"/boards/{board['id']}/stats")
    assert response.status_code == 200
    assert response.json() == {"todo": 1, "doing": 1, "done": 1}
