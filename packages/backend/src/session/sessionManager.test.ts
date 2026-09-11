import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { type SessionId } from '@ih3t/shared';
import pino from 'pino';

import { GameSimulation } from '../simulation/gameSimulation';
import { GameTimeControlManager } from '../simulation/gameTimeControlManager';
import { RESERVED_LOBBY_ABANDONED_AFTER_MS, SessionManager } from './sessionManager';
import { createGameSession, type ServerGameSession } from './types';

class DelayedGameHistoryRepository {
    private startResolver: () => void = () => {};
    private releaseResolver: () => void = () => {};
    readonly finishStarted = new Promise<void>((resolve) => {
        this.startResolver = resolve;
    });
    private readonly releaseFinish = new Promise<void>((resolve) => {
        this.releaseResolver = resolve;
    });
    finalized = false;

    release(): void {
        this.releaseResolver();
    }

    async finishGame(): Promise<void> {
        this.startResolver();
        await this.releaseFinish;
        this.finalized = true;
    }
}

function createSessionManager(gameHistoryRepository: DelayedGameHistoryRepository): SessionManager {
    const serverShutdownService = {
        createShutdownHook: () => ({ tryShutdown: () => {} }),
    };
    const metricsTracker = { track: () => {} };

    return new SessionManager(
        pino({ level: `silent` }),
        serverShutdownService as never,
        new GameSimulation(),
        new GameTimeControlManager(),
        {} as never,
        gameHistoryRepository as never,
        metricsTracker as never,
        {} as never,
    );
}

test(`finishing a session waits for its durable game result`, async () => {
    const gameHistoryRepository = new DelayedGameHistoryRepository();
    const sessionManager = createSessionManager(gameHistoryRepository);
    const sessionId = `session-persistence` as SessionId;
    const session = createGameSession(sessionId, {
        visibility: `private`,
        rated: false,
        timeControl: { mode: `unlimited` },
        firstPlayer: `host`,
    });
    session.state = `in-game`;
    session.startedAt = Date.now() - 1_000;
    session.gameId = `game-persistence`;

    (sessionManager as unknown as {
        sessions: Map<string, ServerGameSession>;
    }).sessions.set(sessionId, session);

    let finishResolved = false;
    const finishPromise = sessionManager.terminateActiveSession(sessionId).then((result) => {
        finishResolved = true;
        return result;
    });

    await gameHistoryRepository.finishStarted;
    await Promise.resolve();
    assert.equal(finishResolved, false);

    gameHistoryRepository.release();
    const finishedSession = await finishPromise;

    assert.equal(gameHistoryRepository.finalized, true);
    assert.equal(finishedSession.state.status, `finished`);
});

class FakeGameHistoryRepository {
    readonly moves: unknown[] = [];

    appendMove(...args: unknown[]): Promise<void> {
        this.moves.push(args);
        return Promise.resolve();
    }

    finishGame(): Promise<void> {
        return Promise.resolve();
    }
}

const HOST = `player-host`;
const GUEST = `player-guest`;

function createStartedSession(
    sessionManager: SessionManager,
    options: { sessionId?: string, guestIsBot?: boolean } = {},
): ServerGameSession {
    const sessionId = (options.sessionId ?? `session-play`) as SessionId;
    const session = createGameSession(sessionId, {
        visibility: `private`,
        rated: false,
        timeControl: { mode: `unlimited` },
        firstPlayer: `host`,
    });

    for (const [id, isBot] of [[HOST, false], [GUEST, options.guestIsBot ?? false]] as const) {
        session.players.push({
            id,
            deviceId: `device-${id}`,
            profileId: id,
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
    session.gameId = `game-play`;
    new GameSimulation().startSession(session.gameState, [HOST, GUEST], HOST);

    (sessionManager as unknown as {
        sessions: Map<string, ServerGameSession>;
    }).sessions.set(sessionId, session);

    return session;
}

function createPlaySessionManager(): SessionManager {
    return createSessionManager(new FakeGameHistoryRepository() as unknown as DelayedGameHistoryRepository);
}

test(`an added subscriber hears the finish without displacing the primary one`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);
    const primary: string[] = [];
    const extra: string[] = [];

    sessionManager.setEventHandlers({ gameFinished: () => primary.push(`primary`) });
    const unsubscribe = sessionManager.addEventHandlers({
        gameFinished: (event) => extra.push(event.reason),
    });

    await sessionManager.surrenderSession(session, HOST);

    assert.deepEqual(primary, [`primary`]);
    assert.deepEqual(extra, [`surrender`]);

    unsubscribe();
    const second = createStartedSession(sessionManager, { sessionId: `session-play-2` });
    await sessionManager.surrenderSession(second, HOST);

    assert.deepEqual(primary, [`primary`, `primary`]);
    assert.deepEqual(extra, [`surrender`], `an unsubscribed handler must stop hearing events`);
});

test(`a subscriber that throws does not break the game it watches`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);
    sessionManager.addEventHandlers({
        gameCellPlacement: () => {
            throw new Error(`subscriber is broken`);
        },
    });

    await sessionManager.placeCell(session, HOST, { x: 0, y: 0 });

    assert.equal(session.gameState.cells.length, 1);
});

test(`a turn placed through placeCells applies both stones`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);

    await sessionManager.placeCell(session, HOST, { x: 0, y: 0 });
    await sessionManager.placeCells(session, GUEST, [{ x: 1, y: 0 }, { x: 0, y: 1 }]);

    assert.equal(session.gameState.cells.length, 3);
    assert.equal(session.gameState.currentTurnPlayerId, HOST);
});

