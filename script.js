/* ==========================================================================
 * Tic-Tac-Toe · Peer-to-Peer
 * --------------------------------------------------------------------------
 * Two players on two devices play over a WebRTC data channel (PeerJS).
 *
 * Architecture: the HOST is authoritative. It owns the board, validates every
 * move and broadcasts the full game state. The GUEST only ever sends
 * { type: 'move', index } and renders whatever state the host sends back.
 * That keeps both clients in sync and stops a cheating guest from editing
 * the board directly.
 *
 * Sections:
 *   1. Constants
 *   2. State
 *   3. UI helpers
 *   4. Game logic (pure functions)
 *   5. Networking
 *   6. Screen / flow management
 *   7. Event wiring
 * ========================================================================== */

'use strict';

(function () {

  /* ======================================================================
   * 1. Constants
   * ==================================================================== */

  /** PeerJS peer-id prefix. The room code maps directly onto the peer id. */
  const PEER_PREFIX = 'ttt-';

  /**
   * Room-code alphabet. Deliberately omits characters that are easily
   * confused with one another so codes can be read aloud over a phone call
   * without mistakes: I/O/S/Z and 0/1/2/5 are left out.
   */
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY346789';
  const ROOM_LENGTH = 4;

  /** How long we wait for a P2P data channel before giving up on a join. */
  const CONNECT_TIMEOUT_MS = 10000;

  /**
   * Keep-alive timing. A data channel does not always announce that the
   * other side vanished (a closed phone tab, a dropped Wi-Fi connection),
   * so both players ping each other. If a ping goes unanswered for
   * HEARTBEAT_TIMEOUT_MS the connection is considered dead.
   */
  const HEARTBEAT_INTERVAL_MS = 4000;
  const HEARTBEAT_TIMEOUT_MS = 14000;

  /**
   * ICE servers. PeerJS's own defaults already list one Google STUN server
   * plus a pair of public TURN servers; supplying `config` REPLACES that
   * whole set, so we restate it here and add the second Google STUN server.
   * Keeping the TURN fallback matters: without it two devices on different
   * networks (e.g. Wi-Fi vs cellular) frequently fail to connect.
   */
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
      username: 'peerjs',
      credential: 'peerjsp'
    }
  ];

  /** All eight winning lines, as board indices. */
  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],   // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8],   // columns
    [0, 4, 8], [2, 4, 6]              // diagonals
  ];

  const MARKS = ['X', 'O'];

  /* ======================================================================
   * 2. State
   * ==================================================================== */

  /** Mutable application state. Everything the UI renders comes from here. */
  const state = {
    role: null,            // 'host' | 'guest'
    myMark: null,          // 'X' (host) | 'O' (guest)
    peer: null,            // PeerJS Peer instance
    conn: null,            // PeerJS DataConnection to the opponent
    code: null,            // 4-character room code
    board: emptyBoard(),   // array of 9: null | 'X' | 'O'
    turn: 'X',             // whose turn it is
    winner: null,          // null | 'X' | 'O'
    winLine: null,         // null | array of 3 winning indices
    scores: { X: 0, O: 0, draws: 0 },
    round: 1,              // increments on every rematch
    rematchRound: 1,      // the round we last saw, to detect a new round
    gameOver: false,
    pendingMove: false,    // guest: a move is in flight, waiting for the host
    hostInviteOpen: false, // host: opponent asked for a rematch
    // Who has asked for a rematch. The host owns the authoritative copy;
    // the guest mirrors the host's half from the state broadcast.
    rematch: { host: false, guest: false }
  };

  /* ======================================================================
   * 3. UI helpers
   * ==================================================================== */

  const $ = (selector) => document.querySelector(selector);

  const el = {
    screens: {
      lobby: $('#screen-lobby'),
      host: $('#screen-host'),
      game: $('#screen-game'),
      disconnected: $('#screen-disconnected')
    },
    btnCreate: $('#btn-create'),
    btnJoin: $('#btn-join'),
    inputCode: $('#input-code'),
    lobbyError: $('#lobby-error'),
    hostCode: $('#host-code'),
    hostTitle: $('#host-title'),
    hostSub: $('#host-sub'),
    hostStatus: $('#host-status'),
    shareLink: $('#share-link'),
    btnCopy: $('#btn-copy'),
    copyNote: $('#copy-note'),
    btnCancelHost: $('#btn-cancel-host'),
    badgeMark: $('#badge-mark'),
    badgeCode: $('#badge-code'),
    connStatus: $('#conn-status'),
    turnLabel: $('#turn-label'),
    board: $('#board'),
    cells: Array.from(document.querySelectorAll('.cell')),
    result: $('#result'),
    scoreX: $('#score-x'),
    scoreO: $('#score-o'),
    scoreDraws: $('#score-draws'),
    btnRematch: $('#btn-rematch'),
    btnLeave: $('#btn-leave'),
    rematchInvite: $('#rematch-invite'),
    btnRematchAccept: $('#btn-rematch-accept'),
    btnRematchDecline: $('#btn-rematch-decline'),
    discTitle: $('#disc-title'),
    discMsg: $('#disc-msg'),
    btnBackLobby: $('#btn-back-lobby')
  };

  /** Show exactly one screen. */
  function showScreen(name) {
    for (const [key, node] of Object.entries(el.screens)) {
      node.hidden = key !== name;
    }
  }

  /** Show a dismissable error on the lobby screen. */
  function showLobbyError(message) {
    el.lobbyError.textContent = message;
    el.lobbyError.hidden = false;
    // Restart the shake animation even if the same message is shown twice.
    el.lobbyError.style.animation = 'none';
    void el.lobbyError.offsetHeight;
    el.lobbyError.style.animation = '';
  }

  function clearLobbyError() {
    el.lobbyError.hidden = true;
    el.lobbyError.textContent = '';
  }

  /** Update the connection-status pill. */
  function setConnectionStatus(status, text) {
    el.connStatus.dataset.state = status;
    el.connStatus.textContent = text;
  }

  /** Screen-reader friendly description of a board cell. */
  function cellLabel(index, mark) {
    const row = Math.floor(index / 3) + 1;
    const col = (index % 3) + 1;
    return `Row ${row}, column ${col}, ${mark ? mark : 'empty'}`;
  }

  /* ======================================================================
   * 4. Game logic — pure functions (no DOM, no network)
   * ==================================================================== */

  /** A fresh, empty board. */
  function emptyBoard() {
    return [null, null, null, null, null, null, null, null, null];
  }

  /**
   * Determine the winner of a board.
   * @param {Array} board array of 9 cells, each null | 'X' | 'O'
   * @returns {{winner: string|null, line: number[]|null}}
   */
  function checkWinner(board) {
    if (!Array.isArray(board)) return { winner: null, line: null };
    for (const line of WIN_LINES) {
      const [a, b, c] = line;
      const mark = board[a];
      if (mark && mark === board[b] && mark === board[c]) {
        return { winner: mark, line: line.slice() };
      }
    }
    return { winner: null, line: null };
  }

  /** True when every cell is taken. */
  function isBoardFull(board) {
    return board.every((cell) => cell !== null && cell !== undefined);
  }

  /**
   * Apply a move, returning a NEW board (the original is never mutated).
   * @returns {Array} the updated board
   */
  function applyMove(board, index, mark) {
    const next = board.slice();
    next[index] = mark;
    return next;
  }

  /**
   * Who opens the given round. X (the host) opens round 1, then the start
   * alternates with every rematch.
   */
  function starterForRound(round) {
    return round % 2 === 1 ? 'X' : 'O';
  }

  /** The opponent of a mark. */
  function otherMark(mark) {
    return mark === 'X' ? 'O' : 'X';
  }

  /* ======================================================================
   * 5. Networking
   * ==================================================================== */

  /**
   * Parse and validate an incoming message.
   * Every message is checked for shape and type before it is used, so a
   * malformed or hostile peer can never corrupt local state.
   * @returns {object|null} the validated message, or null if it is invalid
   */
  function parseMessage(raw) {
    let data = raw;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (err) {
        return null;
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof data.type !== 'string') return null;

    switch (data.type) {
      case 'move':
        return isValidMove(data) ? data : null;

      case 'state':
        return isValidState(data) ? data : null;

      case 'rematch-request':
        return data;

      case 'rematch-declined':
        return data;

      case 'ping':
      case 'pong':
        return data;

      case 'full':
        return data;

      default:
        return null;
    }
  }

  /** A move message must carry an integer index inside the board. */
  function isValidMove(msg) {
    return Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 9;
  }

  /** A state message must describe a coherent 3x3 board. */
  function isValidState(msg) {
    if (!Array.isArray(msg.board) || msg.board.length !== 9) return false;
    if (!msg.board.every((c) => c === null || MARKS.indexOf(c) !== -1)) return false;
    if (MARKS.indexOf(msg.turn) === -1) return false;
    if (msg.winner !== null && MARKS.indexOf(msg.winner) === -1) return false;

    if (msg.winLine !== null) {
      if (!Array.isArray(msg.winLine) || msg.winLine.length !== 3) return false;
      if (!msg.winLine.every((i) => Number.isInteger(i) && i >= 0 && i < 9)) return false;
    }

    if (!msg.scores || typeof msg.scores !== 'object') return false;
    for (const key of ['X', 'O', 'draws']) {
      if (!Number.isFinite(msg.scores[key])) return false;
    }

    if (!Number.isInteger(msg.round) || msg.round < 1) return false;

    // The rematch flags are optional, but if present they must be sane.
    if (msg.rematch !== undefined) {
      if (!msg.rematch || typeof msg.rematch !== 'object') return false;
      if (typeof msg.rematch.host !== 'boolean') return false;
      if (typeof msg.rematch.guest !== 'boolean') return false;
    }
    return true;
  }

  /** Send a JSON message over the data channel, if it is open. */
  function sendToPeer(message) {
    if (!state.conn || !state.conn.open) return false;
    try {
      state.conn.send(message);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---------------------------- HEARTBEAT ---------------------------- */

  let heartbeatTimer = null;
  let lastPeerSeen = 0;

  /**
   * Start the keep-alive loop. We ping the opponent every few seconds and
   * treat a long silence as a dead connection. Without this a player whose
   * browser is killed or who loses network would leave the other one
   * staring at a frozen board.
   */
  function startHeartbeat() {
    stopHeartbeat();
    lastPeerSeen = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!state.conn || !state.conn.open) return;
      sendToPeer({ type: 'ping' });
      if (Date.now() - lastPeerSeen > HEARTBEAT_TIMEOUT_MS) {
        handleDisconnect(
          'The connection to your opponent was lost.',
          'Connection lost'
        );
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** The opponent is alive: reset the silence timer. */
  function notePeerAlive() {
    lastPeerSeen = Date.now();
  }

  /** Build the peer options: default PeerJS server + explicit STUN servers. */
  function peerOptions() {
    return {
      debug: 0,
      config: { iceServers: ICE_SERVERS }
    };
  }

  /** Generate a random 4-character room code. */
  function generateRoomCode() {
    let code = '';
    const values = new Uint32Array(ROOM_LENGTH);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(values);
    } else {
      for (let i = 0; i < ROOM_LENGTH; i++) {
        values[i] = Math.floor(Math.random() * 0xffffffff);
      }
    }
    for (let i = 0; i < ROOM_LENGTH; i++) {
      code += ROOM_ALPHABET[values[i] % ROOM_ALPHABET.length];
    }
    return code;
  }

  /**
   * Tear down the peer and the data channel.
   *
   * The references are cleared *before* the channel is closed. PeerJS emits
   * the `close` event synchronously from `close()`, and our close handler
   * compares `state.conn` against the connection it was bound to — clearing
   * first means a deliberate teardown is not mistaken for the opponent
   * hanging up (which would flash the "disconnected" screen).
   */
  function cleanupPeer() {
    stopHeartbeat();
    const conn = state.conn;
    const peer = state.peer;
    state.conn = null;
    state.peer = null;
    if (conn) {
      try { conn.close(); } catch (err) { /* ignore */ }
    }
    if (peer) {
      try { peer.destroy(); } catch (err) { /* ignore */ }
    }
  }

  /* ======================================================================
   * 6. Screen / flow management
   * ==================================================================== */

  /* ---------------------------- HOST ---------------------------------- */

  let hostCreateAttempts = 0;
  const MAX_HOST_CREATE_ATTEMPTS = 5;

  /**
   * Create the room: pick a code, register the peer id `ttt-<CODE>` and
   * wait for an opponent to connect. If the code is already taken the
   * PeerJS server reports `unavailable-id`; we then pick a new code and
   * try again.
   */
  function hostCreateGame() {
    clearLobbyError();
    showScreen('host');
    hostCreateAttempts = 0;
    createHostPeer();
  }

  function createHostPeer() {
    if (hostCreateAttempts >= MAX_HOST_CREATE_ATTEMPTS) {
      el.hostStatus.textContent = 'Could not create a room. Please try again.';
      showLobbyError('Could not create a room right now. Please try again.');
      showScreen('lobby');
      return;
    }
    hostCreateAttempts++;

    const code = generateRoomCode();
    state.role = 'host';
    state.myMark = 'X';
    state.code = code;

    el.hostCode.textContent = code;
    el.shareLink.value = buildShareLink(code);
    el.hostTitle.textContent = 'Waiting for opponent';
    el.hostSub.textContent = 'Send them this code or link.';
    el.hostStatus.textContent = 'Waiting for an opponent to join…';

    const peer = new Peer(PEER_PREFIX + code, peerOptions());
    state.peer = peer;

    peer.on('open', () => {
      el.hostStatus.textContent = 'Waiting for an opponent to join…';
    });

    peer.on('connection', (conn) => handleIncomingConnection(conn));

    peer.on('error', (err) => {
      const type = err && err.type;

      if (type === 'unavailable-id') {
        // Someone already owns this code: pick a fresh one and retry.
        try { peer.destroy(); } catch (e) { /* ignore */ }
        state.peer = null;
        createHostPeer();
        return;
      }

      if (type === 'browser-incompatible') {
        el.hostStatus.textContent = 'This browser does not support WebRTC.';
        showLobbyError('This browser does not support WebRTC, so it cannot play.');
        showScreen('lobby');
        return;
      }

      if (state.role === 'host' && !state.conn) {
        el.hostStatus.textContent = 'Could not reach the PeerJS server. Check your internet connection.';
      }
    });
  }

  /**
   * A guest connected to us. Only one guest is allowed per room; anyone
   * else is told the room is full.
   */
  function handleIncomingConnection(conn) {
    hardenConnection(conn);

    // A slot is already taken. Note that we check for the *presence* of a
    // connection rather than `conn.open`: a second guest arriving while the
    // first is still negotiating must not be able to claim the slot.
    if (state.conn) {
      rejectConnection(conn);
      return;
    }

    state.conn = conn;

    conn.on('open', () => {
      setConnectionStatus('connected', 'Connected');
      showScreen('game');
      resetRound(1);
      // Push the authoritative state to the new opponent.
      broadcastState();
      startHeartbeat();
    });

    conn.on('data', (raw) => {
      const msg = parseMessage(raw);
      if (!msg) return;
      notePeerAlive();
      if (msg.type === 'move') handleGuestMove(msg.index);
      else if (msg.type === 'rematch-request') hostReceiveRematchRequest();
      else if (msg.type === 'ping') sendToPeer({ type: 'pong' });
    });

    conn.on('close', () => {
      if (state.conn !== conn) return; // a superseded connection
      state.conn = null;
      if (state.role !== 'host') return;
      handleDisconnect('Your opponent left the game.', 'Opponent disconnected');
    });

    conn.on('error', () => {
      if (state.conn !== conn) return;
      state.conn = null;
      if (state.role !== 'host') return;
      handleDisconnect('The connection to your opponent was lost.', 'Connection lost');
    });
  }

  /**
   * Turn away a second player. The data channel is not open yet at this
   * point, so we have to wait for `open` before the message can be sent —
   * PeerJS silently discards data sent on a channel that is not yet open.
   * We then close the channel a moment later so the message is not lost.
   */
  function rejectConnection(conn) {
    conn.on('open', () => {
      try {
        conn.send({ type: 'full' });
      } catch (err) {
        /* ignore */
      }
      setTimeout(() => {
        try { conn.close(); } catch (err) { /* ignore */ }
      }, 150);
    });
  }

  /**
   * Validate and apply a move proposed by the guest. The host is the only
   * authority on the board.
   */
  function handleGuestMove(index) {
    // The state is always broadcast back, even for an illegal move: the
    // guest uses it to re-sync and to clear its "move in flight" flag.
    if (!state.gameOver &&
        state.turn === 'O' &&
        state.board[index] === null &&
        Number.isInteger(index) && index >= 0 && index < 9) {
      state.board = applyMove(state.board, index, 'O');
      settleRound();
    }
    // Repaint the host's own board: the guest's move is reflected in our
    // state, so our screen has to follow it.
    render();
    broadcastState();
  }

  /** Check the board for a winner / draw and update the scoreboard. */
  function settleRound() {
    const { winner, line } = checkWinner(state.board);
    if (winner) {
      state.winner = winner;
      state.winLine = line;
      state.gameOver = true;
      state.scores[winner] += 1;
    } else if (isBoardFull(state.board)) {
      state.gameOver = true;
      state.scores.draws += 1;
    } else {
      state.turn = otherMark(state.turn);
    }
  }

  /** Send the complete authoritative state to the guest. */
  function broadcastState() {
    sendToPeer({
      type: 'state',
      board: state.board.slice(),
      turn: state.turn,
      winner: state.winner,
      winLine: state.winLine,
      scores: {
        X: state.scores.X,
        O: state.scores.O,
        draws: state.scores.draws
      },
      round: state.round,
      rematch: {
        host: state.rematch.host,
        guest: state.rematch.guest
      }
    });
  }

  /* ---------------------------- REMATCH ------------------------------- */
  /**
   * A rematch needs agreement from both players. The host coordinates: it
   * tracks a "wants a rematch" flag for each side and starts the next round
   * as soon as both are set. The flag is carried in the state broadcast so
   * the guest always knows whether the host is already willing.
   */

  /** The host wants to play again. */
  function hostRequestRematch() {
    state.rematch.host = true;
    if (state.rematch.guest) {
      startRematch();
      return;
    }
    broadcastState();
    renderActions();
  }

  /** The guest asked for a rematch. */
  function hostReceiveRematchRequest() {
    state.rematch.guest = true;
    if (state.rematch.host) {
      startRematch();
      return;
    }
    // The host has not agreed yet: ask them to.
    state.hostInviteOpen = true;
    broadcastState();
    renderActions();
  }

  /** The host refused the rematch. */
  function hostDeclineRematch() {
    state.hostInviteOpen = false;
    state.rematch.guest = false;
    broadcastState();
    renderActions();
    sendToPeer({ type: 'rematch-declined' });
  }

  /** Both sides want a rematch: begin the next round. */
  function startRematch() {
    state.hostInviteOpen = false;
    resetRound(state.round + 1);
    broadcastState();
  }

  /** The guest wants to play again. */
  function guestRequestRematch() {
    if (state.rematch.guest) return;
    state.rematch.guest = true;
    renderActions();
    if (!sendToPeer({ type: 'rematch-request' })) {
      state.rematch.guest = false;
      renderActions();
    }
  }

  /* ---------------------------- GUEST --------------------------------- */

  let joinTimer = null;

  /** Join a room with the given code. */
  function guestJoinRoom(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (code.length !== ROOM_LENGTH) {
      showLobbyError('A room code is exactly 4 characters.');
      return;
    }
    if (!code.split('').every((ch) => ROOM_ALPHABET.indexOf(ch) !== -1)) {
      showLobbyError('That room code contains characters we do not use. Codes use letters and digits only.');
      return;
    }

    clearLobbyError();
    state.role = 'guest';
    state.myMark = 'O';
    state.code = code;

    showScreen('host');
    el.hostCode.textContent = code;
    el.shareLink.value = buildShareLink(code);
    el.hostTitle.textContent = 'Joining room';
    el.hostSub.textContent = 'Connecting to the host…';
    el.hostStatus.textContent = 'Connecting to the host…';
    el.btnCancelHost.textContent = 'Cancel';

    const peer = new Peer(peerOptions());
    state.peer = peer;

    peer.on('open', () => {
      // The peer id of the host is derived from the room code.
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      state.conn = conn;
      hardenConnection(conn);

      // Guard against a host that never exists (wrong code / gone away).
      joinTimer = setTimeout(() => {
        if (state.conn && !state.conn.open) {
          failJoin('Room not found. Check the code and that the host is still waiting.');
        }
      }, CONNECT_TIMEOUT_MS);

      conn.on('open', () => {
        clearTimeout(joinTimer);
        setConnectionStatus('connected', 'Connected');
        showScreen('game');
        startHeartbeat();
      });

      conn.on('data', (raw) => {
        const msg = parseMessage(raw);
        if (!msg) return;
        notePeerAlive();
        if (msg.type === 'state') applyHostState(msg);
        else if (msg.type === 'full') failJoin('That room is already full.');
        else if (msg.type === 'ping') sendToPeer({ type: 'pong' });
        else if (msg.type === 'rematch-declined') {
          // The host refused the rematch; let the guest try again.
          state.rematch.guest = false;
          renderActions();
        }
      });

      conn.on('close', () => {
        clearTimeout(joinTimer);
        if (state.role !== 'guest' || state.conn !== conn) return;
        handleDisconnect('Your opponent left the game.', 'Opponent disconnected');
      });

      conn.on('error', () => {
        clearTimeout(joinTimer);
        if (state.role !== 'guest' || state.conn !== conn) return;
        handleDisconnect('The connection to the host was lost.', 'Connection lost');
      });
    });

    peer.on('error', (err) => {
      const type = err && err.type;
      clearTimeout(joinTimer);

      // Once the game is running, a signalling hiccup must not tear the
      // session down — the data channel is what matters, not the socket.
      if (state.conn && state.conn.open) return;

      if (type === 'peer-unavailable' || type === 'unavailable-id') {
        failJoin('Room not found. Check the code and that the host is still waiting.');
        return;
      }
      if (type === 'browser-incompatible') {
        failJoin('This browser does not support WebRTC, so it cannot play.');
        return;
      }
      failJoin('Could not reach the PeerJS server. Check your internet connection.');
    });
  }

  /** Show a join failure and return to the lobby. */
  function failJoin(message) {
    clearTimeout(joinTimer);
    cleanupPeer();
    state.role = null;
    state.myMark = null;
    state.code = null;
    showScreen('lobby');
    showLobbyError(message);
    el.inputCode.focus();
  }

  /** Apply the authoritative state received from the host. */
  function applyHostState(msg) {
    state.board = msg.board.slice();
    state.turn = msg.turn;
    state.winner = msg.winner;
    state.winLine = msg.winLine;
    state.scores = {
      X: msg.scores.X,
      O: msg.scores.O,
      draws: msg.scores.draws
    };
    state.round = msg.round;
    state.gameOver = !!(msg.winner || isBoardFull(state.board));
    state.pendingMove = false;

    // A new round clears any pending rematch agreement on both sides.
    if (msg.round !== state.rematchRound) {
      state.rematch = { host: false, guest: false };
      state.hostInviteOpen = false;
    }
    state.rematchRound = msg.round;

    // The host is authoritative about who has asked for a rematch.
    state.rematch.host = !!(msg.rematch && msg.rematch.host);
    state.rematch.guest = !!(msg.rematch && msg.rematch.guest);

    render();
  }

  /* ---------------------------- SHARED -------------------------------- */

  /** Start a new round with an empty board. */
  function resetRound(roundNumber) {
    state.round = roundNumber;
    state.rematchRound = roundNumber;
    state.board = emptyBoard();
    state.winner = null;
    state.winLine = null;
    state.gameOver = false;
    state.turn = starterForRound(roundNumber);
    state.pendingMove = false;
    state.hostInviteOpen = false;
    state.rematch = { host: false, guest: false };
    render();
  }

  /** Show the disconnected screen. */
  function handleDisconnect(message, title) {
    cleanupPeer();
    state.role = null;
    state.myMark = null;
    state.code = null;
    el.discTitle.textContent = title;
    el.discMsg.textContent = message;
    setConnectionStatus('disconnected', 'Disconnected');
    showScreen('disconnected');
  }

  /** Build the shareable link for a room. */
  function buildShareLink(code) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', code);
    return url.toString();
  }

  /* ---------------------------- RENDERING ------------------------------ */

  /** Paint the whole UI from `state`. */
  function render() {
    renderBoard();
    renderStatus();
    renderScores();
    renderResult();
    renderActions();
  }

  /** Paint the 3x3 grid. */
  function renderBoard() {
    const interactive = isMyTurn() && !state.gameOver;

    el.cells.forEach((cell, index) => {
      const mark = state.board[index] || '';
      const previous = cell.dataset.mark || '';
      cell.textContent = mark;
      cell.dataset.mark = mark;
      cell.setAttribute('aria-label', cellLabel(index, mark));
      cell.classList.toggle('win', !!(state.winLine && state.winLine.indexOf(index) !== -1));

      // Animate a mark that has just been placed.
      if (mark && mark !== previous) {
        cell.classList.remove('pop');
        void cell.offsetWidth; // restart the animation
        cell.classList.add('pop');
      }

      cell.disabled = !interactive;
    });
  }

  /** Paint the badges and the turn label. */
  function renderStatus() {
    el.badgeMark.textContent = state.myMark ? `You are ${state.myMark}` : '';
    el.badgeCode.textContent = state.code || '····';

    if (state.gameOver) {
      el.turnLabel.textContent = '';
      el.turnLabel.removeAttribute('data-mine');
      return;
    }

    const mine = state.turn === state.myMark;
    el.turnLabel.dataset.mine = mine ? 'true' : 'false';
    el.turnLabel.textContent = mine ? 'Your turn' : `Waiting for ${state.turn}…`;
  }

  /** Paint the session scoreboard. */
  function renderScores() {
    el.scoreX.textContent = state.scores.X;
    el.scoreO.textContent = state.scores.O;
    el.scoreDraws.textContent = state.scores.draws;
  }

  /** Paint the result banner. */
  function renderResult() {
    if (!state.gameOver) {
      el.result.hidden = true;
      el.result.textContent = '';
      el.result.removeAttribute('data-kind');
      return;
    }

    el.result.hidden = false;
    if (state.winner) {
      const mine = state.winner === state.myMark;
      el.result.dataset.kind = 'win';
      el.result.textContent = mine ? 'You win! 🎉' : `${state.winner} wins`;
    } else {
      el.result.dataset.kind = 'draw';
      el.result.textContent = 'Draw — nobody wins.';
    }
  }

  /** Paint the rematch / leave buttons. */
  function renderActions() {
    const over = state.gameOver;

    // The host shows the "opponent asked" panel; the guest sees a plain
    // waiting state on the button itself.
    el.rematchInvite.hidden = !(state.role === 'host' && state.hostInviteOpen);

    if (!over) {
      el.btnRematch.hidden = true;
      el.btnRematch.disabled = false;
      el.btnRematch.textContent = 'Play again';
      return;
    }

    el.btnRematch.hidden = false;

    if (state.role === 'host') {
      // Waiting for the guest to agree.
      el.btnRematch.textContent = state.rematch.host ? 'Waiting for opponent…' : 'Play again';
      el.btnRematch.disabled = state.rematch.host;
      return;
    }

    // Guest: waiting until the host has also agreed.
    const mine = state.rematch.guest;
    const theirs = state.rematch.host;

    if (mine && !theirs) {
      el.btnRematch.textContent = 'Waiting for opponent…';
      el.btnRematch.disabled = true;
    } else if (!mine && theirs) {
      // The host is ready: let the guest agree.
      el.btnRematch.textContent = 'Play again';
      el.btnRematch.disabled = false;
    } else {
      el.btnRematch.textContent = 'Play again';
      el.btnRematch.disabled = false;
    }
  }

  /** True when it is this client's turn to move. */
  function isMyTurn() {
    if (!state.myMark) return false;
    if (state.gameOver) return false;
    if (state.role === 'guest' && state.pendingMove) return false;
    return state.turn === state.myMark;
  }

  /* ======================================================================
   * 7. Event wiring
   * ==================================================================== */

  /* ---------------------------- LOBBY ---------------------------------- */

  el.btnCreate.addEventListener('click', () => {
    clearLobbyError();
    hostCreateGame();
  });

  el.btnJoin.addEventListener('click', () => {
    guestJoinRoom(el.inputCode.value);
  });

  // Auto-uppercase and strip characters we never use.
  el.inputCode.addEventListener('input', () => {
    const cleaned = el.inputCode.value
      .toUpperCase()
      .split('')
      .filter((ch) => ROOM_ALPHABET.indexOf(ch) !== -1)
      .slice(0, ROOM_LENGTH)
      .join('');
    if (cleaned !== el.inputCode.value) el.inputCode.value = cleaned;
    clearLobbyError();
  });

  el.inputCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      guestJoinRoom(el.inputCode.value);
    }
  });

  /* ---------------------------- HOST ----------------------------------- */

  el.btnCopy.addEventListener('click', () => {
    const link = el.shareLink.value;
    const done = () => {
      el.copyNote.hidden = false;
      setTimeout(() => { el.copyNote.hidden = true; }, 2000);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, () => fallbackCopy(link, done));
    } else {
      fallbackCopy(link, done);
    }
  });

  /** Clipboard fallback for browsers without the async clipboard API. */
  function fallbackCopy(text, onDone) {
    try {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      document.body.removeChild(field);
      onDone();
    } catch (err) {
      el.shareLink.focus();
      el.shareLink.select();
    }
  }

  el.btnCancelHost.addEventListener('click', () => leaveToLobby());

  /* ---------------------------- GAME ----------------------------------- */

  el.cells.forEach((cell) => {
    cell.addEventListener('click', () => {
      const index = Number(cell.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index > 8) return;
      handleLocalCellClick(index);
    });
  });

  /** A cell was clicked on this device. */
  function handleLocalCellClick(index) {
    if (state.gameOver) return;
    if (state.board[index] !== null) return;
    if (state.turn !== state.myMark) return;

    if (state.role === 'host') {
      // The host owns the board: apply it locally and tell the guest.
      state.board = applyMove(state.board, index, 'X');
      settleRound();
      render();
      broadcastState();
    } else if (state.role === 'guest') {
      // The guest only ever asks; the host decides.
      state.pendingMove = true;
      renderBoard();
      if (!sendToPeer({ type: 'move', index })) {
        state.pendingMove = false;
        render();
      }
    }
  }

  el.btnRematch.addEventListener('click', () => {
    if (state.role === 'host') {
      hostRequestRematch();
    } else if (state.role === 'guest') {
      guestRequestRematch();
    }
  });

  el.btnRematchAccept.addEventListener('click', () => {
    // Accepting doubles as the host agreeing to a rematch.
    state.hostInviteOpen = false;
    hostRequestRematch();
  });

  el.btnRematchDecline.addEventListener('click', () => {
    hostDeclineRematch();
  });
  el.btnLeave.addEventListener('click', () => leaveToLobby());

  el.btnBackLobby.addEventListener('click', () => leaveToLobby());

  /** Leave the current game and return to the lobby. */
  function leaveToLobby() {
    cleanupPeer();
    clearTimeout(joinTimer);
    state.role = null;
    state.myMark = null;
    state.code = null;
    state.board = emptyBoard();
    state.turn = 'X';
    state.winner = null;
    state.winLine = null;
    state.gameOver = false;
    state.pendingMove = false;
    state.hostInviteOpen = false;
    state.rematch = { host: false, guest: false };
    setConnectionStatus('connecting', 'Connecting…');
    showScreen('lobby');
    render();
  }

  /* ---------------------------- STARTUP -------------------------------- */

  /**
   * Make a connection tolerant of malformed payloads.
   *
   * PeerJS 1.5.4 deserialises an incoming message and then immediately
   * dereferences the result (`data.__peerData`) without checking that it is
   * an object. A peer that sends a payload which decodes to `null` therefore
   * throws *inside the library*, before our own validator ever runs. The
   * board is not corrupted (the message is simply lost), but it surfaces as
   * an uncaught error, and a hostile guest could repeat it at will.
   *
   * Wrapping the handler in a try/catch drops the malformed message and
   * keeps everything else working. The method is feature-detected so that a
   * future PeerJS release which no longer has it is simply left alone.
   */
  function hardenConnection(conn) {
    if (!conn || typeof conn._handleDataMessage !== 'function') return conn;
    if (conn.__hardened) return conn;
    const original = conn._handleDataMessage;
    conn._handleDataMessage = function (event) {
      try {
        return original.call(this, event);
      } catch (err) {
        // A malformed payload: ignore it rather than breaking the game.
        return undefined;
      }
    };
    conn.__hardened = true;
    return conn;
  }

  // Handle ?room=CODE deep links: prefill the code and join automatically.
  (function initFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const code = (params.get('room') || '').trim().toUpperCase();
    if (!code) {
      showScreen('lobby');
      return;
    }
    el.inputCode.value = code.slice(0, ROOM_LENGTH);
    showScreen('lobby');
    guestJoinRoom(code);
  })();

  // Clean up the peer when the tab goes away, so the host slot frees up.
  window.addEventListener('beforeunload', () => {
    try { cleanupPeer(); } catch (err) { /* ignore */ }
  });

})();
