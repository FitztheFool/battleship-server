import 'dotenv/config';
import { randomUUID } from 'crypto';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { setupSocketAuth, corsConfig } from '@kwizar/shared';

import { validatePlacement, processShot, autoPlaceShips } from './gamelogic';
import { Room } from './types';
import { rooms, getRoom, getSlotIndex, clearRoomTimers } from './rooms';
import { saveAttempts } from '@kwizar/shared';
import { timerCallbacks, startTurnTimer, startPlacementTimer } from './timer';
import { botCallbacks, botShoot, updateBotHitQueue } from './bot';

const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);

const io = new Server(server, { cors: corsConfig, maxHttpBufferSize: 1e5 });

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSocketByUserId(room: Room, userId: string) {
    const slot = room.players.find((p) => p?.userId === userId);
    if (!slot || !slot.socketId) return null;
    return io.sockets.sockets.get(slot.socketId) ?? null;
}

function emitToRoom(room: Room, event: string, payload: unknown) {
    io.to(`room:${room.lobbyId}`).emit(event, payload);
}

function emitToPlayer(room: Room, userId: string, event: string, payload: unknown) {
    const s = getSocketByUserId(room, userId);
    if (s) s.emit(event, payload);
}

// ── Game flow ─────────────────────────────────────────────────────────────────

function startPlacementPhase(room: Room) {
    room.phase = 'placement';
    const endsAt = Date.now() + room.options.placementDuration * 1000;
    room.placementEndsAt = endsAt;

    emitToRoom(room, 'battleship:placementStart', {
        placementDuration: room.options.placementDuration,
        endsAt,
        options: room.options,
    });

    startPlacementTimer(room);
}

function startGame(room: Room) {
    clearRoomTimers(room);
    room.phase = 'playing';
    room.currentGameId = randomUUID();
    room.currentTurn = Math.floor(Math.random() * room.players.length) as 0 | 1;
    const endsAt = Date.now() + room.options.turnDuration * 1000;
    room.turnEndsAt = endsAt;

    emitToRoom(room, 'battleship:gameStart', {
        currentTurnUserId: room.players[room.currentTurn]!.userId,
        turnDuration: room.options.turnDuration,
        endsAt,
        players: room.players.map((p) => p ? { userId: p.userId, username: p.username, avatar: p.avatar } : null),
    });

    startTurnTimer(room);

    if (room.players[room.currentTurn]?.userId.startsWith('bot-')) {
        setTimeout(() => botShoot(room), 800);
    }
}

function handleShot(room: Room, shooterUserId: string, row: number, col: number, isTimeout = false) {
    if (room.phase !== 'playing') return;

    const shooterIndex = getSlotIndex(room, shooterUserId);
    if (shooterIndex !== room.currentTurn) return;

    const targetIndex: 0 | 1 = shooterIndex === 0 ? 1 : 0;
    const target = room.players[targetIndex];
    if (!target) return;

    if (row < 0 || row >= 10 || col < 0 || col >= 10) return;
    if (target.receivedShots.has(`${row},${col}`)) return;

    clearRoomTimers(room);

    const result = processShot(target.ships, target.receivedShots, row, col);
    const shotPayload = { shooterUserId, row, col, hit: result.hit, sunkShip: result.sunkShip ?? null, isTimeout };

    if (result.gameOver) {
        room.phase = 'finished';
        room.winnerId = shooterUserId;
        room.gameOverReason = 'all_sunk';

        emitToRoom(room, 'battleship:shotResult', shotPayload);
        emitToRoom(room, 'battleship:finished', {
            winnerUserId: shooterUserId,
            reason: 'all_sunk',
            grids: room.players.map((p) => ({
                userId: p!.userId,
                ships: p!.ships,
                receivedShots: Array.from(p!.receivedShots),
            })),
        });
        saveAttempts('BATTLESHIP', room.currentGameId ?? room.lobbyId, room.players.map((p) => ({
            userId: p!.userId,
            username: p!.username,
            score: p!.userId === shooterUserId ? 1 : 0,
            placement: p!.userId === shooterUserId ? 1 : 2,
        })), room.players.some((p) => p?.userId.startsWith('bot-')));
        return;
    }

    const shooterIsBot = !!room.players[shooterIndex]?.userId.startsWith('bot-');
    updateBotHitQueue(room, shooterIsBot, row, col, result.hit, result.sunkShip, target);

    if (!result.hit) {
        room.currentTurn = targetIndex;
    }

    const nextEndsAt = Date.now() + room.options.turnDuration * 1000;
    room.turnEndsAt = nextEndsAt;

    emitToRoom(room, 'battleship:shotResult', {
        ...shotPayload,
        currentTurnUserId: room.players[room.currentTurn]!.userId,
        endsAt: nextEndsAt,
    });

    startTurnTimer(room);

    if (room.players[room.currentTurn]?.userId.startsWith('bot-')) {
        setTimeout(() => botShoot(room), 800);
    }
}

