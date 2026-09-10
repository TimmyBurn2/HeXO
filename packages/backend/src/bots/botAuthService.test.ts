import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AccountUserProfile } from '../auth/authRepository';
import type { AuthRepository } from '../auth/authRepository';
import type { BotAccountRepository } from './botAccountRepository';
import { hashBotToken } from './botAccountService';
import { BotAuthService, readBearerToken } from './botAuthService';

const BOT_TOKEN = `hxo_ReferenceToken`;
const BOT_PROFILE_ID = `bot-1`;

function botProfile(overrides: Partial<AccountUserProfile> = {}): AccountUserProfile {
    return {
        id: BOT_PROFILE_ID,
        username: `Strix`,
        email: null,
        image: null,
        role: `user`,
        kind: `bot`,
        permissions: [],
        registeredAt: 0,
        lastActiveAt: 0,
        ...overrides,
    };
}

class FakeBotAccountRepository {
    readonly touched: { tokenHash: string, lastUsedAt: number }[] = [];
    constructor(private readonly tokenHashes = new Map<string, string>()) { }

    findBotIdByTokenHash(tokenHash: string): Promise<string | null> {
        return Promise.resolve(this.tokenHashes.get(tokenHash) ?? null);
    }

    touchTokenLastUsed(tokenHash: string, lastUsedAt: number): Promise<void> {
        this.touched.push({ tokenHash, lastUsedAt });
        return Promise.resolve();
    }
}

class FakeAuthRepository {
    constructor(private readonly profiles = new Map<string, AccountUserProfile>()) { }

    getUserProfileById(userId: string): Promise<AccountUserProfile | null> {
        return Promise.resolve(this.profiles.get(userId) ?? null);
    }
}

function createService(options: {
    tokenHashes?: Map<string, string>,
    profiles?: Map<string, AccountUserProfile>,
} = {}) {
    const botAccountRepository = new FakeBotAccountRepository(
        options.tokenHashes ?? new Map([[hashBotToken(BOT_TOKEN), BOT_PROFILE_ID]]),
    );
    const authRepository = new FakeAuthRepository(
        options.profiles ?? new Map([[BOT_PROFILE_ID, botProfile()]]),
    );
    const service = new BotAuthService(
        botAccountRepository as unknown as BotAccountRepository,
        authRepository as unknown as AuthRepository,
    );

    return { service, botAccountRepository };
}

function bearer(token: string) {
    return { headers: { authorization: `Bearer ${token}` } };
}

test(`a bearer header is read only when it carries a token`, () => {
    assert.equal(readBearerToken(`Bearer hxo_abc`), `hxo_abc`);
    assert.equal(readBearerToken(`Bearer  hxo_abc `), `hxo_abc`);
    assert.equal(readBearerToken(`bearer hxo_abc`), null);
    assert.equal(readBearerToken(`Bearer `), null);
    assert.equal(readBearerToken(`hxo_abc`), null);
    assert.equal(readBearerToken(undefined), null);
});

test(`a valid token resolves the bot and stamps lastUsedAt`, async () => {
    const { service, botAccountRepository } = createService();

    const profile = await service.getBotFromRequest(bearer(BOT_TOKEN));

    assert.equal(profile?.id, BOT_PROFILE_ID);
    assert.equal(botAccountRepository.touched.length, 1);
    assert.equal(botAccountRepository.touched[0]?.tokenHash, hashBotToken(BOT_TOKEN));
});

test(`lastUsedAt is not rewritten on every request`, async () => {
    const { service, botAccountRepository } = createService();

    await service.getBotFromRequest(bearer(BOT_TOKEN));
    await service.getBotFromRequest(bearer(BOT_TOKEN));
    await service.getBotFromRequest(bearer(BOT_TOKEN));

    assert.equal(botAccountRepository.touched.length, 1);
});

test(`a rotated-away token no longer resolves`, async () => {
    const { service } = createService({ tokenHashes: new Map([[hashBotToken(`hxo_Rotated`), BOT_PROFILE_ID]]) });

    assert.equal(await service.getBotFromRequest(bearer(BOT_TOKEN)), null);
});

test(`a deleted bot keeps no token, so nothing resolves`, async () => {
    const { service } = createService({ tokenHashes: new Map() });

    assert.equal(await service.getBotFromRequest(bearer(BOT_TOKEN)), null);
});

test(`a token pointing at a human account is refused`, async () => {
    const { service } = createService({
        profiles: new Map([[BOT_PROFILE_ID, botProfile({ kind: `human` })]]),
    });

    assert.equal(await service.getBotFromRequest(bearer(BOT_TOKEN)), null);
});

test(`a token pointing at a missing profile is refused`, async () => {
    const { service } = createService({ profiles: new Map() });

    assert.equal(await service.getBotFromRequest(bearer(BOT_TOKEN)), null);
});

test(`a request without a bearer header resolves nothing`, async () => {
    const { service, botAccountRepository } = createService();

    assert.equal(await service.getBotFromRequest({ headers: {} }), null);
    assert.equal(botAccountRepository.touched.length, 0);
});
