import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Collection, Document } from 'mongodb';
import { zBotDeclarationPatch } from '@ih3t/shared';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import pino from 'pino';

import { GameHistoryRepository } from '../persistence/gameHistoryRepository';
import { gameHistoryMigration } from '../persistence/migrations/002-game-history';
import { botHistoryIsBotMigration } from '../persistence/migrations/014-bot-history-is-bot';
import type { MongoDatabase } from '../persistence/mongoClient';
import { GAME_HISTORY_COLLECTION_NAME } from '../persistence/mongoCollections';
import { BotAccountRepository } from './botAccountRepository';
import { botAccountsMigration } from '../persistence/migrations/013-bot-accounts';
import { BotStatsRepository } from './botStatsRepository';
import { BotStatsService } from './botStatsService';

const HUMAN_ID = new ObjectId().toHexString();

type SeededPlayer = { playerId: string, displayName: string, profileId: string, isBot: boolean };

function player(id: string, displayName: string, isBot: boolean, profileId = id): SeededPlayer {
    return { playerId: id, displayName, profileId, isBot };
}

function botPlayer(botProfileId: string): SeededPlayer {
    return player(`seat-bot`, `Strix`, true, botProfileId);
}

/** A finished game document, minimal but schema-shaped where the stats read it. */
function finishedGame(options: {
    id: string;
    players: SeededPlayer[];
    winner: string | null;
    reason: string | null;
    finishedAt: number;
    moves?: { playerId: string, timestamp: number }[];
}): Record<string, unknown> {
    return {
        id: options.id,
        version: 3,
        sessionId: `session-${options.id}`,
        startedAt: options.finishedAt - 60_000,
        finishedAt: options.finishedAt,
        players: options.players,
        playerTiles: {},
        gameOptions: { visibility: `public`, timeControl: { mode: `unlimited` }, rated: false, firstPlayer: `random` },
        moves: (options.moves ?? []).map((move, index) => ({ moveNumber: index + 1, playerId: move.playerId, x: index, y: 0, timestamp: move.timestamp })),
        moveCount: options.moves?.length ?? 0,
        gameResult: options.reason === null ? null : {
            winningPlayerId: options.winner,
            abortedByPlayerId: null,
            durationMs: 60_000,
            reason: options.reason,
        },
        tournament: null,
    };
}

async function withService(
    run: (context: {
        service: BotStatsService;
        stats: BotStatsService;
        games: Collection<Document>;
        history: GameHistoryRepository;
        botProfileId: string;
    }) => Promise<void>,
): Promise<void> {
    const server = await MongoMemoryServer.create();
    const client = new MongoClient(server.getUri());
    try {
        await client.connect();
        const database = client.db(`bot-stats-test`);
        const logger = pino({ level: `silent` });
        for (const migration of [gameHistoryMigration, botAccountsMigration, botHistoryIsBotMigration]) {
            await migration.up({ database, logger });
        }

        const mongoDatabase = { getDatabase: async () => database } as MongoDatabase;
        const history = new GameHistoryRepository(logger, mongoDatabase);
        const statsRepository = new BotStatsRepository(logger, mongoDatabase);
        const accounts = new BotAccountRepository(logger, mongoDatabase);
        const account = await accounts.create(`owner-1`, `Strix`);
        const botProfileId = account.id;
        const service = new BotStatsService(
            logger,
            { addEventHandlers: () => () => { }, getSession: () => null } as never,
            accounts,
            history,
            statsRepository,
        );

        await run({ service, stats: service, games: database.collection(GAME_HISTORY_COLLECTION_NAME), history, botProfileId });
    } finally {
        await client.close();
        await server.stop();
    }
}

test(`stats split outcomes, opponents, reasons, think time and last seen`, async () => {
    await withService(async ({ service, games, botProfileId }) => {
        const botSeat = botPlayer(botProfileId);
        await games.insertMany([
            finishedGame({
                id: `win-human`,
                players: [botSeat, player(`seat-human`, `Timmy`, false, HUMAN_ID)],
                winner: `seat-bot`,
                reason: `six-in-a-row`,
                finishedAt: 1_000,
                moves: [
                    { playerId: `seat-human`, timestamp: 0 },
                    { playerId: `seat-bot`, timestamp: 3_000 },
                    { playerId: `seat-bot`, timestamp: 3_000 },
                ],
            }),
            finishedGame({
                id: `loss-seal`,
                players: [botSeat, player(`seat-seal`, `SealBot 0.3s`, true)],
                winner: `seat-seal`,
                reason: `timeout`,
                finishedAt: 2_000,
                moves: [
                    { playerId: `seat-seal`, timestamp: 0 },
                    { playerId: `seat-bot`, timestamp: 9_000 },
                    { playerId: `seat-bot`, timestamp: 9_000 },
                ],
            }),
            finishedGame({
                id: `loss-seal-stronger`,
                players: [botSeat, player(`seat-seal`, `SealBot 1s`, true)],
                winner: `seat-seal`,
                reason: `surrender`,
                finishedAt: 3_000,
            }),
            finishedGame({
                id: `draw-human`,
                players: [botSeat, player(`seat-human-2`, `Mantis`, false, HUMAN_ID)],
                winner: null,
                reason: `disconnect`,
                finishedAt: 4_000,
            }),
            finishedGame({
                id: `aborted-lobby`,
                players: [botSeat, player(`seat-human-3`, `Wren`, false, HUMAN_ID)],
                winner: null,
                reason: `aborted`,
                finishedAt: 5_000,
            }),
        ]);

        const stats = await service.getFor(botProfileId);

        assert.deepEqual(stats.overall, { games: 4, wins: 1, losses: 2, draws: 1 });
        assert.deepEqual(stats.vsHumans, { games: 2, wins: 1, losses: 0, draws: 1 });
        assert.deepEqual(stats.vsBots, { games: 2, wins: 0, losses: 2, draws: 0 });
        assert.deepEqual(stats.lossesByReason, { timeout: 1, surrender: 1 });

        /* The de-facto ladder: one entry per opponent seat name, strongest first by games. */
        assert.deepEqual(stats.vsBotByOpponent.map(({ opponent, record }) => ({ opponent, record })), [
            { opponent: `SealBot 0.3s`, record: { games: 1, wins: 0, losses: 1, draws: 0 } },
            { opponent: `SealBot 1s`, record: { games: 1, wins: 0, losses: 1, draws: 0 } },
        ]);

        /* Both measured thinks are 3 s and 9 s; the pair's shared timestamp counts once. */
        assert.equal(stats.medianThinkMs, 6_000);
        assert.equal(stats.lastSeenAt, 4_000);
    });
});

