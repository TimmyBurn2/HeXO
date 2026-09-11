import 'reflect-metadata';

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AccountUserProfile } from '../../auth/authRepository';
import { MAX_BOTS_PER_OWNER } from '../../bots/botAccountService';
import { BotMoveError } from '../../bots/botPlayService';
import { BotChallengeError } from '../../bots/challengeService';
import { SessionError } from '../../session/sessionManager';
import { ApiRequestError } from './apiQueryService';
import { ApiRouter } from './createApiRouter';

const owner = { id: `owner-1`, kind: `human` } as AccountUserProfile;
const botAccount = { id: `bot-1`, username: `Botty`, kind: `bot` } as AccountUserProfile;
const botPlayer = { profileId: `bot-1`, displayName: `Botty`, elo: 1_000 };
const bot = {
    id: `bot-1`,
    username: `Botty`,
    image: null,
    ownerProfileId: owner.id,
    createdAt: 1,
    tokenRotatedAt: 1,
};
const challengeView = {
    challengeId: `c_1`,
    challenger: botPlayer,
    destUser: botPlayer,
    timeControl: { mode: `unlimited` },
    status: `created`,
};

function createRouter(overrides: {
    user?: AccountUserProfile | null;
    botApiEnabled?: boolean;
    botAccountService?: Partial<Record<string, unknown>>;
    botToken?: AccountUserProfile | null;
    botPlayService?: Partial<Record<string, unknown>>;
    botDirectoryService?: Partial<Record<string, unknown>>;
    challengeService?: Partial<Record<string, unknown>>;
}) {
    const botAccountService = {
        listBots: () => Promise.resolve([bot]),
        createBot: () => Promise.resolve({ bot, token: `hxo_secret` }),
        rotateToken: () => Promise.resolve({ bot, token: `hxo_rotated` }),
        deleteBot: () => Promise.resolve(),
        ...overrides.botAccountService,
    };

    return new ApiRouter(
        {} as never,
        { getUserFromRequest: () => Promise.resolve(overrides.user ?? null) } as never,
        {} as never,
        { isEnabled: () => false } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { botApiEnabled: overrides.botApiEnabled ?? true } as never,
        botAccountService as never,
        { getBotFromRequest: () => Promise.resolve(overrides.botToken ?? null) } as never,
        {
            listBots: () => Promise.resolve([]),
            createBotSession: () => Promise.resolve({ sessionId: `fresh-session` }),
            ...overrides.botDirectoryService,
        } as never,
        {
            getAccount: () => Promise.resolve({ bot: botPlayer, owner: botPlayer, activeGames: [] }),
            joinSession: () => Promise.resolve(),
            playMove: () => Promise.resolve(),
            resignGame: () => Promise.resolve(),
            ...overrides.botPlayService,
        } as never,
        { attach: () => { }, open: () => { }, getSocketId: (id: string) => `bot:${id}` } as never,
        {
            attach: () => { },
            replayPending: () => { },
            createChallenge: () => Promise.resolve(challengeView),
            acceptChallenge: () => Promise.resolve(),
            declineChallenge: () => Promise.resolve(),
            cancelChallenge: () => Promise.resolve(),
            listChallenges: () => [],
            createChallengeAsOwner: () => Promise.resolve({ ...challengeView, sessionId: `fresh-session` }),
            listChallengesAsOwner: () => Promise.resolve([]),
            cancelChallengeAsOwner: () => Promise.resolve(),
            ...overrides.challengeService,
        } as never,
    );
}

async function withServer(
    router: ApiRouter,
    run: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const app = express();
    app.use(`/api`, router.router);
    const server = app.listen(0);
    await new Promise((resolve) => server.once(`listening`, resolve));

    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test(`bot routes reject a signed out request`, async () => {
    await withServer(createRouter({ user: null }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: `Sign in with Discord to manage bots.` });
    });
});

test(`listing bots reports the per owner limit`, async () => {
    await withServer(createRouter({ user: owner }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { bots: [bot], limit: MAX_BOTS_PER_OWNER });
    });
});

