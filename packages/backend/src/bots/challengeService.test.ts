import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { type BotChallenge } from '@ih3t/shared';
import pino from 'pino';

import type { AccountUserProfile } from '../auth/authRepository';
import { ApiRequestError } from '../network/rest/apiQueryService';
import { SessionManager } from '../session/sessionManager';
import type { ServerGameSession } from '../session/types';
import { GameSimulation } from '../simulation/gameSimulation';
import { GameTimeControlManager } from '../simulation/gameTimeControlManager';
import { BotChallengeError, ChallengeService } from './challengeService';

const OWNER_PROFILE_ID = `owner-1`;
const CHALLENGER_ID = `bot-a`;
const TARGET_ID = `bot-b`;
const OTHER_TARGET_ID = `bot-c`;
const HUMAN_ID = `human-1`;

const UNLIMITED = { mode: `unlimited` } as const;

function profile(id: string, kind: `human` | `bot` = `bot`): AccountUserProfile {
    return {
        id,
        username: id,
        email: null,
        image: null,
        role: `user`,
        kind,
        permissions: [],
        registeredAt: 0,
        lastActiveAt: 0,
    };
}

type Fixture = {
    sessionManager: SessionManager;
    service: ChallengeService;
    sessions: Map<string, ServerGameSession>;
    events: Map<string, unknown[]>;
    entries: Map<string, unknown>;
    online: Set<string>;
    open: Set<string>;
    sweep: () => Promise<void>;
};

function createFixture(options: {
    online?: string[],
    open?: string[],
    inboxLimit?: number,
    ttlMs?: number,
} = {}): Fixture {
    const online = new Set(options.online ?? [CHALLENGER_ID, TARGET_ID, OTHER_TARGET_ID, `bot-x`, `bot-y`, `bot-z`]);
    const open = new Set(options.open ?? [TARGET_ID, OTHER_TARGET_ID, `bot-y`, `bot-z`]);
    const events = new Map<string, unknown[]>();

    const sessionManager = new SessionManager(
        pino({ level: `silent` }),
        { createShutdownHook: () => ({ tryShutdown: () => { } }), isShutdownPending: () => false } as never,
        new GameSimulation(),
        new GameTimeControlManager(),
        { getPlayerRating: () => Promise.resolve({ eloScore: 1_000, gameCount: 0 }) } as never,
        {
            createGame: async () => `game-1`,
            appendMove: async () => { },
            finishGame: async () => { },
        } as never,
        { track: () => { } } as never,
        { getSettings: () => ({ maxConcurrentGames: null }) } as never,
    );

    const service = new ChallengeService(
        pino({ level: `silent` }),
        {
            challengeTtlMs: options.ttlMs ?? 300_000,
            challengeInboxLimit: options.inboxLimit ?? 10,
        } as never,
        sessionManager,
        {
            isOnline: (id: string) => online.has(id),
            isOpenForChallenges: (id: string) => open.has(id),
            getSocketId: (id: string) => `bot:${id}`,
            emitToBot: (id: string, event: unknown) => {
                const lines = events.get(id) ?? [];
                lines.push(event);
                events.set(id, lines);
            },
        } as never,
        {
            getUserProfileById: async (id: string) => {
                if (id === HUMAN_ID) {
                    return profile(HUMAN_ID, `human`);
                }

                return [CHALLENGER_ID, TARGET_ID, OTHER_TARGET_ID, `bot-x`, `bot-y`, `bot-z`].includes(id)
                    ? profile(id)
                    : null;
            },
        } as never,
        { getPlayerRating: async () => ({ eloScore: 1_234, gameCount: 5 }) } as never,
        {
            findById: async (id: string) =>
                [CHALLENGER_ID, TARGET_ID, OTHER_TARGET_ID, `bot-x`, `bot-y`, `bot-z`].includes(id)
                    ? { id, ownerProfileId: id === CHALLENGER_ID || id === `bot-y` ? OWNER_PROFILE_ID : `owner-2` }
                    : null,
            findByOwner: async (ownerProfileId: string, botProfileId: string) =>
                ownerProfileId === OWNER_PROFILE_ID && botProfileId === CHALLENGER_ID
                    ? { id: CHALLENGER_ID, ownerProfileId }
                    : null,
            listByOwner: async (ownerProfileId: string) =>
                ownerProfileId === OWNER_PROFILE_ID ? [{ id: CHALLENGER_ID }] : [],
        } as never,
    );

    service.attach();

    return {
        sessionManager,
        service,
        sessions: (sessionManager as unknown as { sessions: Map<string, ServerGameSession> }).sessions,
        events,
        entries: (service as unknown as { challenges: Map<string, unknown> }).challenges,
        online,
        open,
        sweep: () => (service as unknown as { sweep: () => Promise<void> }).sweep(),
    };
}

