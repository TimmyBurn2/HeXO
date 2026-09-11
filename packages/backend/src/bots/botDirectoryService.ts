import { type BotListing, type CreateSessionResponse, type LobbyOptions } from '@ih3t/shared';
import { Mutex } from 'async-mutex';
import type { Logger } from 'pino';
import { inject, injectable } from 'tsyringe';

import { type AccountUserProfile, AuthRepository } from '../auth/authRepository';
import { EloHandler } from '../elo/eloHandler';
import { ROOT_LOGGER } from '../logger';
import type { RequestClientInfo } from '../network/clientInfo';
import { ApiRequestError } from '../network/rest/apiQueryService';
import { SessionManager } from '../session/sessionManager';
import { BotAccountRepository } from './botAccountRepository';
import { MAX_CONCURRENT_GAMES_PER_BOT } from './botAccountService';
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
        @inject(EloHandler) private readonly eloHandler: EloHandler,
        @inject(SessionManager) private readonly sessionManager: SessionManager,
        @inject(BotStreamRegistry) private readonly botStreamRegistry: BotStreamRegistry,
    ) {
        this.logger = rootLogger.child({ component: `bot-directory-service` });
    }

    /** The public roster, spec tag Directory; `?online=1` narrows it to connected bots. */
    async listBots(onlineOnly: boolean): Promise<BotListing[]> {
        const accounts = await this.botAccountRepository.listAll();
        const listings = await Promise.all(accounts.map(async (account) => {
            const rating = await this.eloHandler.getPlayerRating(account.id);
            return {
                profileId: account.id,
                displayName: account.username,
                elo: Math.round(rating.eloScore),
                owner: account.ownerProfileId,
                online: this.botStreamRegistry.isOnline(account.id),
                openForChallenges: this.botStreamRegistry.isOpenForChallenges(account.id),
            } satisfies BotListing;
        }));

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

        if (!this.botStreamRegistry.isOnline(account.id)) {
            throw new ApiRequestError(400, `That bot is not connected right now.`);
        }

        if (this.sessionManager.countActivePlayerSessionsByProfileId(account.id) >= MAX_CONCURRENT_GAMES_PER_BOT) {
            throw new ApiRequestError(400, `That bot is already playing ${MAX_CONCURRENT_GAMES_PER_BOT} games at once.`);
        }

        const botProfile = await this.authRepository.getUserProfileById(account.id);
        if (!botProfile || botProfile.kind !== `bot`) {
            throw new ApiRequestError(404, `That bot does not exist.`);
        }

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

        const socketId = this.botStreamRegistry.getSocketId(account.id);
        const session = this.sessionManager.requireSession(response.sessionId);
        const participation = await this.sessionManager.joinSession(session, {
            deviceId: socketId,
            profile: botProfile,
            displayName: botProfile.username,
            allowSelfJoinCasualGames: true,
        });
        if (participation.role !== `player`) {
            /* Unreachable in a fresh reserved lobby, but never strand a spectator row. */
            await this.sessionManager.leaveSession(session, participation.participant.id, `leave-session`);
            throw new ApiRequestError(400, `That bot could not claim its seat.`);
        }

        this.sessionManager.assignParticipantSocket(session, participation.participant.id, socketId);

        if (!this.botStreamRegistry.isOnline(account.id)) {
            /* The stream dropped between the check and the claim: give the seat back,
             * or the lobby would wait on a socket nobody will ever write to. */
            await this.sessionManager.leaveSession(session, participation.participant.id, `leave-session`);
            throw new ApiRequestError(400, `That bot is not connected right now.`);
        }

        this.logger.info({ event: `bot.session.created`, botProfileId: account.id, sessionId: session.id }, `Bot session created`);
        return response;
    }
}
