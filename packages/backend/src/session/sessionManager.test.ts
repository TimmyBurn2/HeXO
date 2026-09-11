import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { type SessionId } from '@ih3t/shared';
import pino from 'pino';

import { GameSimulation } from '../simulation/gameSimulation';
import { GameTimeControlManager } from '../simulation/gameTimeControlManager';
import { SessionManager } from './sessionManager';
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
    options: { sessionId?: string } = {},
): ServerGameSession {
    const sessionId = (options.sessionId ?? `session-play`) as SessionId;
    const session = createGameSession(sessionId, {
        visibility: `private`,
        rated: false,
        timeControl: { mode: `unlimited` },
        firstPlayer: `host`,
    });

    for (const id of [HOST, GUEST]) {
        session.players.push({
            id,
            deviceId: `device-${id}`,
            profileId: id,
            displayName: id,
            rating: { eloScore: 1_000, gameCount: 0 },
            ratingAdjustment: null,
            ratingAdjusted: null,
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