async function challenge(
    fixture: Fixture,
    options: { challenger?: string, target?: string, firstPlayer?: `challenger` | `challenged` | `random` } = {},
): Promise<BotChallenge> {
    return await fixture.service.createChallenge(
        profile(options.challenger ?? CHALLENGER_ID),
        options.target ?? TARGET_ID,
        { ip: `127.0.0.1` } as never,
        {
            timeControl: { ...UNLIMITED },
            firstPlayer: options.firstPlayer ?? `random`,
        },
    );
}

/** Lets the void tickSession chains (game starts) settle before asserting. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

function entryOf(fixture: Fixture, challengeId: string): { session: ServerGameSession, status: string, expiresAt: number } {
    const entry = fixture.entries.get(challengeId) as { session: ServerGameSession, status: string, expiresAt: number };
    assert.ok(entry, `the entry must exist`);
    return entry;
}

test(`creating a challenge seats the challenger and lines the target's stream`, async () => {
    const fixture = createFixture();

    const view = await challenge(fixture);

    assert.equal(view.status, `created`);
    assert.deepEqual(view.challenger, { profileId: CHALLENGER_ID, displayName: CHALLENGER_ID, elo: 1_234 });
    assert.deepEqual(view.destUser, { profileId: TARGET_ID, displayName: TARGET_ID, elo: 1_234 });
    assert.deepEqual(view.timeControl, UNLIMITED);

    const { session } = entryOf(fixture, view.challengeId);
    assert.equal(session.gameOptions.visibility, `private`);
    assert.equal(session.gameOptions.rated, false);
    assert.deepEqual(session.reservedPlayerProfileIds, [CHALLENGER_ID, TARGET_ID]);
    assert.equal(session.pendingChallengeId, view.challengeId);
    assert.equal(session.players.length, 1);
    assert.equal(session.players[0].profileId, CHALLENGER_ID);
    assert.equal(session.players[0].connection.status, `connected`);

    assert.deepEqual(fixture.events.get(TARGET_ID), [{ type: `challenge`, challenge: view }]);
});

test(`firstPlayer maps challenger and challenged onto host and guest`, async () => {
    const fixture = createFixture();

    await challenge(fixture, { firstPlayer: `challenged` });
    const { session } = entryOf(fixture, (await challenge(fixture, { target: OTHER_TARGET_ID, firstPlayer: `challenger` })).challengeId);

    assert.equal(session.gameOptions.firstPlayer, `host`);
});

test(`a human target is rejected with not-a-bot`, async () => {
    const fixture = createFixture();

    await assert.rejects(
        () => challenge(fixture, { target: HUMAN_ID }),
        (error: unknown) => {
            assert.ok(error instanceof BotChallengeError);
            assert.equal(error.code, `not-a-bot`);
            return true;
        },
    );
});

test(`an unknown or deleted target is a 404`, async () => {
    const fixture = createFixture();

    for (const target of [`bot-nope`, `bot-deleted`]) {
        await assert.rejects(
            () => challenge(fixture, { target }),
            (error: unknown) => {
                assert.ok(error instanceof ApiRequestError);
                assert.equal(error.statusCode, 404);
                return true;
            },
        );
    }
});

test(`a bot cannot challenge itself`, async () => {
    const fixture = createFixture();

    await assert.rejects(
        () => challenge(fixture, { target: CHALLENGER_ID }),
        /cannot challenge itself/,
    );
});

test(`a target that is offline or not open is rejected with not-open`, async () => {
    const offline = createFixture({ online: [CHALLENGER_ID], open: [] });
    await assert.rejects(
        () => challenge(offline),
        (error: unknown) => {
            assert.ok(error instanceof BotChallengeError);
            assert.equal(error.code, `not-open`);
            return true;
        },
    );

    const closed = createFixture({ online: [CHALLENGER_ID, TARGET_ID], open: [] });
    await assert.rejects(
        () => challenge(closed),
        (error: unknown) => {
            assert.ok(error instanceof BotChallengeError);
            assert.equal(error.code, `not-open`);
            return true;
        },
    );
});

test(`a target at the concurrent-game cap is rejected with not-open`, async () => {
    const fixture = createFixture();

    for (let index = 0; index < 4; index += 1) {
        const lobby = {
            id: `cap-${index}`,
            lock: { runExclusive: async (fn: () => unknown) => fn() },
            state: `in-game`,
            hadPlayers: true,
            players: [{
                id: `seat-${index}`,
                deviceId: `bot:${TARGET_ID}`,
                profileId: TARGET_ID,
                displayName: TARGET_ID,
                rating: { eloScore: 1_000, gameCount: 0 },
                ratingAdjustment: null,
                ratingAdjusted: null,
                isBot: true,
                connection: { status: `connected`, socketId: `bot:${TARGET_ID}` },
            }],
            spectators: [],
        } as unknown as ServerGameSession;
        fixture.sessions.set(lobby.id, lobby);
    }

    await assert.rejects(
        () => challenge(fixture),
        (error: unknown) => {
            assert.ok(error instanceof BotChallengeError);
            assert.equal(error.code, `not-open`);
            return true;
        },
    );
});

test(`one pending challenge per pair, and the challenger must have a free slot`, async () => {
    const fixture = createFixture();

    await challenge(fixture);
    await assert.rejects(() => challenge(fixture), /already pending/);
    await challenge(fixture, { target: OTHER_TARGET_ID });
});

test(`a pending challenge does not spend a concurrent-game slot`, async () => {
    const fixture = createFixture();

    await challenge(fixture);
    await challenge(fixture, { target: OTHER_TARGET_ID });

    assert.equal(fixture.sessionManager.countActivePlayerSessionsByProfileId(CHALLENGER_ID), 0);
});

test(`pending challenges replay on stream open, incoming only`, async () => {
    const fixture = createFixture();
    await challenge(fixture);
    fixture.events.clear();

    fixture.service.replayPending(profile(TARGET_ID));
    fixture.service.replayPending(profile(CHALLENGER_ID));

    assert.equal((fixture.events.get(TARGET_ID) ?? []).length, 1);
    assert.equal(fixture.events.get(CHALLENGER_ID), undefined, `the challenger holds no line to replay`);
});

test(`listChallenges carries both directions, pending only`, async () => {
    const fixture = createFixture();
    const first = await challenge(fixture);
    await challenge(fixture, { challenger: `bot-x`, target: OTHER_TARGET_ID });
    const fromTarget = await challenge(fixture, { challenger: TARGET_ID, target: `bot-y` });

    const listed = fixture.service.listChallenges(profile(TARGET_ID));
    assert.deepEqual(listed.map(({ challengeId }) => challengeId).sort(), [first.challengeId, fromTarget.challengeId].sort());
});

test(`accepting seats the target and starts the game`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);
    const { session } = entryOf(fixture, view.challengeId);

    await fixture.service.acceptChallenge(profile(TARGET_ID), view.challengeId);
    await settle();

    assert.equal(session.state, `in-game`);
    assert.equal(session.gameId, `game-1`);
    assert.deepEqual(session.players.map((player) => player.profileId).sort(), [CHALLENGER_ID, TARGET_ID]);
    assert.equal(fixture.service.listChallenges(profile(TARGET_ID)).length, 0, `the entry was consumed by the start`);
    assert.equal(fixture.entries.has(view.challengeId), false);
    assert.equal(fixture.sessionManager.countActivePlayerSessionsByProfileId(CHALLENGER_ID), 1, `an accepted challenge counts`);
});

test(`accepting is only for the target, with a stream, while pending`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);

    await assert.rejects(
        () => fixture.service.acceptChallenge(profile(CHALLENGER_ID), view.challengeId),
        /Only the challenged bot/,
    );

    const offline = createFixture();
    const offlineView = await challenge(offline);
    offline.online.delete(TARGET_ID);
    await assert.rejects(
        () => offline.service.acceptChallenge(profile(TARGET_ID), offlineView.challengeId),
        (error: unknown) => {
            assert.ok(error instanceof BotChallengeError);
            assert.equal(error.code, `not-open`);
            return true;
        },
    );

    await fixture.service.declineChallenge(profile(TARGET_ID), view.challengeId);
    await assert.rejects(
        () => fixture.service.acceptChallenge(profile(TARGET_ID), view.challengeId),
        /does not exist/,
    );

    /* The start window: accepted but not yet consumed by gameStarted. */
    const started = await challenge(fixture);
    (fixture.entries.get(started.challengeId) as { status: string }).status = `accepted`;
    await assert.rejects(
        () => fixture.service.acceptChallenge(profile(TARGET_ID), started.challengeId),
        /already been answered/,
    );

    await assert.rejects(
        () => fixture.service.acceptChallenge(profile(TARGET_ID), `c_unknown`),
        (error: unknown) => {
            assert.ok(error instanceof ApiRequestError);
            assert.equal(error.statusCode, 404);
            return true;
        },
    );
});

