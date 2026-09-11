import { type BotListing, type CreateSessionResponse, type LobbyOptions } from '@ih3t/shared';
import { Mutex } from 'async-mutex';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import { type AccountUserProfile, AuthRepository } from '../auth/authRepository';
import { ROOT_LOGGER } from '../logger';
import type { RequestClientInfo } from '../network/clientInfo';
import { ApiRequestError } from '../network/rest/apiQueryService';
import { SessionManager } from '../session/sessionManager';
import { BotAccountRepository } from './botAccountRepository';
import { MAX_CONCURRENT_GAMES_PER_BOT } from './botAccountService';
import { BotPlayerMapper } from './botPlayerMapper';
import { seatBotInLobby, underBotSeatGate } from './botSeatGate';
import { BotStreamRegistry } from './botStreamRegistry';

@injectable()
export class BotDirectoryService {
    private readonly logger: Logger;

    /* Two Plays racing each other must not both pass the cap check; the mutex makes
     * the check-and-create sequence atomic for this route. */
    private readonly createMutex = new Mutex();

    constructor(
        @inject(ROOT_LOGGER) rootLogger: Logger,
        @inject(BotAccountRepository) private readonly botAccountRepository: BotAccountRepository,
        @inject(AuthRepository) private readonly authRepository: AuthRepository,
        @inject(BotPlayerMapper) private readonly botPlayerMapper: BotPlayerMapper,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotStreamRegistry) private readonly botStreamRegistry: BotStreamRegistry,
    ) {
        this.logger = rootLogger.child({ component: `bot-directory-service` });
    }

    /** The public roster, spec tag Directory; `?online=1` narrows it to connected bots. */
    async listBots(onlineOnly: boolean): Promise<BotListing[]> {
        const accounts = await this.botAccountRepository.listAll();
        const listings = await Promise.all(accounts.map(async (account) => ({
            ...await this.botPlayerMapper.fromAccount(account),
            owner: account.ownerProfileId,
            online: this.botStreamRegistry.isOnline(account.id),
            /* Inert until challenges exist; parsed off the stream, never guessed. */
            openForChallenges: false,
        } satisfies BotListing)));

        const visible = onlineOnly ? listings.filter((listing) => listing.online) : listings;
        return visible.sort((left, right) => right.elo - left.elo || left.displayName.localeCompare(right.displayName));
    }

    /**
     * The website's Play button: a private lobby with both seats reserved and the
     * bot's seat already claimed. The human joins as host over the socket and the
     * lobby starts itself once both seats are connected — a dropped bot stream
     * un-claims the seat through the same sweep, nothing here has to react.
     */
    async createBotSession(
        human: AccountUserProfile,
        botProfileId: string,
        client: RequestClientInfo,
        options: Pick<LobbyOptions, `timeControl`>,
    ): Promise<CreateSessionResponse> {
        return await this.createMutex.runExclusive(() => this.createBotSessionLocked(human, botProfileId, client, options));
    }

    private async createBotSessionLocked(
        human: AccountUserProfile,
        botProfileId: string,
        client: RequestClientInfo,
        options: Pick<LobbyOptions, `timeControl`>,
    ): Promise<CreateSessionResponse> {
        const account = await this.botAccountRepository.findById(botProfileId);
        if (!account) {
            throw new ApiRequestError(404, `That bot does not exist.`);
        }

        const botProfile = await this.authRepository.getUserProfileById(account.id);
        if (!botProfile || botProfile.kind !== `bot`) {
            throw new ApiRequestError(404, `That bot does not exist.`);
        }

        /* The lobby and the seat are one claim: a cap or connection failure past this
         * point leaves an empty private lobby the sweep retires within seconds. */
        return await underBotSeatGate(async () => {
            const response = this.sessionManager.createSession({
                client,
                lobbyOptions: {
                    visibility: `private`,
                    timeControl: options.timeControl,
                    /* Every game with a bot seat is unrated; SessionManager re-asserts
                     * it when the seat is claimed, whatever created the lobby. */
                    rated: false,
                    firstPlayer: `random`,
                },
                reservedPlayerProfileIds: [human.id, account.id],
            });

            const session = this.sessionManager.requireSession(response.sessionId);
            await seatBotInLobby(
                { sessionManager: this.sessionManager, presence: this.botStreamRegistry },
                session,
                botProfile,
                (profileId) => this.sessionManager.countActivePlayerSessionsByProfileId(profileId),
                {
                    offline: () => new ApiRequestError(400, `That bot is not connected right now.`),
                    capReached: () => new ApiRequestError(400, `A bot can play at most ${MAX_CONCURRENT_GAMES_PER_BOT} games at once.`),
                    seatLost: () => new ApiRequestError(400, `That bot could not claim its seat.`),
                },
            );

            this.logger.info({ event: `bot.session.created`, botProfileId: account.id, sessionId: session.id }, `Bot session created`);
            return response;
        });
    }
}
