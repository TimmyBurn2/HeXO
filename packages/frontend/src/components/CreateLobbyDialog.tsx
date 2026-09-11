import { Button } from '@/components/ui/button';
import type { AccountProfile, BotAccount, BotListing, CreateSessionRequest, HouseBotListing, HouseBotsResponse, LobbyFirstPlayer, LobbyVisibility } from '@ih3t/shared';
import { formatThinkSeconds } from '@ih3t/shared';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';

import BotBadge from './BotBadge';
import { LobbyDialogShell, LobbyTimeControlSelector, SelectableOptions, useLobbyTimeControl } from './lobbyOptionsShared';
import { useTranslation } from 'react-i18next'

/** What the dialog opens on: an open lobby, the first house bot, or one named community bot. */
export type LobbyOpponentChoice = `open` | `house-bot` | { kind: `bot`, profileId: string };

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
    /** A community bot takes the reserved-seat route, named by its profile id. */
    onCreateLobby: (request: CreateSessionRequest, botProfileId?: string) => void
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

/* The custom-strength slider's ladder, cut to what the chosen bot's engine allows. */
const THINK_TIME_LADDER_MS = [
    10, 20, 50, 100, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000,
] as const;

/* Preset ids the server may send; anything else is shown by its think time alone. */
const strengthPresetLabels: Record<string, (t: TFunction) => string> = {
    beginner: (t) => t('beginner', 'Beginner'),
    easy: (t) => t('easy', 'Easy'),
    medium: (t) => t('medium', 'Medium'),
    hard: (t) => t('hard', 'Hard'),
    expert: (t) => t('expert', 'Expert'),
};

function thinkTimeSteps(bot: HouseBotListing): number[] {
    const steps = THINK_TIME_LADDER_MS.filter((step) => step >= bot.thinkMs.min && step <= bot.thinkMs.max);
    return steps.length > 0 ? steps : [bot.thinkMs.default];
}

function nearestStepIndex(steps: readonly number[], thinkMs: number): number {
    let best = 0;
    for (let index = 1; index < steps.length; index += 1) {
        if (Math.abs(steps[index] - thinkMs) < Math.abs(steps[best] - thinkMs)) {
            best = index;
        }
    }

    return best;
}

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
    const [customStrength, setCustomStrength] = useState(false);
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
        setCustomStrength(false);
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

    useEffect(() => {
        if (isOpen) {
            setShowAdvancedOptions(false);
            if (typeof initialOpponent === `object`) {
                selectCommunityBot(initialOpponent.profileId);
            } else {
                selectBot(initialOpponent === `house-bot` && canPickBot ? houseBots.bots[0] : null);
            }
        }
        /* Opening resets the opponent; what the lists hold while open is not a reset. */
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialOpponent]);

    const selectedBot = opponentBotId
        ? houseBots?.bots.find((bot) => bot.profileId === opponentBotId) ?? null
        : null;
    const selectedCommunityBot = communityBotId
        ? communityBots.find((bot) => bot.profileId === communityBotId) ?? null
        : null;
    const botSeated = selectedBot !== null || selectedCommunityBot !== null;
    const strengthSteps = selectedBot ? thinkTimeSteps(selectedBot) : [];
    const selectedPreset = selectedBot && !customStrength
        ? selectedBot.presets.find((preset) => preset.thinkMs === thinkMs) ?? null
        : null;
    const presetLabel = (id: string) => strengthPresetLabels[id]?.(t) ?? null;

    const selectedFirstPlayer = firstPlayerOptions.find((option) => option.value === firstPlayer) ?? firstPlayerOptions[0];
    /* A bot seat is never rated and the server picks who starts; the dialog stops
     * offering choices it would not honour. A community bot's lobby is private too. */
    const isRated = botSeated ? false : rated;
    const firstPlayerTitle = botSeated ? t('random', 'Random') : selectedFirstPlayer.title(t);
    const visibilityTitle = selectedCommunityBot || visibility === `private` ? t('private', 'Private') : t('public', 'Public');

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
        }

        onCreateLobby(request, selectedCommunityBot?.profileId);
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
                    {t('botGameNote', 'Games against a bot are unrated, private, and the first player is chosen at random.')}
                </div>
            )}

            {selectedBot && (
                <div className="mt-2.5 rounded-[0.9rem] border border-white/8 bg-white/4 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                            {t('strength', 'Strength')}
                        </div>

                        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                            {selectedPreset
                                ? presetLabel(selectedPreset.id) && <span>{presetLabel(selectedPreset.id)}</span>
                                : <span>{t('custom', 'Custom')}</span>}
                            <span>{formatThinkSeconds(thinkMs)}</span>
                        </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('strength', 'Strength')}>
                        {selectedBot.presets.map((preset) => {
                            const active = selectedPreset?.id === preset.id;
                            const label = presetLabel(preset.id);

                            return (
                                <button
                                    key={preset.id}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => {
                                        setCustomStrength(false);
                                        setThinkMs(preset.thinkMs);
                                    }}
                                    className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${active
                                        ? `border-sky-300/35 bg-sky-300/15 text-white`
                                        : `border-white/10 bg-white/6 text-slate-200 hover:border-white/20 hover:bg-white/10`}`}
                                >
                                    {label ? `${label} · ` : ``}{formatThinkSeconds(preset.thinkMs)}
                                </button>
                            );
                        })}

                        {strengthSteps.length > 1 && (
                        <button
                            type="button"
                            aria-pressed={customStrength}
                            onClick={() => setCustomStrength(true)}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${customStrength
                                ? `border-sky-300/35 bg-sky-300/15 text-white`
                                : `border-white/10 bg-white/6 text-slate-200 hover:border-white/20 hover:bg-white/10`}`}
                        >
                            {t('custom', 'Custom')}
                        </button>
                        )}
                    </div>

                    {customStrength && strengthSteps.length > 1 && (
                        <div className="mt-2.5 space-y-1.5">
                            <input
                                type="range"
                                min={0}
                                max={strengthSteps.length - 1}
                                step={1}
                                value={nearestStepIndex(strengthSteps, thinkMs)}
                                aria-label={t('thinkTimePerTurn', 'Think time per turn')}
                                onChange={(event) => setThinkMs(strengthSteps[Number(event.target.value)])}
                                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-sky-300"
                            />

                            <div className="flex justify-between text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                <span>{formatThinkSeconds(strengthSteps[0])}</span>
                                <span>{formatThinkSeconds(strengthSteps[strengthSteps.length - 1])}</span>
                            </div>
                        </div>
                    )}

                    <div className="mt-2 text-[11px] leading-4.5 text-slate-300">
                        {t('theLongerItThinksTheDeeperItSearches', 'The longer it thinks per turn, the deeper it searches. Games against it are unrated.')}
                    </div>
                </div>
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

                                    {!selectedCommunityBot && (
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
                                    )}

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