test(`creating a bot answers 201 with the issued token`, async () => {
    await withServer(createRouter({ user: owner }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ username: `Botty` }),
        });

        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { bot, token: `hxo_secret` });
    });
});

test(`rotating a token passes the bot id through`, async () => {
    const seen: string[] = [];
    const router = createRouter({
        user: owner,
        botAccountService: {
            rotateToken: (_owner: AccountUserProfile, botProfileId: string) => {
                seen.push(botProfileId);
                return Promise.resolve({ bot, token: `hxo_rotated` });
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots/bot-1/token`, { method: `POST` });
        assert.equal(response.status, 200);
        assert.deepEqual(seen, [`bot-1`]);
    });
});

test(`deleting a bot answers with the refreshed list`, async () => {
    const router = createRouter({
        user: owner,
        botAccountService: { listBots: () => Promise.resolve([]) },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots/bot-1`, { method: `DELETE` });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { bots: [], limit: MAX_BOTS_PER_OWNER });
    });
});

test(`a service rejection is mapped to its status code`, async () => {
    const router = createRouter({
        user: owner,
        botAccountService: {
            createBot: () => Promise.reject(new ApiRequestError(409, `You can own at most 3 bots.`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ username: `Botty` }),
        });

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: `You can own at most 3 bots.` });
    });
});

test(`the routes are absent while the flag is off`, async () => {
    await withServer(createRouter({ user: owner, botApiEnabled: false }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/account/bots`);
        assert.equal(response.status, 404);
    });
});

test(`the play routes reject a request without a bot token`, async () => {
    const router = createRouter({ botToken: null });

    await withServer(router, async (baseUrl) => {
        for (const [method, path] of [
            [`GET`, `/bot/account`],
            [`GET`, `/bot/stream`],
            [`POST`, `/bot/game/game-1/move`],
            [`POST`, `/bot/game/game-1/resign`],
            [`POST`, `/bot/session/abc123/join`],
            [`GET`, `/bot/challenges`],
            [`POST`, `/bot/challenge/bot-2`],
            [`POST`, `/bot/challenge/c_1/accept`],
            [`POST`, `/bot/challenge/c_1/decline`],
            [`POST`, `/bot/challenge/c_1/cancel`],
        ] as const) {
            const response = await fetch(`${baseUrl}${path}`, { method });
            assert.equal(response.status, 401, path);
        }
    });
});

test(`the play routes do not exist while the flag is off`, async () => {
    const router = createRouter({ botApiEnabled: false, botToken: botAccount });

    await withServer(router, async (baseUrl) => {
        for (const [method, path] of [
            [`GET`, `/bot/account`],
            [`GET`, `/bot/stream`],
            [`POST`, `/bot/game/game-1/move`],
            [`POST`, `/bot/game/game-1/resign`],
            [`POST`, `/bot/session/abc123/join`],
            [`GET`, `/bot/challenges`],
            [`POST`, `/bot/challenge/bot-2`],
            [`POST`, `/bot/challenge/c_1/accept`],
            [`POST`, `/bot/challenge/c_1/decline`],
            [`POST`, `/bot/challenge/c_1/cancel`],
            [`GET`, `/bots`],
            [`POST`, `/bots/bot-1/session`],
            [`GET`, `/bots/bot-2/challenges`],
            [`POST`, `/bots/bot-2/challenge`],
            [`POST`, `/bots/bot-2/challenge/c_1/cancel`],
        ] as const) {
            const response = await fetch(`${baseUrl}${path}`, { method });
            assert.equal(response.status, 404, path);
        }
    });
});

test(`a bot reads its own account`, async () => {
    const router = createRouter({ botToken: botAccount });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/account`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { bot: botPlayer, owner: botPlayer, activeGames: [] });
    });
});

