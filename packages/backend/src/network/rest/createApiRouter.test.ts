import 'reflect-metadata';

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AccountUserProfile } from '../../auth/authRepository';
import { MAX_BOTS_PER_OWNER } from '../../bots/botAccountService';
import { BotMoveError } from '../../bots/botPlayService';
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

function createRouter(overrides: {
    user?: AccountUserProfile | null;
    botApiEnabled?: boolean;
    botAccountService?: Partial<Record<string, unknown>>;
    botToken?: AccountUserProfile | null;
    botPlayService?: Partial<Record<string, unknown>>;
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
            getAccount: () => Promise.resolve({ bot: botPlayer, owner: botPlayer, activeGames: [] }),
            joinSession: () => Promise.resolve(),
            playMove: () => Promise.resolve(),
            resignGame: () => Promise.resolve(),
            ...overrides.botPlayService,
        } as never,
        { attach: () => { }, open: () => { }, getSocketId: (id: string) => `bot:${id}` } as never,
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
