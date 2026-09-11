import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { type SessionId, type SessionUpdatedEvent } from '@ih3t/shared';
import pino from 'pino';

import type { AccountUserProfile } from '../auth/authRepository';
import type { AuthRepository } from '../auth/authRepository';
import type { EloHandler } from '../elo/eloHandler';
import { SessionError, SessionManager } from '../session/sessionManager';
import { createGameSession, type ServerGameSession } from '../session/types';
import { GameSimulation } from '../simulation/gameSimulation';
import { GameTimeControlManager } from '../simulation/gameTimeControlManager';
import type { BotAccountRepository } from './botAccountRepository';
import { BotMoveError, BotPlayService } from './botPlayService';
import { BotStreamRegistry } from './botStreamRegistry';

const BOT_PROFILE_ID = `bot-1`;
const OWNER_PROFILE_ID = `owner-1`;
const BOT_SEAT = `seat-bot`;
const HUMAN_SEAT = `seat-human`;
const GAME_ID = `game-abc`;

const BOT_PROFILE: AccountUserProfile = {
    id: BOT_PROFILE_ID,
    username: `Strix`,
    email: null,
    image: null,
    role: `user`,
    kind: `bot`,
    permissions: [],
    registeredAt: 0,
    lastActiveAt: 0,
};

const OWNER_PROFILE: AccountUserProfile = { ...BOT_PROFILE, id: OWNER_PROFILE_ID, username: `Timmy`, kind: `human` };

type Fixture = {
    sessionManager: SessionManager;
    session: ServerGameSession;
    service: BotPlayService;
    registry: BotStreamRegistry;
    gameResults: (`win` | `loss`)[];
};

function move(cells: { q: number, r: number }[], requestId?: number): unknown {
    return { move: { pieces: cells }, ...(requestId === undefined ? {} : { request_id: requestId }) };
}

function createFixture(): Fixture {
    const gameResults: (`win` | `loss`)[] = [];
    const sessionManager = new SessionManager(
        pino({ level: `silent` }),
        { createShutdownHook: () => ({ tryShutdown: () => { } }) } as never,
        new GameSimulation(),
        new GameTimeControlManager(),
        {
            getPlayerRating: () => Promise.resolve({ eloScore: 1_000, gameCount: 0 }),
            applyGameResult: async (_playerId: string, _adjustment: never, result: `win` | `loss`) => {
                gameResults.push(result);
                return { eloScore: 1_012, gameCount: 1 };
            },
        } as never,
        { appendMove: () => Promise.resolve(), finishGame: () => Promise.resolve() } as never,
        { track: () => { } } as never,
        {} as never,
    );

    const sessionId = `bot-session` as SessionId;
    const session = createGameSession(sessionId, {
        visibility: `private`,
        rated: false,
        timeControl: { mode: `turn`, turnTimeMs: 45_000 },
        firstPlayer: `host`,
    });

    for (const [id, isBot] of [[HUMAN_SEAT, false], [BOT_SEAT, true]] as const) {
        session.players.push({
            id,
            deviceId: `device-${id}`,
            profileId: isBot ? BOT_PROFILE_ID : `human-1`,
            displayName: id,
            rating: { eloScore: 1_000, gameCount: 0 },
            ratingAdjustment: null,
            ratingAdjusted: null,
            isBot,
            connection: { status: `connected`, socketId: `socket-${id}` },
        });
    }

    session.state = `in-game`;
    session.startedAt = Date.now();
    session.gameId = GAME_ID;
    session.currentTurnExpiresAt = session.startedAt + 45_000;
    new GameSimulation().startSession(session.gameState, [HUMAN_SEAT, BOT_SEAT], HUMAN_SEAT);
    (sessionManager as unknown as { sessions: Map<string, ServerGameSession> }).sessions.set(sessionId, session);

    const registry = new BotStreamRegistry(pino({ level: `silent` }), sessionManager);
    const botAccountRepository = {
        findById: () => Promise.resolve({
            id: BOT_PROFILE_ID,
            username: `Strix`,
            image: null,
            ownerProfileId: OWNER_PROFILE_ID,
            createdAt: 0,
            tokenRotatedAt: null,
        }),
    };
    const authRepository = {
        getUserProfileById: (id: string) => Promise.resolve(id === OWNER_PROFILE_ID ? OWNER_PROFILE : null),
    };
    const eloHandler = { getPlayerRating: () => Promise.resolve({ eloScore: 1_337, gameCount: 4 }) };

    const service = new BotPlayService(
        sessionManager,
        registry,
        botAccountRepository as unknown as BotAccountRepository,
        authRepository as unknown as AuthRepository,
        eloHandler as unknown as EloHandler,
    );

    return { sessionManager, session, service, registry, gameResults };
}

