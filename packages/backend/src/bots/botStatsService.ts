import type { BotStats } from '@ih3t/shared';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import { ROOT_LOGGER } from '../logger';
import { ApiRequestError } from '../network/rest/apiQueryService';
import { GameHistoryRepository } from '../persistence/gameHistoryRepository';
import { SessionManager } from '../session/sessionManager';
import { BotAccountRepository } from './botAccountRepository';
import { BotStatsRepository } from './botStatsRepository';

/** How long after a finish the cache is rewritten: the winning turn's history append
 * is fire-and-forget by design, so it must be given a moment to land. */
const REBUILD_DELAY_MS = 500;

/**
 * Serves a bot's stats (D11): the `botStats` cache, rewritten shortly after every
 * finish that involved a bot seat, and rebuilt once on a cold read so a bot with
 * history from before this cache existed gets numbers on its first visitor.
 */
@injectable()
export class BotStatsService {
    private readonly logger: Logger;
    private unsubscribe: (() => void) | null = null;
    /** In-flight rebuilds by bot: a burst of finishes coalesces into one scan each,
     * and the trailing rebuild always sees the last of them. */
    private readonly rebuilding = new Map<string, Promise<BotStats>>();

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotAccountRepository) private readonly botAccountRepository: BotAccountRepository,
        @inject(GameHistoryRepository) private readonly gameHistoryRepository: GameHistoryRepository,
        @inject(BotStatsRepository) private readonly botStatsRepository: BotStatsRepository,
    ) {
        this.logger = rootLogger.child({ component: `bot-stats-service` });
    }

    /** Subscribes beside the other session watchers; only meaningful under the flag. */
    attach(): void {
        this.unsubscribe ??= this.sessionManager.addEventHandlers({
            gameFinished: ({ sessionId }) => this.scheduleRebuild(sessionId),
        });
    }

    detach(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    /** Recomputes and re-caches one bot's stats: the finish edge's worker, public so
     * a cold cache can be warmed on demand. Concurrent callers share one scan. */
    async rebuildFor(botProfileId: string): Promise<BotStats> {
        const inFlight = this.rebuilding.get(botProfileId);
        if (inFlight) {
            return await inFlight;
        }

        const rebuild = (async () => {
            const stats = await this.gameHistoryRepository.aggregateBotStats(botProfileId);
            await this.botStatsRepository.replace(botProfileId, stats);
            return stats;
        })().finally(() => {
            this.rebuilding.delete(botProfileId);
        });

        this.rebuilding.set(botProfileId, rebuild);
        return await rebuild;
    }

    async getFor(botProfileId: string): Promise<BotStats> {
        const cached = await this.botStatsRepository.read(botProfileId);
        if (cached) {
            return cached;
        }

        const account = await this.botAccountRepository.findById(botProfileId);
        if (!account) {
            throw new ApiRequestError(404, `That bot does not exist.`);
        }

        return await this.rebuildFor(botProfileId);
    }

    private scheduleRebuild(sessionId: string): void {
        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
            return;
        }

        for (const player of session.players) {
            if (!player.isBot || !player.profileId) {
                continue;
            }

            const botProfileId = player.profileId;
            const timer = setTimeout(() => {
                void this.rebuildFor(botProfileId).catch((error: unknown) => {
                    this.logger.warn({ err: error, event: `bots.stats.rebuild.failed`, botProfileId }, `Failed to rebuild bot stats`);
                });
            }, REBUILD_DELAY_MS);
            timer.unref?.();
        }
    }

}
