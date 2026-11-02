# Tic-Tac-Toe · Peer-to-Peer

A two-player, **real-time** Tic-Tac-Toe that runs entirely in the browser. Two
people on the same Wi-Fi (or on different networks) open the hosted page on two
different devices and play against each other.

There is **no backend and no build step** — the app is three static files
(`index.html`, `style.css`, `script.js`) served straight from GitHub Pages.
Networking uses [PeerJS](https://peerjs.com) to establish a **WebRTC data
channel** between the two browsers, so once the players are connected the game
data flows directly from device to device.

**Live URL:** <https://woteq-tools.github.io/tic-tac-toe-p2p/>

---

## How to play

### 1. The host creates a game

1. Open the live URL on your phone or laptop.
2. Tap **Create Game**.
3. A four-character room code appears, for example `H7KQ`, together with a
   shareable link (`https://<host>/?room=H7KQ`).
4. Tap **Copy link** and send it to your opponent — by text, chat or email. You
   can also just read the four-character code out loud.

The host plays **X** and always moves first.

### 2. The guest joins

Two ways to join:

- **Paste the link.** Opening it opens the page and joins the room
  automatically (`?room=CODE` deep link).
- **Type the code.** Tap **Join Game** and enter the four characters. The input
  uppercases automatically and ignores characters the game never uses.

The guest plays **O**.

### 3. Play

- Tap a square to place your mark. Only the squares you are allowed to play
  are tappable; the board locks itself when it is your opponent's turn.
- The host is the referee. It validates every move and broadcasts the whole
  board, so both screens always agree.
- A win highlights the winning line in place. A draw is reported as a draw.
- The scoreboard (X wins / O wins / draws) is kept for the session.

### 4. Play again

After a game ends, tap **Play again**. A rematch starts only once *both*
players have agreed, and the player who opens each round alternates — so the
first game is opened by X and the next one by O. The host is asked to confirm
when the guest requests a rematch.

### 5. Leaving

Tap **Leave game** at any time to return to the lobby. If your opponent
disconnects, both sides are shown a clear message and a **Back to lobby**
button.

---

## How it works

### Peer-to-peer with PeerJS

PeerJS provides the *signalling* that lets two browsers find each other:

1. The **host** creates a Peer with the id `ttt-<CODE>`, so the four-character
   room code maps directly onto a PeerJS peer id. If that id is already taken
   the server reports `unavailable-id`; the app then quietly generates a new
   code and retries, so you never see a collision.
2. The **guest** creates its own Peer and calls `peer.connect('ttt-<CODE>')`.
   PeerJS uses the free public signalling server to exchange the WebRTC offer,
   answer and ICE candidates.
3. Once the handshake completes, the two browsers hold a direct
   `RTCDataChannel` between them. From that point on the game moves over that
   channel — the signalling server is no longer involved in the game itself.

The signalling server only brokers the initial handshake; it never sees the
board.

### The host is authoritative

The host owns the game state and validates every move:

- The **guest** only ever sends `{ type: 'move', index }`.
- The **host** checks that it is the guest's turn, that the cell is empty and
  that the game is not already over. Only then does it apply the move.
- The host then broadcasts the complete state —
  `{ type: 'state', board, turn, winner, winLine, scores, round, rematch }` —
  and the guest renders exactly that.

Because the guest never writes to the board directly, the two screens cannot
drift apart and a modified client cannot cheat its way to a win.

### Keep-alive

A dropped data channel does not always announce itself (a closed phone tab, a
dropped Wi-Fi connection). Both players therefore ping each other every four
seconds; if a ping goes unanswered for fourteen seconds the connection is
treated as dead and the "opponent disconnected" screen appears.

### Other implementation notes

- **Room codes** use four characters from an alphabet that omits easily
  confused glyphs (`I`/`1`, `O`/`0`, `S`/`5`, `Z`/`2`), so a code can be read
  aloud over the phone without mistakes.
- **One guest per room.** A second player who tries to join an occupied room
  is rejected with a `full` message and a friendly error.
- **Every incoming message is validated** — shape, type and field ranges — so a
  malformed or hostile peer cannot corrupt the local game state.
- **Responsive and mobile-first.** The board is a square that scales to the
  viewport, tap targets are at least 48 px, text selection and double-tap zoom
  are disabled on the board, and each cell is a real `<button>` with an
  `aria-label` for screen readers.
- **Light and dark themes** follow the operating system's `prefers-color-scheme`
  setting, with a `prefers-reduced-motion` fallback for the animations.

### Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure: lobby, waiting room, board, disconnected screen. |
| `style.css` | All styling, light/dark themes, animations, responsive layout. |
| `script.js` | Game logic (pure functions), PeerJS networking and UI wiring. |

PeerJS itself is loaded from a CDN at a pinned version, with a Subresource
Integrity hash so the file cannot be tampered with:

```html
<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"
        integrity="sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR"
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
```

---

## Troubleshooting

**Both devices need internet access.** They must be able to reach the PeerJS
signalling server and GitHub Pages. Once the two browsers are connected, the
game data flows peer-to-peer and no longer touches any server — but the
initial handshake still requires internet.

**The two devices cannot connect even though they are on the same Wi-Fi.**
Some routers enable "AP isolation" / "client isolation", which stops devices
on the same wireless network from talking to each other directly. Try
disabling it in the router settings, or connect one device through a mobile
hotspot instead.

**"Room not found. Check the code and that the host is still waiting."**
The room code does not match any active room. Check that:

- the host is still on the "Waiting for opponent" screen and has **not**
  refreshed the page (a refresh frees the room code and creates a new one);
- the code was typed correctly — codes are four characters and never contain
  `I`, `O`, `S`, `Z`, `0`, `1`, `2` or `5`;
- the host's tab is still open and connected to the internet.

**The join seems to hang.** The app waits about ten seconds for the data
channel, then reports that the room could not be found. If the connection is
very slow, try again — a phone that has just switched networks often needs a
few seconds to discover its interface.

**The screen is frozen and the opponent seems to have gone.** The other player
may have closed the tab or lost their connection without a clean disconnect.
The keep-alive detects this within roughly fifteen seconds and shows the
"Opponent disconnected" screen.

**The browser blocks the game.** The app needs WebRTC, which requires a
secure context. `https://` (as used by GitHub Pages) is fine; opening
`index.html` directly from the filesystem with `file://` is not.

**A corporate or school network blocks the connection.** Some networks filter
WebRTC traffic. The app already uses Google's public STUN servers and
PeerJS's public TURN servers, but a network that blocks UDP entirely will
still prevent two devices from connecting.

---

## Local development

The project is completely static, so any static file server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

or

```bash
npx serve .
```

No npm dependencies, no bundler and no build step are required — the
repository contains exactly what is served.

## Licence

MIT.
