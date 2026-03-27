// battleship-server/src/index.ts
import 'dotenv/config';
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { validatePlacement, processShot, autoPlaceShips } from "./gamelogic";

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

// ── Save attempts ─────────────────────────────────────────────────────────────

async function saveAttempts(gameType, gameId, scores) {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;
    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
            body: JSON.stringify({ gameType, gameId, scores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[${gameType}] scores saved for ${gameId}`);
    } catch (err) {
        console.error(`[${gameType}] saveAttempts error:`, err);
    }
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * rooms: Map<lobbyId, Room>
 *
 * Room = {
 *   lobbyId: string,
 *   options: { turnDuration: number, placementDuration: number },
 *   players: [PlayerSlot?, PlayerSlot?],   // index = seat (0 or 1)
 *   phase: "waiting" | "placement" | "playing" | "finished",
 *   currentTurn: 0 | 1,
 *   turnTimer: Timeout | null,
 *   placementTimer: Timeout | null,
 *   placementEndsAt: number | null,
 *   turnEndsAt: number | null,
 *   winnerId: string | null,
 * }
 *
 * PlayerSlot = {
 *   userId: string,
 *   username: string,
 *   avatar: string | null,
 *   socketId: string,
 *   ships: PlacedShip[],          // set during placement
 *   receivedShots: Set<string>,   // "row,col" strings
 *   ready: boolean,               // placement confirmed
 * }
 */
const rooms = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRoom(lobbyId) {
    return rooms.get(lobbyId) ?? null;
}

function getSlotIndex(room, userId) {
    return room.players.findIndex((p) => p?.userId === userId);
}

function getSocketByUserId(room, userId) {
    const slot = room.players.find((p) => p?.userId === userId);
    if (!slot) return null;
    return io.sockets.sockets.get(slot.socketId) ?? null;
}

function emitToRoom(room, event, payload) {
    io.to(`room:${room.lobbyId}`).emit(event, payload);
}

function emitToPlayer(room, userId, event, payload) {
    const s = getSocketByUserId(room, userId);
    if (s) s.emit(event, payload);
}

function clearRoomTimers(room) {
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    if (room.placementTimer) { clearTimeout(room.placementTimer); room.placementTimer = null; }
}

// ── Turn timer ────────────────────────────────────────────────────────────────

function startTurnTimer(room) {
    clearRoomTimers(room);
    const duration = room.options.turnDuration * 1000;
    room.turnEndsAt = Date.now() + duration;

    room.turnTimer = setTimeout(() => {
        // Time expired → current player loses their turn (shoot randomly or forfeit)
        const currentPlayer = room.players[room.currentTurn];
        if (!currentPlayer) return;

        // Pick a random untouched cell on enemy grid
        const enemyIndex = room.currentTurn === 0 ? 1 : 0;
        const enemy = room.players[enemyIndex];
        if (!enemy) return;

        const emptyCells = [];
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 10; c++) {
                if (!enemy.receivedShots.has(`${r},${c}`)) emptyCells.push([r, c]);
            }
        }

        if (emptyCells.length === 0) return;

        const [row, col] = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        handleShot(room, currentPlayer.userId, row, col, true /* isTimeout */);
    }, duration);
}

// ── Placement timer ───────────────────────────────────────────────────────────

function startPlacementTimer(room) {
    clearRoomTimers(room);
    const duration = room.options.placementDuration * 1000;
    room.placementEndsAt = Date.now() + duration;

    room.placementTimer = setTimeout(() => {
        // Auto-place ships for players who haven't placed yet
        room.players.forEach((player) => {
            if (!player || player.ready) return;
            player.ships = autoPlaceShips();
            player.ready = true;
            emitToPlayer(room, player.userId, "battleship:autoPlaced", { ships: player.ships });
        });
        startGame(room);
    }, duration);
}

// ── Game flow ─────────────────────────────────────────────────────────────────

function startPlacementPhase(room) {
    room.phase = "placement";
    const endsAt = Date.now() + room.options.placementDuration * 1000;
    room.placementEndsAt = endsAt;

    emitToRoom(room, "battleship:placementStart", {
        placementDuration: room.options.placementDuration,
        endsAt,
        options: room.options,
    });

    startPlacementTimer(room);
}

function startGame(room) {
    clearRoomTimers(room);
    room.phase = "playing";
    room.currentTurn = 0; // player[0] starts
    const endsAt = Date.now() + room.options.turnDuration * 1000;
    room.turnEndsAt = endsAt;

    emitToRoom(room, "battleship:gameStart", {
        currentTurnUserId: room.players[0].userId,
        turnDuration: room.options.turnDuration,
        endsAt,
        // Each player gets their own ships confirmed + opponent info (no ships)
        players: room.players.map((p) => ({
            userId: p.userId,
            username: p.username,
            avatar: p.avatar,
        })),
    });

    startTurnTimer(room);
}

function handleShot(room, shooterUserId, row, col, isTimeout = false) {
    if (room.phase !== "playing") return;

    const shooterIndex = getSlotIndex(room, shooterUserId);
    if (shooterIndex !== room.currentTurn) return; // not their turn

    const targetIndex = shooterIndex === 0 ? 1 : 0;
    const target = room.players[targetIndex];
    if (!target) return;

    // Validate cell
    if (row < 0 || row >= 10 || col < 0 || col >= 10) return;
    if (target.receivedShots.has(`${row},${col}`)) return;

    clearRoomTimers(room);

    const result = processShot(target.ships, target.receivedShots, row, col);

    const shotPayload = {
        shooterUserId,
        row,
        col,
        hit: result.hit,
        sunkShip: result.sunkShip ?? null,
        isTimeout,
    };

    // Game over?
    if (result.gameOver) {
        room.phase = "finished";
        room.winnerId = shooterUserId;

        emitToRoom(room, "battleship:shotResult", shotPayload);
        emitToRoom(room, "battleship:finished", {
            winnerUserId: shooterUserId,
            reason: "all_sunk",
            // Reveal both grids
            grids: room.players.map((p) => ({
                userId: p.userId,
                ships: p.ships,
                receivedShots: Array.from(p.receivedShots),
            })),
        });
        saveAttempts('BATTLESHIP', room.lobbyId, room.players.map((p) => ({
            userId: p.userId,
            score: p.userId === shooterUserId ? 1 : 0,
            placement: p.userId === shooterUserId ? 1 : 2,
        })));
        return;
    }

    // Switch turn only on miss (classic rules) — hits give another turn
    if (!result.hit) {
        room.currentTurn = targetIndex;
    }

    const nextEndsAt = Date.now() + room.options.turnDuration * 1000;
    room.turnEndsAt = nextEndsAt;

    emitToRoom(room, "battleship:shotResult", {
        ...shotPayload,
        currentTurnUserId: room.players[room.currentTurn].userId,
        endsAt: nextEndsAt,
    });

    startTurnTimer(room);
}

// ── Socket handlers ───────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("battleship: new connection", socket.id);

    // ── Configure ─────────────────────────────────────────────────────────────
    socket.on("battleship:configure", ({ lobbyId, options }, ack) => {
        if (!lobbyId) return;
        const existingRoom = rooms.get(lobbyId);
        if (!existingRoom || existingRoom.phase === "finished") {
            if (existingRoom) {
                if (existingRoom.turnTimer) clearTimeout(existingRoom.turnTimer);
                if (existingRoom.placementTimer) clearTimeout(existingRoom.placementTimer);
            }
            rooms.set(lobbyId, {
                lobbyId,
                options: {
                    turnDuration: options?.turnDuration ?? 30,
                    placementDuration: options?.placementDuration ?? 60,
                },
                players: [null, null],
                phase: "waiting",
                currentTurn: 0,
                turnTimer: null,
                placementTimer: null,
                placementEndsAt: null,
                turnEndsAt: null,
                winnerId: null,
            });
        }
        if (typeof ack === 'function') ack();
    });

    // ── Join ─────────────────────────────────────────────────────────────────
    socket.on("battleship:join", ({ lobbyId, userId, username, avatar }) => {
        if (!lobbyId || !userId || !username) return;

        socket.data = { lobbyId, userId };
        socket.join(`room:${lobbyId}`);

        const room = getRoom(lobbyId);

        if (!room) {
            socket.emit('notFound');
            return;
        }

        // Find existing seat (reconnection) or assign new one
        let seatIndex = room.players.findIndex((p) => p?.userId === userId);

        if (seatIndex === -1) {
            seatIndex = room.players.findIndex((p) => p === null);
            if (seatIndex === -1) {
                // Spectator: no seat, just send current state and rely on room broadcasts
                socket.emit("battleship:joined", {
                    yourSeat: null,
                    phase: room.phase,
                    players: room.players.map((p) =>
                        p ? { userId: p.userId, username: p.username, avatar: p.avatar, ready: p.ready } : null
                    ),
                    ...(room.phase === "playing" && room.turnEndsAt
                        ? { currentTurnUserId: room.players[room.currentTurn]?.userId, turnEndsAt: room.turnEndsAt }
                        : {}),
                    ...(room.phase === "finished" ? { winnerUserId: room.winnerId } : {}),
                });
                return;
            }
            room.players[seatIndex] = {
                userId,
                username,
                avatar: avatar ?? null,
                socketId: socket.id,
                ships: [],
                receivedShots: new Set(),
                ready: false,
            };
        } else {
            // Reconnection — update socket id
            room.players[seatIndex].socketId = socket.id;
        }

        socket.emit("battleship:joined", {
            yourSeat: seatIndex,
            phase: room.phase,
            options: room.options,
            players: room.players.map((p) =>
                p ? { userId: p.userId, username: p.username, avatar: p.avatar, ready: p.ready } : null
            ),
            // Restore state if reconnecting mid-game
            ...(room.phase === "placement" && room.placementEndsAt
                ? { placementEndsAt: room.placementEndsAt }
                : {}),
            ...(room.phase === "playing" && room.turnEndsAt
                ? {
                    currentTurnUserId: room.players[room.currentTurn]?.userId,
                    turnEndsAt: room.turnEndsAt,
                }
                : {}),
        });

        // If reconnecting and had already placed ships, send them back
        if (room.players[seatIndex].ships.length > 0) {
            socket.emit("battleship:shipsRestored", {
                ships: room.players[seatIndex].ships,
                ready: room.players[seatIndex].ready,
                receivedShots: Array.from(room.players[seatIndex].receivedShots),
            });
            // Also send the opponent's received shots (so the player can see their hits)
            const opponentIndex = seatIndex === 0 ? 1 : 0;
            const opponent = room.players[opponentIndex];
            if (opponent && opponent.receivedShots.size > 0) {
                socket.emit("battleship:opponentShotsRestored", {
                    receivedShots: Array.from(opponent.receivedShots),
                    ships: room.phase === "finished" ? opponent.ships : [], // reveal only at end
                });
            }
        }

        // Notify both players
        emitToRoom(room, "battleship:playerUpdate", {
            players: room.players.map((p) =>
                p ? { userId: p.userId, username: p.username, avatar: p.avatar, ready: p.ready } : null
            ),
        });

        // Both players seated → start placement
        const bothSeated = room.players.every((p) => p !== null);
        if (bothSeated && room.phase === "waiting") {
            startPlacementPhase(room);
        }
    });

    // ── Place ships ───────────────────────────────────────────────────────────
    socket.on("battleship:placeShips", ({ lobbyId, ships }) => {
        const room = getRoom(lobbyId);
        if (!room || room.phase !== "placement") return;

        const { userId } = socket.data;
        const seatIndex = getSlotIndex(room, userId);
        if (seatIndex === -1) return;

        const player = room.players[seatIndex];
        if (player.ready) return; // already confirmed

        const validation = validatePlacement(ships);
        if (!validation.valid) {
            socket.emit("battleship:placementError", { message: validation.error });
            return;
        }

        player.ships = ships.map((s) => ({ ...s, sunk: false }));
        player.ready = true;

        socket.emit("battleship:placementConfirmed", { ships: player.ships });

        // Notify opponent that this player is ready
        const opponentIndex = seatIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIndex];
        if (opponent) {
            emitToPlayer(room, opponent.userId, "battleship:opponentReady", {});
        }

        // Both ready → start game
        if (room.players.every((p) => p?.ready)) {
            clearRoomTimers(room);
            startGame(room);
        }
    });

    // ── Shoot ─────────────────────────────────────────────────────────────────
    socket.on("battleship:shoot", ({ lobbyId, row, col }) => {
        const room = getRoom(lobbyId);
        if (!room) return;
        const { userId } = socket.data;
        handleShot(room, userId, row, col, false);
    });

    // ── Surrender ─────────────────────────────────────────────────────────────
    socket.on("battleship:surrender", ({ lobbyId }) => {
        const room = getRoom(lobbyId);
        if (!room || room.phase !== "playing") return;
        const { userId } = socket.data;
        const seatIndex = getSlotIndex(room, userId);
        if (seatIndex === -1) return;

        clearRoomTimers(room);
        room.phase = "finished";

        const opponentIndex = seatIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIndex];
        room.winnerId = opponent?.userId ?? null;

        emitToRoom(room, "battleship:finished", {
            winnerUserId: room.winnerId,
            reason: "surrender",
            grids: room.players.map((p) => ({
                userId: p.userId,
                ships: p.ships,
                receivedShots: Array.from(p.receivedShots),
            })),
        });
        saveAttempts('BATTLESHIP', room.lobbyId, [
            { userId: room.winnerId, score: 1, placement: 1 },
            { userId: userId, score: 0, placement: 2, abandon: true },
        ]);
    });

    // ── Rematch ───────────────────────────────────────────────────────────────
    socket.on("battleship:rematch", ({ lobbyId }) => {
        const room = getRoom(lobbyId);
        if (!room || room.phase !== "finished") return;

        clearRoomTimers(room);

        // Reset player states
        room.players.forEach((p) => {
            if (!p) return;
            p.ships = [];
            p.receivedShots = new Set();
            p.ready = false;
        });

        room.phase = "waiting";
        room.winnerId = null;
        room.currentTurn = 0;

        startPlacementPhase(room);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;

        const room = getRoom(lobbyId);
        if (!room) return;

        const seatIndex = getSlotIndex(room, userId);
        if (seatIndex === -1) return;

        console.log(`battleship: player ${userId} disconnected from ${lobbyId}`);

        if (room.phase === "playing") {
            // Give a 30s grace period for reconnection
            setTimeout(() => {
                const r = getRoom(lobbyId);
                if (!r) return;
                const player = r.players[seatIndex];
                // Check if they reconnected (socketId changed) or still offline
                if (!player || player.userId !== userId) return;
                const s = io.sockets.sockets.get(player.socketId);
                if (s) return; // reconnected

                // Forfeit
                clearRoomTimers(r);
                r.phase = "finished";
                const opponentIndex = seatIndex === 0 ? 1 : 0;
                const opponent = r.players[opponentIndex];
                r.winnerId = opponent?.userId ?? null;

                emitToRoom(r, "battleship:finished", {
                    winnerUserId: r.winnerId,
                    reason: "disconnect",
                    grids: r.players.map((p) => ({
                        userId: p.userId,
                        ships: p.ships,
                        receivedShots: Array.from(p.receivedShots),
                    })),
                });
            }, 30_000);
        }
    });
});

const PORT = process.env.PORT || 10008;
server.listen(PORT, () => console.log("[BATTLESHIP] realtime listening on", PORT));
