export type GamePhase = 'waiting' | 'placement' | 'playing' | 'finished';

export interface PlacedShip {
    id: string;
    row: number;
    col: number;
    size: number;
    horizontal: boolean;
    sunk: boolean;
}

export interface PlayerSlot {
    userId: string;
    username: string;
    avatar: string | null;
    socketId: string | null;
    ships: PlacedShip[];
    receivedShots: Set<string>;
    ready: boolean;
}

export interface Room {
    lobbyId: string;
    options: { turnDuration: number; placementDuration: number };
    players: [PlayerSlot | null, PlayerSlot | null];
    phase: GamePhase;
    currentTurn: 0 | 1;
    currentGameId?: string;
    turnTimer: ReturnType<typeof setTimeout> | null;
    placementTimer: ReturnType<typeof setTimeout> | null;
    placementEndsAt: number | null;
    turnEndsAt: number | null;
    winnerId: string | null;
    gameOverReason?: string;
    botHitQueue: [number, number][];
}

export interface ScoreEntry {
    userId: string;
    username?: string;
    score: number;
    placement: number;
    abandon?: boolean;
    afk?: boolean;
}