test(`a target that reached its cap after the offer is refused at accept time`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);

    for (let index = 0; index < 4; index += 1) {
        const lobby = {
            id: `cap-${index}`,
            lock: { runExclusive: async (fn: () => unknown) => fn() },
            state: `in-game`,
            hadPlayers: true,
            players: [{
                id: `seat-${index}`,
                deviceId: `bot:${TARGET_ID}`,
                profileId: TARGET_ID,
                displayName: TARGET_ID,
                rating: { eloScore: 1_000, gameCount: 0 },
                ratingAdjustment: null,
                ratingAdjusted: null,
                isBot: true,
                connection: { status: `connected`, socketId: `bot:${TARGET_ID}` },
            }],
            spectators: [],
        } as unknown as ServerGameSession;
        fixture.sessions.set(lobby.id, lobby);
    }

    await assert.rejects(
        () => fixture.service.acceptChallenge(profile(TARGET_ID), view.challengeId),
        (error: unknown) => {
            assert.ok(error instanceof BotChallengeError);
            assert.equal(error.code, `not-open`);
            return true;
        },
    );
    assert.equal(fixture.sessions.has(entryOf(fixture, view.challengeId).session.id), true, `the offer stands`);
});

test(`accepting after the challenger vanished cancels instead of seating a dead game`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);
    fixture.events.clear();

    /* The window the guard exists for: the challenger's seat is gone, the lobby not
     * yet swept. In production the drop and the sweep straddle an accept exactly like
     * this. */
    const { session } = entryOf(fixture, view.challengeId);
    session.players = [];

    await assert.rejects(
        () => fixture.service.acceptChallenge(profile(TARGET_ID), view.challengeId),
        /no longer connected/,
    );

    assert.equal(fixture.sessions.size, 0, `no lobby is left behind`);
    assert.deepEqual(fixture.events.get(TARGET_ID), [{
        type: `challengeCanceled`,
        challenge: { ...view, status: `canceled` },
        reason: `canceled`,
    }]);
});