test(`placeCells applies nothing when the second placement is illegal`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);

    await sessionManager.placeCell(session, HOST, { x: 0, y: 0 });
    await assert.rejects(
        () => sessionManager.placeCells(session, GUEST, [{ x: 1, y: 0 }, { x: 0, y: 0 }]),
        /occupied/i,
    );

    /* The half turn must not be reachable: the first stone is not on the board. */
    assert.equal(session.gameState.cells.length, 1);
    assert.equal(session.gameState.currentTurnPlayerId, GUEST);
    assert.equal(session.gameState.placementsRemaining, 2);
});

test(`placeCells refuses a turn that is not the caller's`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);

    await assert.rejects(
        () => sessionManager.placeCells(session, GUEST, [{ x: 0, y: 0 }, { x: 1, y: 0 }]),
        /not your turn/i,
    );
    assert.equal(session.gameState.cells.length, 0);
});

test(`placeCells applies nothing once the turn clock has run out`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);
    await sessionManager.placeCell(session, HOST, { x: 0, y: 0 });
    session.currentTurnExpiresAt = Date.now() - 1;

    await assert.rejects(
        () => sessionManager.placeCells(session, GUEST, [{ x: 1, y: 0 }, { x: 0, y: 1 }]),
    );
    assert.equal(session.gameState.cells.length, 1);
});

test(`a session is found by its game id, and a lobby by nothing`, () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);

    assert.equal(sessionManager.getSessionByGameId(`game-play`), session);
    assert.equal(sessionManager.getSessionByGameId(`game-other`), null);
    /* A lobby has an empty game id; that must never match another lobby's. */
    assert.equal(sessionManager.getSessionByGameId(``), null);
});

test(`a profile's seats are found across sessions`, () => {
    const sessionManager = createPlaySessionManager();
    createStartedSession(sessionManager);
    createStartedSession(sessionManager, { sessionId: `session-play-2` });

    const seats = sessionManager.getPlayerParticipationsByProfileId(HOST);

    assert.equal(seats.length, 2);
    assert.ok(seats.every((seat) => seat.role === `player` && seat.participant.profileId === HOST));
    assert.equal(sessionManager.getPlayerParticipationsByProfileId(`nobody`).length, 0);
});

test(`a draw cannot be offered in a game with a bot in it`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager, { guestIsBot: true });

    await assert.rejects(
        () => sessionManager.requestDraw(session, HOST),
        /cannot end in a draw/i,
    );
    assert.equal(session.drawRequest, null);
});

test(`a draw is still offerable between two humans`, async () => {
    const sessionManager = createPlaySessionManager();
    const session = createStartedSession(sessionManager);
    session.drawRequestAvailableAfterTurn = 0;

    await sessionManager.requestDraw(session, HOST);

    assert.equal(session.drawRequest, HOST);
});

function createReservedBotLobby(
    sessionManager: SessionManager,
    options: { sessionId?: string, pendingChallengeId?: string } = {},
): ServerGameSession {
    const session = createGameSession((options.sessionId ?? `session-reserved`) as SessionId, {
        visibility: `private`,
        rated: false,
        timeControl: { mode: `unlimited` },
        firstPlayer: `random`,
    }, {
        reservedPlayerProfileIds: [HOST, GUEST],
        pendingChallengeId: options.pendingChallengeId,
    });

    session.players.push({
        id: HOST,
        deviceId: `device-${HOST}`,
        profileId: HOST,
        displayName: HOST,
        rating: { eloScore: 1_000, gameCount: 0 },
        ratingAdjustment: null,
        ratingAdjusted: null,
        isBot: true,
        connection: { status: `connected`, socketId: `socket-${HOST}` },
    });
    session.hadPlayers = true;

    (sessionManager as unknown as {
        sessions: Map<string, ServerGameSession>;
    }).sessions.set(session.id, session);

    return session;
}

test(`a pending challenge lobby outlives the reserved-lobby reaper`, async () => {
    const sessionManager = createPlaySessionManager();
    const challenge = createReservedBotLobby(sessionManager, { pendingChallengeId: `challenge-1` });
    const play = createReservedBotLobby(sessionManager, { sessionId: `session-play-flow` });
    challenge.createdAt = Date.now() - RESERVED_LOBBY_ABANDONED_AFTER_MS - 1_000;
    play.createdAt = Date.now() - RESERVED_LOBBY_ABANDONED_AFTER_MS - 1_000;

    await sessionManager.tickAllSessions();

    assert.equal(sessionManager.getSession(challenge.id), challenge, `the TTL sweep owns challenge expiry`);
    assert.equal(sessionManager.getSession(play.id), null, `an abandoned Play is still reaped`);
});

test(`deleteLobby removes a lobby and refuses a started game`, async () => {
    const sessionManager = createPlaySessionManager();
    const lobby = createReservedBotLobby(sessionManager);
    const started = createStartedSession(sessionManager);

    assert.equal(await sessionManager.deleteLobby(lobby, `challenge-declined`), true);
    assert.equal(sessionManager.getSession(lobby.id), null);

    assert.equal(await sessionManager.deleteLobby(started, `challenge-declined`), false);
    assert.equal(sessionManager.getSession(started.id), started);
});

test(`a pending challenge does not spend a concurrent-game slot`, () => {
    const sessionManager = createPlaySessionManager();
    const lobby = createReservedBotLobby(sessionManager, { pendingChallengeId: `challenge-1` });

    assert.equal(sessionManager.countActivePlayerSessionsByProfileId(HOST), 0);

    lobby.pendingChallengeId = null;
    assert.equal(sessionManager.countActivePlayerSessionsByProfileId(HOST), 1, `an ordinary lobby seat still counts`);
});