function playTest(name: string, body: (fixture: Fixture) => Promise<void>): void {
    test(name, async () => {
        const fixture = createFixture();
        try {
            await body(fixture);
        } finally {
            fixture.registry.detach();
            (fixture.sessionManager as unknown as { timeControl: { dispose: () => void } }).timeControl.dispose();
        }
    });
}

async function rejection(body: () => Promise<void>): Promise<BotMoveError> {
    try {
        await body();
    } catch (error: unknown) {
        assert.ok(error instanceof BotMoveError, `expected a BotMoveError, got ${String(error)}`);
        return error;
    }

    throw new Error(`the move was accepted`);
}

function toLobby(session: ServerGameSession, options: { keepSeats?: boolean } = {}): void {
    session.state = `lobby`;
    session.gameId = ``;
    session.startedAt = null;
    session.currentTurnExpiresAt = null;
    if (!options.keepSeats) {
        session.players.length = 0;
    }
}

playTest(`a bot claims a seat in a lobby`, async ({ session, service }) => {
    toLobby(session);

    await service.joinSession(BOT_PROFILE, session.id);

    assert.equal(session.players.length, 1);
    assert.equal(session.players[0]?.profileId, BOT_PROFILE_ID);
    assert.equal(session.players[0]?.isBot, true);
});

playTest(`a bot joining a rated lobby unrates it before the game starts`, async ({ sessionManager, session, service }) => {
    /* The ?join= path into a human lobby that asked for a rating. */
    toLobby(session, { keepSeats: true });
    session.players.length = 1;
    session.gameOptions.rated = true;
    /* Seated but not connected, so nothing can start the game out from under the join. */
    session.players[0].connection = { status: `disconnected`, timestamp: 0 };

    const updates: SessionUpdatedEvent[] = [];
    sessionManager.addEventHandlers({
        sessionUpdated: (event) => { updates.push(event); },
    });

    await service.joinSession(BOT_PROFILE, session.id);

    assert.equal(session.gameOptions.rated, false, `the lobby flipped to unrated`);
    assert.equal(session.state, `lobby`, `and it is still a lobby, not a game`);

    const update = updates.filter((event) => event.session.gameOptions).at(-1);
    assert.ok(update, `the session update carries the gameOptions`);
    assert.equal(update.session.gameOptions?.rated, false, `the human's lobby info says unrated before the start`);
});

playTest(`joining twice reclaims the same seat`, async ({ session, service }) => {
    toLobby(session);

    await service.joinSession(BOT_PROFILE, session.id);
    await service.joinSession(BOT_PROFILE, session.id);
    await service.joinSession(BOT_PROFILE, session.id);

    /* A second seat would start a game the bot plays against itself and only ever
     * answers one side of. */
    assert.equal(session.players.length, 1);
});

playTest(`a bot cannot join a game that has already started`, async ({ session, service }) => {
    session.players.length = 1;

    await assert.rejects(
        () => service.joinSession(BOT_PROFILE, session.id),
        /already started/,
    );
    assert.equal(session.players.length, 1);
    assert.equal(session.spectators.length, 0);
});

playTest(`a bot cannot take a seat in a full lobby, and leaves no spectator`, async ({ session, service }) => {
    toLobby(session, { keepSeats: true });
    session.players[1].profileId = `someone-else`;

    await assert.rejects(
        () => service.joinSession(BOT_PROFILE, session.id),
        /no seat left/,
    );
    assert.equal(session.players.length, 2);
    assert.equal(session.spectators.length, 0);
});

playTest(`a legal turn applies both stones`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    await service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }]));

    assert.equal(session.gameState.cells.length, 3);
    assert.equal(session.gameState.currentTurnPlayerId, HUMAN_SEAT);
});

playTest(`a move in someone else's turn is not-your-turn`, async ({ service }) => {
    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 2, r: 0 }])));

    assert.equal(error.code, `not-your-turn`);
    assert.equal(error.statusCode, 400);
});

playTest(`a move onto a placed stone is occupied`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 0, r: 0 }, { q: 1, r: 0 }])));

    assert.equal(error.code, `occupied`);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`two placements on one cell are occupied`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 1, r: 0 }])));

    assert.equal(error.code, `occupied`);
});