test(`a rejected move answers with the contract's error code`, async () => {
    const router = createRouter({
        botToken: botAccount,
        botPlayService: {
            playMove: () => Promise.reject(new BotMoveError(`It is not your turn.`, `not-your-turn`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/game/game-1/move`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ move: { pieces: [{ q: 1, r: 0 }, { q: 2, r: 0 }] } }),
        });

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: `It is not your turn.`, code: `not-your-turn` });
    });
});

test(`joining a lobby answers ok`, async () => {
    const router = createRouter({ botToken: botAccount });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/session/abc123/join`, { method: `POST` });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
    });
});

test(`resigning a game answers ok`, async () => {
    const seen: string[] = [];
    const router = createRouter({
        botToken: botAccount,
        botPlayService: {
            resignGame: (_bot: AccountUserProfile, gameId: string) => {
                seen.push(gameId);
                return Promise.resolve();
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/game/game-1/resign`, { method: `POST` });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.deepEqual(seen, [`game-1`]);
    });
});

test(`the bot roster is readable without signing in`, async () => {
    const listing = { profileId: `bot-1`, displayName: `Strix`, elo: 1_337, owner: `owner-1`, online: true, openForChallenges: false };
    const router = createRouter({ botDirectoryService: { listBots: () => Promise.resolve([listing]) } });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots?online=1`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), [listing]);
    });
});

test(`starting a bot session requires signing in`, async () => {
    const router = createRouter({ user: null });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, { method: `POST` });

        assert.equal(response.status, 401);
    });
});

test(`starting a bot session answers with the new session id`, async () => {
    const seenOptions: object[] = [];
    const router = createRouter({
        user: owner,
        botDirectoryService: {
            createBotSession: (_user: AccountUserProfile, profileId: string, _client: unknown, options: object) => {
                seenOptions.push({ profileId, options });
                return Promise.resolve({ sessionId: `fresh-session` });
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        /* A legacy body still asking for a rated game gets the field dropped on the
         * floor: a bot seat is never rated, and the server does not pretend to obey. */
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ rated: true }),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { sessionId: `fresh-session` });
        assert.deepEqual(seenOptions, [{
            profileId: `bot-1`,
            options: { timeControl: { mode: `turn`, turnTimeMs: 45_000 } },
        }]);
    });
});

test(`a malformed bot session request answers 400`, async () => {
    const router = createRouter({ user: owner });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ timeControl: { mode: `nonsense` } }),
        });

        assert.equal(response.status, 400);
    });
});

test(`a bot session the session manager refuses answers 409`, async () => {
    const router = createRouter({
        user: owner,
        botDirectoryService: {
            createBotSession: () => Promise.reject(new SessionError(`The server is currently at its concurrent game limit (2). Please wait for another game to finish before creating a new one.`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots/bot-1/session`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ rated: true }),
        });

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: `The server is currently at its concurrent game limit (2). Please wait for another game to finish before creating a new one.` });
    });
});

test(`a challenge is created from the wire body and answered with its view`, async () => {
    const seen: object[] = [];
    const router = createRouter({
        botToken: botAccount,
        challengeService: {
            createChallenge: (_bot: AccountUserProfile, targetProfileId: string, _client: unknown, options: object) => {
                seen.push({ targetProfileId, options });
                return Promise.resolve(challengeView);
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bot/challenge/bot-2`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ timeControl: { mode: `turn`, turnTimeMs: 45_000 }, firstPlayer: `challenged` }),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), challengeView);
        assert.deepEqual(seen, [{
            targetProfileId: `bot-2`,
            options: { timeControl: { mode: `turn`, turnTimeMs: 45_000 }, firstPlayer: `challenged` },
        }]);
    });
});

test(`a malformed challenge body answers 400, and a human target carries not-a-bot`, async () => {
    const router = createRouter({
        botToken: botAccount,
        challengeService: {
            createChallenge: () => Promise.reject(new BotChallengeError(`Challenges target bots; that account is a human.`, `not-a-bot`)),
        },
    });

    await withServer(router, async (baseUrl) => {
        const malformed = await fetch(`${baseUrl}/bot/challenge/bot-2`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ timeControl: { mode: `nonsense` } }),
        });
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), { error: `The challenge options are not valid.` });

        const rejected = await fetch(`${baseUrl}/bot/challenge/bot-2`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ timeControl: { mode: `unlimited` } }),
        });
        assert.equal(rejected.status, 400);
        assert.deepEqual(await rejected.json(), {
            error: `Challenges target bots; that account is a human.`,
            code: `not-a-bot`,
        });
    });
});

