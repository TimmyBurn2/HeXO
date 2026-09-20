import { Button } from '@/components/ui/button';
import type { AccountProfile, BotAccount, BotListing, CreateSessionRequest, HouseBotListing, HouseBotsResponse, LobbyFirstPlayer, LobbyVisibility } from '@ih3t/shared';
import { formatThinkSeconds } from '@ih3t/shared';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';

import BotBadge from './BotBadge';
import HouseBotStrengthPicker from './houseBotStrengthPicker';
import { LobbyDialogShell, LobbyTimeControlSelector, SelectableOptions, useLobbyTimeControl } from './lobbyOptionsShared';
import { useTranslation } from 'react-i18next'

/** What the dialog opens on: an open lobby, the first house bot, or one named bot, house or community. */
export type LobbyOpponentChoice = `open` | `house-bot` | { kind: `house-bot` | `bot`, profileId: string };

type CreateLobbyDialogProps = {
    isOpen: boolean
    onClose: () => void
    account: AccountProfile | null
    /** The server's own opponents; null (the flag is off) leaves the dialog exactly as it was. */
    houseBots?: HouseBotsResponse | null
    /** The signed-in player's bots; null while the flag is off hides the entry. */
    ownBots?: BotAccount[] | null
    /** Community bots holding a stream right now; null while the flag is off. */
    onlineBots?: BotListing[] | null
    initialOpponent?: LobbyOpponentChoice
    /** A bot opponent, house or community, rides on the request; the route is the same. */
    onCreateLobby: (request: CreateSessionRequest) => void
};

type LocalizedOption<T> = {
    value: T
    title: (t: TFunction) => string
    description: (t: TFunction) => string
};

const visibilityOptions: LocalizedOption<LobbyVisibility>[] = [
    {
        value: `public`,
        title: (t) => t('publicLobby', 'Public Lobby'),
        description: (t) => t('listedInTheLiveBrowser', 'Listed in the live browser.'),
    },
    {
        value: `private`,
        title: (t) => t('privateLobby', 'Private Lobby'),
        description: (t) => t('hiddenUntilSharedDirectly', 'Hidden until shared directly.'),
    },
];

const firstPlayerOptions: LocalizedOption<LobbyFirstPlayer>[] = [
    {
        value: `random`,
        title: (t) => t('random', 'Random'),
        description: (t) => t('randomlyChooseWhoOpensTheGame', 'Randomly choose who opens the game.'),
    },
    {
        value: `host`,
        title: (t) => t('hostStarts', 'Host Starts'),
        description: (t) => t('thePlayerWhoCreatesTheLobbyTakesTheFirstTurn', 'The player who creates the lobby takes the first turn.'),
    },
    {
        value: `guest`,
        title: (t) => t('guestStarts', 'Guest Starts'),
        description: (t) => t('theJoiningPlayerTakesTheFirstTurn', 'The joining player takes the first turn.'),
    },
];

