import { ScoreEntry } from './types';

export async function saveAttempts(
    gameType: string,
    gameId: string,
    scores: ScoreEntry[],
    vsBot = false,
): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;

    const humanScores = scores.filter(s => !s.userId.startsWith('bot-'));
    if (humanScores.length === 0) return;

    const bots = scores
        .filter(s => s.userId.startsWith('bot-'))
        .map((s, i) => ({ username: s.username ?? `Bot ${i + 1}`, score: s.score, placement: s.placement }));

    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ gameType, gameId, vsBot, bots: bots.length > 0 ? bots : undefined, scores: humanScores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[BATTLESHIP] scores saved for ${gameId}`);
    } catch (err) {
        console.error('[BATTLESHIP] saveAttempts error:', err);
    }
}