playTest(`a move beyond the placement radius is out-of-range`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 40, r: 0 }, { q: 41, r: 0 }])));

    assert.equal(error.code, `out-of-range`);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`a move in a finished game is game-over`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    await sessionManager.surrenderSession(session, HUMAN_SEAT);

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }])));

    assert.equal(error.code, `game-over`);
});

playTest(`a move for a game that is not running is game-over`, async ({ service }) => {
    const error = await rejection(() => service.playMove(BOT_PROFILE, `game-nope`, move([{ q: 1, r: 0 }, { q: 2, r: 0 }])));

    assert.equal(error.code, `game-over`);
});

playTest(`a resign hands the win to the opponent and applies the rating`, async ({ session, service, gameResults }) => {
    session.isRatedGame = true;
    for (const player of session.players) {
        player.ratingAdjustment = { eloGain: 12, eloLoss: -12 };
    }

    await service.resignGame(BOT_PROFILE, GAME_ID);

    assert.equal(session.state, `finished`);
    assert.equal(session.finishReason, `surrender`);
    assert.equal(session.winningPlayerId, HUMAN_SEAT);
    for (const player of session.players) {
        assert.deepEqual(player.ratingAdjusted, { eloScore: 1_012, gameCount: 1 });
    }
    assert.deepEqual(gameResults, [`win`, `loss`], `the human seat is the winner`);
});

playTest(`a second resign leaves the recorded result alone`, async ({ sessionManager, session, service }) => {
    await sessionManager.surrenderSession(session, HUMAN_SEAT);

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `finished`);
    assert.equal(session.winningPlayerId, BOT_SEAT);
    assert.equal(session.finishReason, `surrender`);
});

playTest(`resigning before the game starts is game-over`, async ({ session, service }) => {
    toLobby(session, { keepSeats: true });

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `lobby`);
});

playTest(`resigning a game the bot is not seated in is rejected`, async ({ session, service }) => {
    session.players[1].profileId = `another-bot`;

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, null);
    assert.equal(session.state, `in-game`);
});

playTest(`resigning an unknown game is game-over`, async ({ service }) => {
    const error = await rejection(() => service.resignGame(BOT_PROFILE, `game-nope`));

    assert.equal(error.code, `game-over`);
});

playTest(`resigning a session that never left the lobby is game-over`, async ({ session, service }) => {
    session.state = `lobby`;

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `lobby`);
});

playTest(`a resign that loses a race still answers game-over`, async ({ sessionManager, session, service }) => {
    (sessionManager as unknown as { surrenderSession: () => Promise<void> }).surrenderSession = async () => {
        throw new SessionError(`Game is not currently active`);
    };

    const error = await rejection(() => service.resignGame(BOT_PROFILE, GAME_ID));

    assert.equal(error.code, `game-over`);
    assert.equal(session.state, `in-game`, `nothing was applied`);
});

playTest(`an answer to an earlier position is stale-request`, async ({ sessionManager, session, service, registry }) => {
    registry.attach();
    registry.open(BOT_PROFILE, {
        setHeader: () => undefined,
        flushHeaders: () => undefined,
        write: () => true,
        end: () => undefined,
        destroy: () => undefined,
        on: () => undefined,
        writableLength: 0,
    }, false);
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 1, r: 0 }, { q: 0, r: 1 }], 0)));

    assert.equal(error.code, `stale-request`);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`a rejected move leaves the clock running`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });
    const expiresAt = session.currentTurnExpiresAt;

    await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, move([{ q: 0, r: 0 }, { q: 1, r: 0 }])));

    assert.equal(session.state, `in-game`);
    assert.equal(session.currentTurnExpiresAt, expiresAt);
    assert.equal(session.gameState.currentTurnPlayerId, BOT_SEAT);
});

playTest(`a malformed body is refused before the session is touched`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const error = await rejection(() => service.playMove(BOT_PROFILE, GAME_ID, { move: { pieces: [{ q: 1, r: 0 }] } }));

    assert.equal(error.code, null);
    assert.equal(session.gameState.cells.length, 1);
});

playTest(`an account carries the bot, its owner and its running games`, async ({ sessionManager, session, service }) => {
    await sessionManager.placeCell(session, HUMAN_SEAT, { x: 0, y: 0 });

    const account = await service.getAccount(BOT_PROFILE);

    assert.deepEqual(account.bot, { profileId: BOT_PROFILE_ID, displayName: `Strix`, elo: 1_337 });
    assert.deepEqual(account.owner, { profileId: OWNER_PROFILE_ID, displayName: `Timmy`, elo: 1_337 });
    assert.deepEqual(account.activeGames, [{ gameId: session.gameId, side: `o` }]);
});
