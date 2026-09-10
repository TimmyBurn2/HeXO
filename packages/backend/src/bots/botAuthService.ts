import { inject, injectable } from 'tsyringe';

import { type AccountUserProfile, AuthRepository } from '../auth/authRepository';
import { BotAccountRepository } from './botAccountRepository';
import { hashBotToken } from './botAccountService';

const BEARER_PREFIX = `Bearer `;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export type BearerRequest = {
    headers: { authorization?: string | undefined };
};

/**
 * Resolves the actor behind `Authorization: Bearer hxo_…`. Sits beside `AuthService`
 * rather than inside it: nothing under `auth/` changes, the session cookie stays the
 * only thing that service knows about, and a bot token never reaches a browser path.
 */
@injectable()
export class BotAuthService {
    private readonly lastUsedWrites = new Map<string, number>();

    constructor(
        @inject(BotAccountRepository) private readonly botAccountRepository: BotAccountRepository,
        @inject(AuthRepository) private readonly authRepository: AuthRepository,
    ) { }

    async getBotFromRequest(request: BearerRequest): Promise<AccountUserProfile | null> {
        const token = readBearerToken(request.headers.authorization);
        if (!token) {
            return null;
        }

        const tokenHash = hashBotToken(token);
        const botProfileId = await this.botAccountRepository.findBotIdByTokenHash(tokenHash);
        if (!botProfileId) {
            /* Rotated tokens are replaced in place and deleted bots keep no token. */
            return null;
        }

        const profile = await this.authRepository.getUserProfileById(botProfileId);
        if (profile?.kind !== `bot`) {
            return null;
        }

        this.touchLastUsed(tokenHash);
        return profile;
    }

    private touchLastUsed(tokenHash: string): void {
        const now = Date.now();
        const writtenAt = this.lastUsedWrites.get(tokenHash) ?? 0;
        if (now - writtenAt < LAST_USED_WRITE_INTERVAL_MS) {
            return;
        }

        this.lastUsedWrites.set(tokenHash, now);
        void this.botAccountRepository.touchTokenLastUsed(tokenHash, now)
            .catch(() => {
                /* Presence is the stream, not this timestamp; a failed write is not fatal. */
                this.lastUsedWrites.delete(tokenHash);
            });
    }
}

export function readBearerToken(authorization: string | undefined): string | null {
    if (!authorization?.startsWith(BEARER_PREFIX)) {
        return null;
    }

    const token = authorization.slice(BEARER_PREFIX.length).trim();
    return token.length > 0 ? token : null;
}
