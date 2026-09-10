import { type BotPlayer } from '@ih3t/shared';
import { inject, injectable } from 'tsyringe';

import { type AccountUserProfile } from '../auth/authRepository';
import { EloHandler } from '../elo/eloHandler';
import type { ServerSessionPlayer } from '../session/types';

/** One builder for the wire's `BotPlayer`, whatever its source. */
@injectable()
export class BotPlayerMapper {
    constructor(@inject(EloHandler) private readonly eloHandler: EloHandler) { }

    async fromProfile(profile: Pick<AccountUserProfile, `id` | `username`> | null): Promise<BotPlayer> {
        if (!profile) {
            return { profileId: null, displayName: ``, elo: null };
        }

        const rating = await this.eloHandler.getPlayerRating(profile.id);
        return { profileId: profile.id, displayName: profile.username, elo: Math.round(rating.eloScore) };
    }

    fromSeat(player: ServerSessionPlayer | undefined): BotPlayer {
        return {
            profileId: player?.profileId ?? null,
            displayName: player?.displayName ?? ``,
            /* A guest carries a placeholder rating internally; it is not one, so it is null. */
            elo: player?.profileId ? Math.round(player.rating.eloScore) : null,
        };
    }
}
