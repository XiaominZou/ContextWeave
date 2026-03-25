def test_create_board(client):
    response = client.post("/boards", json={"name": "Roadmap"})
    assert response.status_code == 200
    assert response.json()["name"] == "Roadmap"


def test_get_board(client):
    created = client.post("/boards", json={"name": "Roadmap"}).json()
    response = client.get(f"/boards/{created['id']}")
    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


def test_get_missing_board(client):
    response = client.get("/boards/999")
    assert response.status_code == 404


def test_delete_board(client):
    created = client.post("/boards", json={"name": "Roadmap"}).json()
    response = client.delete(f"/boards/{created['id']}")
    assert response.status_code == 200
    assert response.json()["ok"] is True
