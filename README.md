# Tic-Tac-Toe · Peer-to-Peer

A real-time, two-player Tic-Tac-Toe that runs entirely in the browser.
Two people on the same Wi-Fi open the hosted page on two different devices
and play against each other.

There is **no server, no backend and no build step**. The two browsers talk
to each other directly over a WebRTC data channel using
[PeerJS](https://peerjs.com). The only third party involved is the free
public PeerJS signalling server, which is used once to introduce the two
peers; after that, the game data flows peer-to-peer.

---

## Live site

**https://woteq-tools.github.io/tic-tac-toe-p2p/**

---

## How to play

### 1. Create a game (host)

1. Open the live site and tap **Create Game**.
2. You get a **4-character room code** (for example `R6DA`) and a shareable
   link. Codes deliberately avoid characters that are easy to confuse when
   read aloud (`I`/`1`, `O`/`0`, `S`/`5`, `Z`/`2`).
3. Send the code — or tap **Copy link** and send the whole URL — to your
   opponent.
4. The page waits for an opponent to join.

### 2. Join a game (guest)

1. Open the live site on the second device.
2. Type the room code into the box (it uppercases as you type) and tap
   **Join Game**.
   * Alternatively, just open the shared link — the `?room=CODE` deep link
     joins the room automatically.
3. You are **O** and move second.

### 3. Play

- The host is **X** and moves first.
- Tap a cell to place your mark. The winning line is highlighted, and the
  result plus a running scoreboard (X wins / O wins / draws) is shown.
- When the round ends, tap **Play again**. The next round only starts once
  **both** players have agreed, and the player who starts alternates each
  round (X opens round 1, O opens round 2, and so on).
- **Leave game** returns you to the lobby and tells your opponent.

The page works in portrait on a phone and adapts to a desktop browser. It
follows your system's light/dark preference.

---

## How it works

### Peer-to-peer networking

Both peers register with PeerJS's default free public signalling server.
The signalling server is only used to exchange connection details; once the
WebRTC data channel is up, **every move travels directly between the two
devices**.

- The host creates a peer whose ID is `ttt-<CODE>`, so the room code maps
  directly onto the peer ID. If that ID is already taken, PeerJS reports
  `unavailable-id` and the host automatically picks a new code and retries.
- The guest connects to `ttt-<CODE>` with `peer.connect(...)`.
- ICE is configured with Google's public STUN servers
  (`stun:stun.l.google.com:19302` and `stun:stun1.l.google.com:19302`)
  together with PeerJS's public TURN fallback, so devices on different
  networks can still connect.

### The host is authoritative

The host owns the game. It validates every move and broadcasts the
resulting state; the guest only ever *asks* to play.

```
guest  -- { type: 'move', index }  -->  host
guest  <-- { type: 'state', board, turn, winner, winLine, scores } -- host
```

The guest never sends a board. It sends a cell index, and the host decides
whether that move is legal (correct turn, empty cell, game not over). This
keeps both clients in lockstep and makes it impossible for a guest to
tamper with the board or move out of turn. Every inbound message is checked
for shape and type before it is used, so a malformed or hostile peer cannot
corrupt the local state.

The host also enforces a **one guest per room** limit: a second player
connecting to an occupied room is told the room is full and disconnected.

### Keeping the connection honest

A WebRTC data channel does not always announce that the far end vanished —
a phone whose tab was killed or a device that dropped off Wi-Fi can go quiet
without a close frame. Both players therefore send a lightweight `ping`
every few seconds; if a ping goes unanswered for ~14 seconds the connection
is declared dead and the other player is shown a clear "opponent
disconnected" screen with a button back to the lobby.

---

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | Markup for the four screens (lobby, waiting, game, disconnected) |
| `style.css` | Mobile-first styling, CSS variables, light/dark via `prefers-color-scheme` |
| `script.js` | All the logic: UI helpers, pure game functions, networking, screen management |

No dependencies to install, no bundler, no `npm install`. PeerJS is loaded
from a CDN with a pinned version:

```html
<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
```

To run it locally, serve the folder over HTTP (opening the file directly
with `file://` will not work, because browsers restrict WebRTC there):

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

---

## Troubleshooting

**Both devices need internet access.** Both players must be able to reach
the PeerJS signalling server and to load the page from GitHub Pages. Only
the *setup* needs the signalling server — once the game is running, the
moves travel directly between the two devices.

**The devices cannot connect to each other.** If two devices on the same
Wi-Fi fail to connect, your router may have "AP isolation" / "client
isolation" enabled, which stops devices on the same network from talking to
each other directly. Try disabling it in the router settings, or use a
mobile hotspot instead. Moving one device onto cellular data is another
quick way to confirm this is the cause — the TURN fallback should then carry
the connection.

**"Room not found."** Check that the host is still sitting on the waiting
screen and has not refreshed the page. Refreshing creates a brand new room
with a new code, so the old code no longer exists. The host must also still
have a working internet connection for the room to stay registered.

**"That room is already full."** Only one guest can play in a room at a
time. Ask your opponent to leave first, or have the host start a fresh
game and share the new code.

**The connection drops during a game.** If the other player closes the tab
or loses network, the game ends with a "disconnected" message after the
keep-alive timeout. Create a new game to play again — room codes are not
reserved after the host leaves.