test(`declining tells the challenger and leaves no session`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);
    fixture.events.clear();

    await fixture.service.declineChallenge(profile(TARGET_ID), view.challengeId);

    assert.deepEqual(fixture.events.get(CHALLENGER_ID), [{
        type: `challengeDeclined`,
        challenge: { ...view, status: `declined` },
    }]);
    assert.equal(fixture.events.get(TARGET_ID), undefined);
    assert.equal(fixture.sessions.size, 0);
    assert.equal(fixture.entries.size, 0);
});

test(`cancelling retracts the target's line`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);
    fixture.events.clear();

    await fixture.service.cancelChallenge(profile(CHALLENGER_ID), view.challengeId);

    assert.deepEqual(fixture.events.get(TARGET_ID), [{
        type: `challengeCanceled`,
        challenge: { ...view, status: `canceled` },
        reason: `canceled`,
    }]);
    assert.equal(fixture.events.get(CHALLENGER_ID), undefined, `the canceller needs no line`);
    assert.equal(fixture.sessions.size, 0);

    const other = await challenge(fixture);
    await assert.rejects(
        () => fixture.service.cancelChallenge(profile(TARGET_ID), other.challengeId),
        /Only the challenging bot/,
    );
});

test(`a dropped challenger stream cancels the challenge through the lobby sweep`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);
    fixture.events.clear();

    fixture.sessionManager.handleSocketDisconnect(`bot:${CHALLENGER_ID}`);
    await fixture.sessionManager.tickAllSessions();

    assert.equal(fixture.sessions.size, 0);
    assert.deepEqual(fixture.events.get(TARGET_ID), [{
        type: `challengeCanceled`,
        challenge: { ...view, status: `canceled` },
        reason: `canceled`,
    }]);
});