test(`answering and listing challenges passes the challenge id through`, async () => {
    const seen: string[] = [];
    const router = createRouter({
        botToken: botAccount,
        challengeService: {
            acceptChallenge: (_bot: AccountUserProfile, challengeId: string) => {
                seen.push(`accept:${challengeId}`);
                return Promise.resolve();
            },
            declineChallenge: (_bot: AccountUserProfile, challengeId: string) => {
                seen.push(`decline:${challengeId}`);
                return Promise.resolve();
            },
            cancelChallenge: (_bot: AccountUserProfile, challengeId: string) => {
                seen.push(`cancel:${challengeId}`);
                return Promise.resolve();
            },
            listChallenges: () => Promise.resolve([challengeView]),
        },
    });

    await withServer(router, async (baseUrl) => {
        for (const action of [`accept`, `decline`, `cancel`] as const) {
            const response = await fetch(`${baseUrl}/bot/challenge/c_9/${action}`, { method: `POST` });
            assert.equal(response.status, 200, action);
            assert.deepEqual(await response.json(), { ok: true }, action);
        }

        const list = await fetch(`${baseUrl}/bot/challenges`);
        assert.equal(list.status, 200);
        assert.deepEqual(await list.json(), [challengeView]);

        assert.deepEqual(seen, [`accept:c_9`, `decline:c_9`, `cancel:c_9`]);
    });
});

test(`an owner challenges on a owned bot's behalf and gets the session id`, async () => {
    const seen: object[] = [];
    const router = createRouter({
        user: owner,
        challengeService: {
            createChallengeAsOwner: (_user: AccountUserProfile, targetProfileId: string, _client: unknown, request: object) => {
                seen.push({ targetProfileId, request });
                return Promise.resolve({ ...challengeView, sessionId: `fresh-session` });
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/bots/bot-2/challenge`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ challengerBotProfileId: `bot-1`, timeControl: { mode: `unlimited` } }),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ...challengeView, sessionId: `fresh-session` });
        assert.deepEqual(seen, [{
            targetProfileId: `bot-2`,
            request: {
                challengerBotProfileId: `bot-1`,
                timeControl: { mode: `unlimited` },
                firstPlayer: `random`,
            },
        }]);
    });
});

test(`the owner challenge routes require signing in`, async () => {
    const router = createRouter({ user: null });

    await withServer(router, async (baseUrl) => {
        for (const [method, path] of [
            [`GET`, `/bots/bot-2/challenges`],
            [`POST`, `/bots/bot-2/challenge`],
            [`POST`, `/bots/bot-2/challenge/c_1/cancel`],
        ] as const) {
            const response = await fetch(`${baseUrl}${path}`, { method });
            assert.equal(response.status, 401, path);
        }
    });
});

test(`the owner lists and cancels pending challenges`, async () => {
    const seen: string[] = [];
    const router = createRouter({
        user: owner,
        challengeService: {
            listChallengesAsOwner: () => Promise.resolve([{ ...challengeView, sessionId: `fresh-session` }]),
            cancelChallengeAsOwner: (_user: AccountUserProfile, targetProfileId: string, challengeId: string) => {
                seen.push(`${targetProfileId}:${challengeId}`);
                return Promise.resolve();
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const list = await fetch(`${baseUrl}/bots/bot-2/challenges`);
        assert.equal(list.status, 200);
        assert.deepEqual(await list.json(), { challenges: [{ ...challengeView, sessionId: `fresh-session` }] });

        const cancel = await fetch(`${baseUrl}/bots/bot-2/challenge/c_9/cancel`, { method: `POST` });
        assert.equal(cancel.status, 200);
        assert.deepEqual(await cancel.json(), { ok: true });
        assert.deepEqual(seen, [`bot-2:c_9`]);
    });
});
