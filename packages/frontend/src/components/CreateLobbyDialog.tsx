import { Button } from '@/components/ui/button';
import type { AccountProfile, BotAccount, CreateSessionRequest, LobbyFirstPlayer, LobbyVisibility } from '@ih3t/shared';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';

import BotBadge from './BotBadge';
import TimeControlSelector from './TimeControlSelector';
import { SelectableOptions, useLobbyTimeControl } from './lobbyOptionsShared';
import { useTranslation } from 'react-i18next'

type CreateLobbyDialogProps = {
    isOpen: boolean
    onClose: () => void
    account: AccountProfile | null
    /** The signed-in player's bots; null while the flag is off hides the entry. */
    ownBots?: BotAccount[] | null
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

function CreateLobbyDialog({
    isOpen,
    onClose,
    account,
    ownBots = null,
    onCreateLobby,
}: Readonly<CreateLobbyDialogProps>) {
    const { t } = useTranslation()
    const canCreateRatedLobby = Boolean(account);
    const [visibility, setVisibility] = useState<LobbyVisibility>(`public`);
    const [rated, setRated] = useState(canCreateRatedLobby);
    const [firstPlayer, setFirstPlayer] = useState<LobbyFirstPlayer>(`random`);
    const [botProfileId, setBotProfileId] = useState<string | null>(null);
    const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
    const timeControl = useLobbyTimeControl();
    const selectedBot = ownBots?.find((bot) => bot.id === botProfileId) ?? null;

    useEffect(() => {
        setRated(canCreateRatedLobby);
    }, [canCreateRatedLobby]);

    useEffect(() => {
        if (isOpen) {
            setShowAdvancedOptions(false);
            setBotProfileId(null);
        }
    }, [isOpen]);

    const selectedFirstPlayer = firstPlayerOptions.find((option) => option.value === firstPlayer) ?? firstPlayerOptions[0];
    const firstPlayerTitle = selectedFirstPlayer.title(t);
    /* A bot seat is never rated — the server enforces it; the dialog just stops
     * offering a choice it would not honour. */
    const isRated = selectedBot ? false : rated;

    if (!isOpen) {
        return null;
    }

    const handleCreate = () => {
        onCreateLobby({
            lobbyOptions: {
                visibility,
                timeControl: timeControl.selectedTimeControl,
                rated: isRated,
                firstPlayer,
            },
        }, botProfileId ?? undefined);
    };

    const badges = [
        isRated ? t('rated', 'Rated') : t('casual', 'Casual'),
        selectedBot ? t('private', 'Private') : visibility === `private` ? t('private', 'Private') : t('public', 'Public'),
        selectedBot ? t('random', 'Random') : firstPlayerTitle
    ]

    return (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-950/70 px-4 py-6 backdrop-blur-md flex flex-col">
            <div
                className="absolute inset-0"
                onClick={onClose}
            />

            <div className="relative my-auto z-10 flex self-center items-center justify-center">
                <section className="relative my-auto w-full max-w-2xl overflow-hidden rounded-[1.25rem] border border-white/10 bg-[linear-gradient(155deg,rgba(15,23,42,0.97),rgba(17,24,39,0.95)_55%,rgba(30,41,59,0.92))] p-3.5 text-white shadow-[0_24px_80px_rgba(2,6,23,0.55)] sm:p-4">
                    <div className="absolute -right-10 -top-14 h-20 w-20 rounded-full bg-sky-400/16 blur-3xl" />
                    <div className="absolute -left-8 bottom-0 h-16 w-16 rounded-full bg-amber-300/12 blur-3xl" />

                    <div className="relative">
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

                                    <TimeControlSelector
                                        mode={timeControl.mode}
                                        selectedTimeControl={timeControl.selectedTimeControl}
                                        turnTimeSeconds={timeControl.turnTimeSeconds}
                                        matchTimeMinutes={timeControl.matchTimeMinutes}
                                        incrementSeconds={timeControl.incrementSeconds}
                                        turnTimeStepCount={timeControl.turnTimeStepCount}
                                        matchTimeStepCount={timeControl.matchTimeStepCount}
                                        incrementStepCount={timeControl.incrementStepCount}
                                        turnTimeStepIndex={timeControl.turnTimeStepIndex}
                                        matchTimeStepIndex={timeControl.matchTimeStepIndex}
                                        incrementStepIndex={timeControl.incrementStepIndex}
                                        onModeChange={timeControl.setMode}
                                        onTurnTimeStepIndexChange={timeControl.setTurnTimeStepIndex}
                                        onMatchTimeStepIndexChange={timeControl.setMatchTimeStepIndex}
                                        onIncrementStepIndexChange={timeControl.setIncrementStepIndex}
                                    />
                                </section>
                            )}

                            {showAdvancedOptions && (
                                <>
                                    {!selectedBot && (
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

                                    {ownBots && ownBots.length > 0 && (
                                        <section className="p-0">
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                                                    {t('opponent', 'Opponent')}
                                                </div>

                                                <div className="flex items-center gap-2 rounded-full bg-white/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                                                    {selectedBot ? (
                                                        <>
                                                            {selectedBot.username}
                                                            <BotBadge />
                                                        </>
                                                    ) : t('humanOpponent', 'Human opponent')}
                                                </div>
                                            </div>

                                            <div className="mt-2.5 grid gap-2 md:grid-cols-3">
                                                <SelectableOptions
                                                    onClick={() => setBotProfileId(null)}
                                                    selected={!selectedBot}
                                                    title={t('humanOpponent', 'Human opponent')}
                                                    description={t('anyoneWhoFindsThisLobby', 'Anyone who finds this lobby.')}
                                                />

                                                {ownBots.map((bot) => (
                                                    <SelectableOptions
                                                        key={bot.id}
                                                        onClick={() => setBotProfileId(bot.id)}
                                                        selected={selectedBot?.id === bot.id}
                                                        title={bot.username}
                                                        description={t('yourBotJoinsTheOtherSeat', 'Your bot takes the other seat.')}
                                                    />
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                    {!selectedBot && (
                                    <>
                                    <section className="p-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                                                    {t('visibility', 'Visibility')}
                                                </div>
                                            </div>

                                            <div className="rounded-full bg-white/8 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                                                {visibility === `private` ? t('private', 'Private') : t('public', 'Public')}
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
                                    </>
                                    )}

                                    {selectedBot && (
                                        <div className="rounded-[0.9rem] border border-white/8 bg-white/4 px-3 py-2.5 text-xs leading-5 text-slate-300">
                                            {t('botGameNote', 'Games against a bot are unrated, private, and the first player is chosen at random.')}
                                        </div>
                                    )}

                                    <section>
                                        <TimeControlSelector
                                            mode={timeControl.mode}
                                            selectedTimeControl={timeControl.selectedTimeControl}
                                            turnTimeSeconds={timeControl.turnTimeSeconds}
                                            matchTimeMinutes={timeControl.matchTimeMinutes}
                                            incrementSeconds={timeControl.incrementSeconds}
                                            turnTimeStepCount={timeControl.turnTimeStepCount}
                                            matchTimeStepCount={timeControl.matchTimeStepCount}
                                            incrementStepCount={timeControl.incrementStepCount}
                                            turnTimeStepIndex={timeControl.turnTimeStepIndex}
                                            matchTimeStepIndex={timeControl.matchTimeStepIndex}
                                            incrementStepIndex={timeControl.incrementStepIndex}
                                            onModeChange={timeControl.setMode}
                                            onTurnTimeStepIndexChange={timeControl.setTurnTimeStepIndex}
                                            onMatchTimeStepIndexChange={timeControl.setMatchTimeStepIndex}
                                            onIncrementStepIndexChange={timeControl.setIncrementStepIndex}
                                        />
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
                    </div>
                </section>
            </div>
        </div>
    );
}

export default CreateLobbyDialog;