test(`expiry tells both sides and leaves no reserved lobby behind`, async () => {
    const fixture = createFixture({ ttlMs: 300_000 });
    const view = await challenge(fixture);
    fixture.events.clear();

    const entry = entryOf(fixture, view.challengeId);
    entry.expiresAt = Date.now() - 1;
    await fixture.sweep();

    assert.equal(fixture.sessions.size, 0, `the reserved lobby went with the challenge`);
    assert.deepEqual(fixture.events.get(TARGET_ID), [{
        type: `challengeCanceled`,
        challenge: { ...view, status: `expired` },
        reason: `expired`,
    }]);
    assert.deepEqual(fixture.events.get(CHALLENGER_ID), [{
        type: `challengeCanceled`,
        challenge: { ...view, status: `expired` },
        reason: `expired`,
    }]);
    assert.equal(fixture.service.listChallenges(profile(TARGET_ID)).length, 0);
});

test(`a challenge answered before its expiry is not expired after the fact`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);
    const entry = entryOf(fixture, view.challengeId);
    entry.expiresAt = Date.now() - 1;

    await fixture.service.acceptChallenge(profile(TARGET_ID), view.challengeId);
    await settle();
    fixture.events.clear();

    /* The sweep re-checks under the transition mutex: an answered challenge is
     * never expired underneath the game that just started. */
    await fixture.sweep();

    assert.deepEqual(fixture.events.get(TARGET_ID), undefined);
    assert.deepEqual(fixture.events.get(CHALLENGER_ID), undefined);
    assert.equal(fixture.entries.has(view.challengeId), false, `consumed by gameStarted`);
    assert.equal(entry.session.state, `in-game`);
});