function CreateLobbyDialog({
    isOpen,
    onClose,
    account,
    houseBots = null,
    ownBots = null,
    onlineBots = null,
    initialOpponent = `open`,
    onCreateLobby,
}: Readonly<CreateLobbyDialogProps>) {
    const { t } = useTranslation()
    const canCreateRatedLobby = Boolean(account);
    const [visibility, setVisibility] = useState<LobbyVisibility>(`public`);
    const [rated, setRated] = useState(canCreateRatedLobby);
    const [firstPlayer, setFirstPlayer] = useState<LobbyFirstPlayer>(`random`);
    const [opponentBotId, setOpponentBotId] = useState<string | null>(null);
    const [thinkMs, setThinkMs] = useState(0);
    const [communityBotId, setCommunityBotId] = useState<string | null>(null);
    const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
    const timeControl = useLobbyTimeControl();

    useEffect(() => {
        setRated(canCreateRatedLobby);
    }, [canCreateRatedLobby]);

    const canPickBot = houseBots !== null && houseBots.available && houseBots.bots.length > 0;
    const selectBot = (bot: HouseBotListing | null) => {
        setOpponentBotId(bot?.profileId ?? null);
        setThinkMs(bot?.thinkMs.default ?? 0);
        setCommunityBotId(null);
    };
    const selectCommunityBot = (profileId: string) => {
        selectBot(null);
        setCommunityBotId(profileId);
    };
    /* Own bots first: the owner's are listed by account, the rest by their stream. */
    const communityBots: Array<{ profileId: string, username: string, own: boolean }> = [
        ...(ownBots ?? []).map((bot) => ({ profileId: bot.id, username: bot.username, own: true })),
        ...(onlineBots ?? [])
            .filter((bot) => !ownBots?.some((own) => own.id === bot.profileId))
            .map((bot) => ({ profileId: bot.profileId, username: bot.displayName, own: false })),
    ];

    /* A string key, so a parent re-rendering with an equal choice does not reset the dialog. */
    const initialOpponentKey = typeof initialOpponent === `object` ? `${initialOpponent.kind}:${initialOpponent.profileId}` : initialOpponent;
    useEffect(() => {
        if (isOpen) {
            setShowAdvancedOptions(false);
            if (typeof initialOpponent === `object` && initialOpponent.kind === `bot`) {
                selectCommunityBot(initialOpponent.profileId);
            } else if (typeof initialOpponent === `object`) {
                selectBot(canPickBot ? houseBots.bots.find((bot) => bot.profileId === initialOpponent.profileId) ?? null : null);
            } else {
                selectBot(initialOpponent === `house-bot` && canPickBot ? houseBots.bots[0] : null);
            }
        }
        /* Opening resets the opponent; what the lists hold while open is not a reset. */
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialOpponentKey]);

    const selectedBot = opponentBotId
        ? houseBots?.bots.find((bot) => bot.profileId === opponentBotId) ?? null
        : null;
    const selectedCommunityBot = communityBotId
        ? communityBots.find((bot) => bot.profileId === communityBotId) ?? null
        : null;
    const botSeated = selectedBot !== null || selectedCommunityBot !== null;
    const selectedFirstPlayer = firstPlayerOptions.find((option) => option.value === firstPlayer) ?? firstPlayerOptions[0];
    /* A bot seat is never rated and the server picks who starts; the dialog stops
     * offering choices it would not honour. */
    const isRated = botSeated ? false : rated;
    const firstPlayerTitle = botSeated ? t('random', 'Random') : selectedFirstPlayer.title(t);
    const visibilityTitle = visibility === `private` ? t('private', 'Private') : t('public', 'Public');

    if (!isOpen) {
        return null;
    }

    const handleCreate = () => {
        const request: CreateSessionRequest = {
            lobbyOptions: {
                visibility,
                timeControl: timeControl.selectedTimeControl,
                rated: isRated,
                firstPlayer: botSeated ? `random` : firstPlayer,
            },
        };
        if (selectedBot) {
            request.opponent = { kind: `house-bot`, profileId: selectedBot.profileId, thinkMs };
        } else if (selectedCommunityBot) {
            request.opponent = { kind: `bot`, profileId: selectedCommunityBot.profileId };
        }

        onCreateLobby(request);
    };

    const badges = [
        isRated ? t('rated', 'Rated') : t('casual', 'Casual'),
        visibilityTitle,
        firstPlayerTitle
    ]

    const opponentSection = (houseBots || ownBots || onlineBots) && (
        <section className="p-0" data-testid="opponent-section">
            <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                    {t('opponent', 'Opponent')}
                </div>

                <div className="flex items-center gap-2 rounded-full bg-white/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                    {selectedBot ? (
                        <>
                            {selectedBot.displayName} {formatThinkSeconds(thinkMs)}
                            <BotBadge />
                        </>
                    ) : selectedCommunityBot ? (
                        <>
                            {selectedCommunityBot.username}
                            <BotBadge />
                        </>
                    ) : t('openLobby', 'Open lobby')}
                </div>
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-2">
                <SelectableOptions
                    onClick={() => selectBot(null)}
                    selected={!botSeated}
                    title={t('openLobby', 'Open lobby')}
                    description={t('anyoneCanTakeTheOtherSeat', 'Anyone can take the other seat.')}
                />

                {(houseBots?.bots ?? []).map((bot) => (
                    <SelectableOptions
                        key={bot.profileId}
                        onClick={() => selectBot(bot)}
                        selected={selectedBot?.profileId === bot.profileId}
                        disabled={!houseBots?.available}
                        title={bot.displayName}
                        description={houseBots?.available
                            ? t('theServerPlaysYouAtTheStrengthYouPick', 'The server plays you at the strength you pick.')
                            : t('busyInEveryGameItCanPlayRightNow', 'Busy in every game it can play right now. Try again in a moment.')}
                    />
                ))}

                {communityBots.map((bot) => (
                    <SelectableOptions
                        key={bot.profileId}
                        onClick={() => selectCommunityBot(bot.profileId)}
                        selected={selectedCommunityBot?.profileId === bot.profileId}
                        title={bot.username}
                        description={bot.own
                            ? t('yourBotJoinsTheOtherSeat', 'Your bot takes the other seat.')
                            : t('aCommunityBotOnlineRightNow', 'A community bot, online right now.')}
                    />
                ))}
            </div>

            {selectedCommunityBot && (
                <div className="mt-2.5 rounded-[0.9rem] border border-white/8 bg-white/4 px-3 py-2.5 text-xs leading-5 text-slate-300">
                    {t('botGameNote', 'Games against a bot are unrated and the first player is chosen at random.')}
                </div>
            )}

            {selectedBot && (
                <HouseBotStrengthPicker
                    key={selectedBot.profileId}
                    bot={selectedBot}
                    thinkMs={thinkMs}
                    onChange={setThinkMs}
                />
            )}
        </section>
    );

    return (
        <LobbyDialogShell
            onClose={onClose}
            accent={<div className="absolute -left-8 bottom-0 h-16 w-16 rounded-full bg-amber-300/12 blur-3xl" />}
        >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">
                                    {t('createLobby', 'Create Lobby')}
                                </div>

                                <h2 className="mt-1 text-lg font-black uppercase tracking-[0.05em] text-white sm:text-xl">
                                    {t('lobbySetup', 'Lobby Setup')}
                                </h2>
                            </div>

                            <Button
                                type="button"
                                aria-expanded={showAdvancedOptions}
                                onClick={() => setShowAdvancedOptions((value) => !value)}
                                variant="info" size="sm"
                            >
                                {showAdvancedOptions ? t('simpleSettings', 'Simple Settings') : t('advancedSettings', 'Advanced Settings')}
                            </Button>
                        </div>

                        <div className="mt-3 flex flex-col gap-4 sm:gap-6">
                            {!showAdvancedOptions && (
                                <section className="p-0">
                                    <div className="rounded-[0.9rem] flex flex-row pb-2.5 text-xs leading-5 text-slate-300 gap-2">
                                        {badges.map(name => (
                                            <div key={name} className="rounded-full bg-white/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]">
                                                {name}
                                            </div>
                                        ))}
                                    </div>

                                    {opponentSection && (
                                        <div className="mb-4 sm:mb-6">
                                            {opponentSection}
                                        </div>
                                    )}

                                    <LobbyTimeControlSelector timeControl={timeControl} />
                                </section>
                            )}

                            {showAdvancedOptions && (
                                <>
                                    {opponentSection}

                                    {!botSeated && (
                                    <section className="p-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                                                    {t('mode', 'Mode')}
                                                </div>
                                            </div>

                                            <div className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${rated ? `bg-amber-300/15 text-amber-100` : `bg-white/8 text-slate-100`}`}>
                                                {rated ? t('rated', 'Rated') : t('casual', 'Casual')}
                                            </div>
                                        </div>

                                        <div className="mt-2.5 grid grid-cols-2 gap-2">
                                            <SelectableOptions
                                                onClick={() => setRated(false)}
                                                selected={!rated}
                                                title={t('casual', 'Casual')}
                                                description={t('casualUnratedGame', 'Casual unrated game')}
                                            />

                                            <SelectableOptions
                                                onClick={() => {
                                                    if (canCreateRatedLobby) {
                                                        setRated(true);
                                                    }
                                                }}
                                                selected={rated}
                                                disabled={!canCreateRatedLobby}
                                                title={t('rated', 'Rated')}
                                                description={t('ratedGameWithElo', 'Rated game with ELO')}
                                            />
                                        </div>

                                        {!canCreateRatedLobby && (
                                            <div className="mt-2.5 rounded-[0.9rem] border border-amber-300/20 bg-amber-300/10 px-3 py-2.5 text-xs leading-5 text-amber-50/85">
                                                {t('ratedLobbiesAreForAuthenticatedPlayersOnly', 'Rated lobbies are for authenticated players only.')}
                                            </div>
                                        )}
                                    </section>
                                    )}

                                    <section className="p-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                                                    {t('visibility', 'Visibility')}
                                                </div>
                                            </div>

                                            <div className="rounded-full bg-white/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                                                {visibilityTitle}
                                            </div>
                                        </div>

                                        <div className="mt-2.5 grid grid-cols-2 gap-2">
                                            {visibilityOptions.map((option) => {
                                                const selected = visibility === option.value;

                                                return (
                                                    <SelectableOptions
                                                        key={option.value}

                                                        onClick={() => setVisibility(option.value)}
                                                        selected={selected}

                                                        title={option.title(t)}
                                                        description={option.description(t)}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </section>

                                    {!botSeated && (
                                    <section className="p-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                                                    {t('firstPlayer', 'First Player')}
                                                </div>
                                            </div>

                                            <div className="rounded-full bg-white/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                                                {firstPlayerTitle}
                                            </div>
                                        </div>

                                        <div className="mt-2.5 grid gap-2 md:grid-cols-3">
                                            {firstPlayerOptions.map((option) => {
                                                const selected = firstPlayer === option.value;

                                                return (
                                                    <SelectableOptions
                                                        key={option.value}
                                                        onClick={() => setFirstPlayer(option.value)}
                                                        selected={selected}
                                                        title={option.title(t)}
                                                        description={option.description(t)}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </section>
                                    )}


                                    <section>
                                        <LobbyTimeControlSelector timeControl={timeControl} />
                                    </section>
                                </>
                            )}
                        </div>

                        <div className="mt-2.5 flex items-center justify-between gap-3">
                            <Button
                                onClick={onClose}
                                variant="outline" size="default"
                            >
                                {t('cancel', 'Cancel')}
                            </Button>

                            <Button
                                onClick={handleCreate}
                                variant="secondary" size="default"
                            >
                                {t('createLobby', 'Create Lobby')}
                            </Button>
                        </div>
        </LobbyDialogShell>
    );
}

export default CreateLobbyDialog;
