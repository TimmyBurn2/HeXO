#!/usr/bin/env python3
"""Reference HeXO bot: hold the stream open, answer every moveRequest.

    pip install requests
    HEXO_TOKEN=hxo_... python3 simple_bot.py [base-url]

Coordinates are htttx axial q,r throughout; the server converts to its own
axial x,y, so a bot never sees HeXO's coordinate system. Replace choose_move
with a real engine and nothing else here has to change.
"""

import json
import os
import sys

PLACEMENT_RADIUS = 8


def distance(a, b):
    """Hex distance between two axial coordinates."""
    dq, dr = a[0] - b[0], a[1] - b[1]
    return (abs(dq) + abs(dq + dr) + abs(dr)) // 2


def choose_move(board):
    """Two free cells, nearest to the stones already on the board.

    Legal but weak: it never blocks and never builds a line. `board` is an
    htttx Board, the return value is the `pieces` list of an htttx Move.
    """
    taken = {(cell["q"], cell["r"]) for cell in board["cells"]}
    if not taken:
        raise ValueError("empty board: the origin stone is placed before a bot moves")
    candidates = set()
    for stone in taken:
        for dq in range(-PLACEMENT_RADIUS, PLACEMENT_RADIUS + 1):
            for dr in range(-PLACEMENT_RADIUS, PLACEMENT_RADIUS + 1):
                cell = (stone[0] + dq, stone[1] + dr)
                if cell not in taken and distance(cell, stone) <= PLACEMENT_RADIUS:
                    candidates.add(cell)
    ranked = sorted(
        candidates,
        key=lambda c: (min(distance(c, s) for s in taken), abs(c[0]), abs(c[1]), c),
    )
    return [{"q": q, "r": r} for q, r in ranked[:2]]


class SimpleBot:
    def __init__(self, base_url, token):
        import requests  # lazy, so stateless_server.py needs no third-party deps

        self.base_url = base_url.rstrip("/")
        self.http = requests.Session()
        self.http.headers["Authorization"] = f"Bearer {token}"

    def run(self):
        """Read the event stream until it closes, one line at a time."""
        # open=1: take challenges for as long as this connection is held.
        url = f"{self.base_url}/api/bot/stream?open=1"
        stream = self.http.get(url, stream=True, timeout=None)
        stream.raise_for_status()
        for line in stream.iter_lines(decode_unicode=True):
            if not line:
                continue  # keepalive
            self.handle(json.loads(line))

    def handle(self, event):
        kind = event["type"]
        if kind == "moveRequest":
            self.play(event["gameId"], event["request"])
        elif kind == "challenge":
            self.post(f"/api/bot/challenge/{event['challenge']['challengeId']}/accept")
        elif kind == "gameStart":
            self.log(f"game {event['gameId']} started, playing {event['side']}")
        elif kind == "gameFinish":
            self.log(f"game {event['gameId']} over: {event['reason']}, winner {event['winner']}")

    def play(self, game_id, request):
        body = {"move": {"pieces": choose_move(request["board"])}}
        if "request_id" in request:
            body["request_id"] = request["request_id"]
        response = self.post(f"/api/bot/game/{game_id}/move", body)
        if response.status_code == 400:
            # Illegal move. A retry is allowed and the clock keeps running, but
            # choose_move is deterministic, so it would repeat the same move.
            self.log(f"move rejected: {response.json()}")

    def post(self, path, body=None):
        return self.http.post(f"{self.base_url}{path}", json=body, timeout=30)

    @staticmethod
    def log(message):
        print(message, file=sys.stderr, flush=True)


if __name__ == "__main__":
    bot_token = os.environ.get("HEXO_TOKEN")
    if not bot_token:
        sys.exit("set HEXO_TOKEN to a bot-account token")
    host = sys.argv[1] if len(sys.argv) > 1 else "https://hexo.did.science"
    SimpleBot(host, bot_token).run()