test(`a bot without games reads as zeroes, an unknown bot is a 404`, async () => {
    await withService(async ({ service, botProfileId }) => {
        const empty = await service.getFor(botProfileId);
        assert.deepEqual(empty.overall, { games: 0, wins: 0, losses: 0, draws: 0 });
        assert.equal(empty.medianThinkMs, null);
        assert.equal(empty.lastSeenAt, null);

        await assert.rejects(
            () => service.getFor(new ObjectId().toHexString()),
            (error: unknown) => (error as { statusCode?: number }).statusCode === 404,
        );
    });
});


test(`the history answers the vs filter over any seat`, async () => {
    await withService(async ({ history, games, botProfileId }) => {
        const botSeat = botPlayer(botProfileId);
        await games.insertMany([
            finishedGame({
                id: `human-game`,
                players: [player(`seat-a`, `Timmy`, false, HUMAN_ID), player(`seat-b`, `Mantis`, false, HUMAN_ID)],
                winner: `seat-a`,
                reason: `six-in-a-row`,
                finishedAt: 1_000,
            }),
            finishedGame({
                id: `bot-game`,
                players: [botSeat, player(`seat-human`, `Timmy`, false, HUMAN_ID)],
                winner: `seat-bot`,
                reason: `six-in-a-row`,
                finishedAt: 2_000,
            }),
        ]);

        const bots = await history.listFinishedGames({ vsFilter: `bots` });
        const humans = await history.listFinishedGames({ vsFilter: `humans` });
        const all = await history.listFinishedGames({});

        assert.deepEqual(bots.games.map((game) => game.id), [`bot-game`]);
        assert.deepEqual(humans.games.map((game) => game.id), [`human-game`]);
        assert.equal(all.games.length, 2);
    });
});

test(`the cache serves reads and a rebuild picks up new games`, async () => {
    await withService(async ({ service, games, botProfileId }) => {
        const botSeat = botPlayer(botProfileId);
        await games.insertOne(finishedGame({
            id: `first`,
            players: [botSeat, player(`seat-human`, `Timmy`, false, HUMAN_ID)],
            winner: `seat-bot`,
            reason: `six-in-a-row`,
            finishedAt: 1_000,
        }));

        const first = await service.getFor(botProfileId);
        assert.equal(first.overall.games, 1);

        /* A game that lands after the cache was written is invisible until a rebuild —
         * exactly what the finish edge schedules. */
        await games.insertOne(finishedGame({
            id: `second`,
            players: [botSeat, player(`seat-human`, `Timmy`, false, HUMAN_ID)],
            winner: `seat-bot`,
            reason: `six-in-a-row`,
            finishedAt: 2_000,
        }));
        const cached = await service.getFor(botProfileId);
        assert.equal(cached.overall.games, 1, `the cache, not the aggregation, serves reads`);
        assert.equal(cached.generatedAt, first.generatedAt);

        const rebuilt = await service.rebuildFor(botProfileId);
        assert.equal(rebuilt.overall.games, 2);
        assert.equal(rebuilt.lastSeenAt, 2_000);
    });
});

test(`a javascript: repo url never passes the declaration schema`, () => {
    /* The profile renders the declared repo as a live link; the scheme guard lives
     * at the parse boundary, so nothing unsafe can be stored to begin with. */
    assert.equal(zBotDeclarationPatch.safeParse({ repoUrl: `javascript:alert(1)` }).success, false);
    assert.equal(zBotDeclarationPatch.safeParse({ repoUrl: `data:text/html,no` }).success, false);
    assert.equal(zBotDeclarationPatch.safeParse({ repoUrl: `https://github.com/x/y` }).success, true);
    assert.equal(zBotDeclarationPatch.safeParse({ repoUrl: `` }).success, true, `an empty string still clears`);
});