// ── Wire up callbacks (breaks circular deps) ──────────────────────────────────

timerCallbacks.handleShot = handleShot;
timerCallbacks.startGame = startGame;
timerCallbacks.emitToPlayer = emitToPlayer;
botCallbacks.handleShot = handleShot;

setupSocketAuth(io, new TextEncoder().encode(process.env.INTERNAL_API_KEY!));

// ── Socket handlers ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('[BATTLESHIP] nouvelle connexion', socket.id);

    // ── Configure ─────────────────────────────────────────────────────────────
    socket.on('battleship:configure', ({ lobbyId, options, botName }: { lobbyId: string; options?: { turnDuration?: number; placementDuration?: number }; botName?: string }, ack?: () => void) => {
        if (!lobbyId) return;
        const existing = rooms.get(lobbyId);
        if (!existing || existing.phase === 'finished') {
            if (existing) clearRoomTimers(existing);
            const botPlayer = botName ? {
                userId: `bot-battleship-${randomUUID()}`,
                username: botName,
                avatar: null,
                socketId: null,
                ships: [],
                receivedShots: new Set<string>(),
                ready: false,
            } : null;
            rooms.set(lobbyId, {
                lobbyId,
                options: {
                    turnDuration: options?.turnDuration ?? 30,
                    placementDuration: options?.placementDuration ?? 60,
                },
                players: botPlayer ? [botPlayer, null] : [null, null],
                phase: 'waiting',
                currentTurn: 0,
                turnTimer: null,
                placementTimer: null,
                placementEndsAt: null,
                turnEndsAt: null,
                winnerId: null,
                botHitQueue: [],
            });
        }
        if (typeof ack === 'function') ack();
    });

    // ── Join ─────────────────────────────────────────────────────────────────
    socket.on('battleship:join', ({ lobbyId, avatar }: { lobbyId: string; avatar?: string | null }) => {
        const { userId, username } = socket.data;
        if (!lobbyId || !userId || !username) return;

        socket.data.lobbyId = lobbyId;
        socket.join(`room:${lobbyId}`);

        const room = getRoom(lobbyId);
        if (!room) { socket.emit('notFound'); return; }

        let seatIndex = room.players.findIndex((p) => p?.userId === userId);

        if (seatIndex === -1) {
            seatIndex = room.players.findIndex((p) => p === null);
            if (seatIndex === -1) {
                // Spectator
                socket.emit('battleship:joined', {
                    yourSeat: null,
                    phase: room.phase,
                    players: room.players.map((p) =>
                        p ? { userId: p.userId, username: p.username, avatar: p.avatar, ready: p.ready } : null
                    ),
                    ...(room.phase === 'playing' && room.turnEndsAt
                        ? { currentTurnUserId: room.players[room.currentTurn]?.userId, turnEndsAt: room.turnEndsAt }
                        : {}),
                    ...(room.phase === 'finished' ? { winnerUserId: room.winnerId } : {}),
                });
                return;
            }
            room.players[seatIndex] = {
                userId, username, avatar: avatar ?? null,
                socketId: socket.id,
                ships: [], receivedShots: new Set(), ready: false,
            };
        } else {
            room.players[seatIndex]!.socketId = socket.id;
        }

        socket.emit('battleship:joined', {
            yourSeat: seatIndex,
            phase: room.phase,
            options: room.options,
            players: room.players.map((p) =>
                p ? { userId: p.userId, username: p.username, avatar: p.avatar, ready: p.ready } : null
            ),
            ...(room.phase === 'placement' && room.placementEndsAt ? { placementEndsAt: room.placementEndsAt } : {}),
            ...(room.phase === 'playing' && room.turnEndsAt
                ? { currentTurnUserId: room.players[room.currentTurn]?.userId, turnEndsAt: room.turnEndsAt }
                : {}),
            ...(room.phase === 'finished'
                ? { winnerUserId: room.winnerId, gameOverReason: room.gameOverReason ?? null }
                : {}),
        });

        const player = room.players[seatIndex]!;
        if (player.ships.length > 0) {
            socket.emit('battleship:shipsRestored', {
                ships: player.ships,
                ready: player.ready,
                receivedShots: Array.from(player.receivedShots),
            });
            const opponentIndex: 0 | 1 = seatIndex === 0 ? 1 : 0;
            const opponent = room.players[opponentIndex];
            if (opponent && opponent.receivedShots.size > 0) {
                socket.emit('battleship:opponentShotsRestored', {
                    receivedShots: Array.from(opponent.receivedShots),
                    ships: room.phase === 'finished' ? opponent.ships : [],
                });
            }
        }

        emitToRoom(room, 'battleship:playerUpdate', {
            players: room.players.map((p) =>
                p ? { userId: p.userId, username: p.username, avatar: p.avatar, ready: p.ready } : null
            ),
        });

        const bothSeated = room.players.every((p) => p !== null);
        if (bothSeated && room.phase === 'waiting') {
            startPlacementPhase(room);
            const botSlot = room.players.find((p) => p?.userId.startsWith('bot-'));
            if (botSlot) {
                setTimeout(() => {
                    if (room.phase !== 'placement' || botSlot.ready) return;
                    botSlot.ships = autoPlaceShips();
                    botSlot.ready = true;
                    if (room.players.every((p) => p?.ready)) {
                        clearRoomTimers(room);
                        startGame(room);
                    }
                }, 800);
            }
        }
    });

    // ── Place ships ───────────────────────────────────────────────────────────
    socket.on('battleship:placeShips', ({ lobbyId, ships }: { lobbyId: string; ships: unknown[] }) => {
        const room = getRoom(lobbyId);
        if (!room || room.phase !== 'placement') return;

        const { userId } = socket.data;
        const seatIndex = getSlotIndex(room, userId);
        if (seatIndex === -1) return;

        const player = room.players[seatIndex]!;
        if (player.ready) return;

        const validation = validatePlacement(ships);
        if (!validation.valid) {
            socket.emit('battleship:placementError', { message: validation.error });
            return;
        }

        player.ships = (ships as any[]).map((s) => ({ ...s, sunk: false }));
        player.ready = true;
        socket.emit('battleship:placementConfirmed', { ships: player.ships });

        const opponentIndex: 0 | 1 = seatIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIndex];
        if (opponent) emitToPlayer(room, opponent.userId, 'battleship:opponentReady', {});

        if (room.players.every((p) => p?.ready)) {
            clearRoomTimers(room);
            startGame(room);
        }
    });

    // ── Shoot ─────────────────────────────────────────────────────────────────
    socket.on('battleship:shoot', ({ lobbyId, row, col }: { lobbyId: string; row: number; col: number }) => {
        const room = getRoom(lobbyId);
        if (!room) return;
        handleShot(room, socket.data.userId, row, col, false);
    });

    // ── Surrender ─────────────────────────────────────────────────────────────
    socket.on('battleship:surrender', ({ lobbyId }: { lobbyId: string }) => {
        const room = getRoom(lobbyId);
        if (!room || room.phase !== 'playing') return;
        const { userId } = socket.data;
        const seatIndex = getSlotIndex(room, userId);
        if (seatIndex === -1) return;

        clearRoomTimers(room);
        room.phase = 'finished';
        room.gameOverReason = 'surrender';

        const opponentIndex: 0 | 1 = seatIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIndex];
        room.winnerId = opponent?.userId ?? null;

        emitToRoom(room, 'battleship:finished', {
            winnerUserId: room.winnerId,
            reason: 'surrender',
            grids: room.players.map((p) => ({
                userId: p!.userId, ships: p!.ships, receivedShots: Array.from(p!.receivedShots),
            })),
        });

        const hasBot = room.players.some((p) => p?.userId.startsWith('bot-'));
        saveAttempts('BATTLESHIP', room.currentGameId ?? room.lobbyId, [
            { userId: room.winnerId!, username: opponent?.username, score: 1, placement: 1 },
            { userId: userId, username: room.players[seatIndex]?.username, score: 0, placement: 2, abandon: true },
        ], hasBot);
    });

    // ── Rematch ───────────────────────────────────────────────────────────────
    socket.on('battleship:rematch', ({ lobbyId }: { lobbyId: string }) => {
        const room = getRoom(lobbyId);
        if (!room || room.phase !== 'finished') return;

        clearRoomTimers(room);
        room.players.forEach((p) => {
            if (!p) return;
            p.ships = [];
            p.receivedShots = new Set();
            p.ready = false;
        });
        room.phase = 'waiting';
        room.winnerId = null;
        room.currentTurn = 0;
        room.botHitQueue = [];

        startPlacementPhase(room);

        const botSlot = room.players.find((p) => p?.userId.startsWith('bot-'));
        if (botSlot) {
            setTimeout(() => {
                if (room.phase !== 'placement' || botSlot.ready) return;
                botSlot.ships = autoPlaceShips();
                botSlot.ready = true;
                if (room.players.every((p) => p?.ready)) {
                    clearRoomTimers(room);
                    startGame(room);
                }
            }, 800);
        }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;

        const room = getRoom(lobbyId);
        if (!room) return;

        const seatIndex = getSlotIndex(room, userId);
        if (seatIndex === -1) return;
        if (room.players[seatIndex]?.socketId !== socket.id) return;

        console.log(`[BATTLESHIP] ${userId} déconnecté de ${lobbyId}`);

        if (room.phase === 'playing' || room.phase === 'placement') {
            clearRoomTimers(room);
            room.phase = 'finished';
            room.gameOverReason = 'disconnect';

            const opponentIndex: 0 | 1 = seatIndex === 0 ? 1 : 0;
            const opponent = room.players[opponentIndex];
            room.winnerId = opponent?.userId ?? null;

            emitToRoom(room, 'battleship:finished', {
                winnerUserId: room.winnerId,
                reason: 'disconnect',
                grids: room.players.map((p) => ({
                    userId: p?.userId ?? null,
                    ships: p?.ships ?? [],
                    receivedShots: Array.from(p?.receivedShots ?? []),
                })),
            });

            if (room.winnerId) {
                const hasBot = room.players.some((p) => p?.userId.startsWith('bot-'));
                saveAttempts('BATTLESHIP', room.currentGameId ?? room.lobbyId, [
                    { userId: room.winnerId, username: opponent?.username, score: 1, placement: 1 },
                    { userId: userId, username: room.players[seatIndex]?.username, score: 0, placement: 2, abandon: true },
                ], hasBot);
            }
        } else {
            room.players[seatIndex] = null;
            if (!room.players.some(p => p !== null)) {
                clearRoomTimers(room);
                rooms.delete(lobbyId);
            }
        }
    });
});

// ── Démarrage ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 10008;
server.listen(PORT, () => console.log('[BATTLESHIP] realtime listening on', PORT));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