test(`an accepted challenge whose game never started reaches the challenger`, async () => {
    const fixture = createFixture();
    const view = await challenge(fixture);
    fixture.events.clear();

    /* The start window: the entry is accepted, the lobby vanishes underneath it. */
    const entry = fixture.entries.get(view.challengeId) as { status: string };
    entry.status = `accepted`;
    await fixture.sessionManager.deleteLobby(entryOf(fixture, view.challengeId).session, `empty`);

    assert.deepEqual(fixture.events.get(CHALLENGER_ID), [{
        type: `challengeCanceled`,
        challenge: { ...view, status: `canceled` },
        reason: `canceled`,
    }]);
    assert.equal(fixture.events.get(TARGET_ID), undefined, `the target already acted`);
});

test(`the inbox cap expires the oldest pending challenge first`, async () => {
    const fixture = createFixture({ inboxLimit: 2 });

    const oldest = await challenge(fixture);
    await challenge(fixture, { challenger: `bot-y`, target: TARGET_ID });
    fixture.events.clear();

    await challenge(fixture, { challenger: `bot-x`, target: TARGET_ID });

    const pending = fixture.service.listChallenges(profile(TARGET_ID));
    assert.equal(pending.length, 2);
    assert.equal(pending.some(({ challengeId }) => challengeId === oldest.challengeId), false);

    /* The target's stream saw the new offer and the oldest's expiry. */
    const targetLines = (fixture.events.get(TARGET_ID) ?? []) as { type: string, reason?: string, challenge: BotChallenge }[];
    assert.deepEqual(targetLines.map(({ type }) => type), [`challenge`, `challengeCanceled`]);
    assert.equal(targetLines[1].challenge.challengeId, oldest.challengeId);
    assert.equal(targetLines[1].reason, `expired`);

    assert.deepEqual(fixture.events.get(CHALLENGER_ID), [{
        type: `challengeCanceled`,
        challenge: { ...oldest, status: `expired` },
        reason: `expired`,
    }]);
});

test(`the owner creates on a owned bot's behalf and can cancel the same place`, async () => {
    const fixture = createFixture();
    const owner = profile(OWNER_PROFILE_ID, `human`);

    const created = await fixture.service.createChallengeAsOwner(owner, TARGET_ID, { ip: `127.0.0.1` } as never, {
        challengerBotProfileId: CHALLENGER_ID,
        timeControl: { ...UNLIMITED },
        firstPlayer: `random`,
    });

    assert.equal(typeof created.sessionId, `string`);
    assert.equal(fixture.sessions.has(created.sessionId), true);

    const listed = await fixture.service.listChallengesAsOwner(owner, TARGET_ID);
    assert.deepEqual(listed.map(({ challengeId }) => challengeId), [created.challengeId]);
    assert.deepEqual(listed[0].sessionId, created.sessionId);

    await fixture.service.cancelChallengeAsOwner(owner, TARGET_ID, created.challengeId);
    assert.equal(fixture.sessions.size, 0);
    assert.equal((await fixture.service.listChallengesAsOwner(owner, TARGET_ID)).length, 0);
});

test(`the owner path only reaches bots the caller owns`, async () => {
    const fixture = createFixture();
    const owner = profile(OWNER_PROFILE_ID, `human`);

    await assert.rejects(
        () => fixture.service.createChallengeAsOwner(owner, TARGET_ID, { ip: `127.0.0.1` } as never, {
            challengerBotProfileId: TARGET_ID,
            timeControl: { ...UNLIMITED },
            firstPlayer: `random`,
        }),
        (error: unknown) => {
            assert.ok(error instanceof ApiRequestError);
            assert.equal(error.statusCode, 404);
            return true;
        },
    );

    const foreign = await challenge(fixture, { challenger: `bot-z`, target: `bot-y` });
    await assert.rejects(
        () => fixture.service.cancelChallengeAsOwner(owner, `bot-y`, foreign.challengeId),
        (error: unknown) => {
            assert.ok(error instanceof ApiRequestError);
            assert.equal(error.statusCode, 404);
            return true;
        },
    );
});
