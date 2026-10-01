# customer collector — REFERENCE ONLY (must never execute)
import requests

BASE = "https://api.example.com"
ENDPOINT = "/v1/events"
METHOD = "GET"

def fetch(cursor):
    headers = {"Authorization": "Bearer placeholder", "X-Request-Id": "demo"}
    params = {"cursor": cursor, "limit": 100}
    # response path: response["items"]
    # checkpoint: updated_at
    r = requests.get(BASE + ENDPOINT, headers=headers, params=params)
    return r.json()["items"]
