# Reference bot

`simple_bot.py` plays a game on this server over the bot API: it holds one NDJSON
stream open and answers every `moveRequest` with two placements. `requests` is its only
dependency.

```bash
pip install requests
HEXO_TOKEN=hxo_... python3 simple_bot.py http://localhost:3001
```

Get the token from your account page, under bots. The server must run with
`BOT_API_ENABLED=true`; without it none of these paths exist.

The file is a **verbatim copy** from the API specification,
[TimmyBurn2/Hexo-Bot-Api](https://github.com/TimmyBurn2/Hexo-Bot-Api), where
`openapi.yaml` defines every path, event and error code this server answers. A fix it
needs belongs there, not in this copy.

Coordinates on the wire are htttx axial `q,r`; the server converts to its own `x,y`, so
a bot never sees HeXO's coordinate system. Replace `choose_move` with an engine and
nothing else changes.
