import type { BotStats } from '@ih3t/shared';
import type { Collection, Document } from 'mongodb';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import { ROOT_LOGGER } from '../logger';
import { MongoDatabase } from '../persistence/mongoClient';
import { BOT_STATS_COLLECTION_NAME } from '../persistence/mongoCollections';

type BotStatsDocument = BotStats & Document;

/**
 * The per-bot stats cache (D11): one document per bot, rewritten whenever a game of
 * its finishes. The profile reads here and only here; the aggregation behind it
 * lives in the game history repository and runs cold.
 */
@injectable()
export class BotStatsRepository {
    private readonly logger: Logger;
    private collectionPromise: Promise<Collection<BotStatsDocument>> | null = null;

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(MongoDatabase) private readonly mongoDatabase: MongoDatabase,
    ) {
        this.logger = rootLogger.child({ component: `bot-stats-repository` });
    }

    async read(botProfileId: string): Promise<BotStats | null> {
        const collection = await this.getCollection();
        return await collection.findOne({ botProfileId }, { projection: { _id: 0 } });
    }

    /** One document per bot, replaced wholesale: the cache is always the whole truth. */
    async replace(botProfileId: string, stats: BotStats): Promise<void> {
        const collection = await this.getCollection();
        await collection.updateOne({ botProfileId }, { $set: stats }, { upsert: true });
    }

    private async getCollection(): Promise<Collection<BotStatsDocument>> {
        if (this.collectionPromise) {
            return this.collectionPromise;
        }

        this.collectionPromise = (async () => {
            const database = await this.mongoDatabase.getDatabase();
            const collection = database.collection<BotStatsDocument>(BOT_STATS_COLLECTION_NAME);
            /* One document per bot: two finishes racing must never wedge a pair. */
            await collection.createIndex({ botProfileId: 1 }, { unique: true });
            return collection;
        })().catch((error: unknown) => {
            this.collectionPromise = null;
            this.logger.error({ err: error, event: `bots.stats.init.failed` }, `Failed to initialize bot stats collection`);
            throw error;
        });

        return this.collectionPromise;
    }
}
