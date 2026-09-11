import { Button } from '@/components/ui/button';
import type { BotAccount, BotChallengeFirstPlayer, PublicAccountProfile } from '@ih3t/shared';
import type { TFunction } from 'i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';

import { joinSession } from '../liveGameClient';
import { cancelBotChallenge, createBotChallenge, useQueryBotChallenges } from '../query/botsClient';
import { queryKeys } from '../query/queryDefinitions';
import TimeControlSelector from './TimeControlSelector';
import { SelectableOptions, useLobbyTimeControl } from './lobbyOptionsShared';

type ChallengeDialogProps = {
    isOpen: boolean
    onClose: () => void
    /** The bot being challenged; it must answer from its own stream. */
    target: PublicAccountProfile
    /** The signed-in player's bots; the challenger is picked from these. */
    ownBots: BotAccount[]
};

type LocalizedOption = {
    value: BotChallengeFirstPlayer
    title: (t: TFunction) => string
    description: (t: TFunction) => string
};

const firstPlayerOptions: LocalizedOption[] = [
    {
        value: `random`,
        title: (t) => t('random', 'Random'),
        description: (t) => t('randomlyChooseWhoOpensTheGame', 'Randomly choose who opens the game.'),
    },
    {
        value: `challenger`,
        title: (t) => t('challengerStarts', 'Challenger Starts'),
        description: (t) => t('theChallengingBotTakesTheFirstTurn', 'The challenging bot takes the first turn.'),
    },
    {
        value: `challenged`,
        title: (t) => t('challengedStarts', 'Challenged Starts'),
        description: (t) => t('theChallengedBotTakesTheFirstTurn', 'The challenged bot takes the first turn.'),
    },
];

/**
 * The owner's Challenge action: one of their bots challenges this one, on the time
 * control and first-player choice picked here. The pending list and its Cancel live in
 * the same place, and Watch opens the ordinary session URL — the owner spectates the
 * lobby and sees the game start when the target accepts.
 */
function ChallengeDialog({ isOpen, onClose, target, ownBots }: Readonly<ChallengeDialogProps>) {
    const { t } = useTranslation()
    const queryClient = useQueryClient();
    const [challengerBotProfileId, setChallengerBotProfileId] = useState(ownBots[0]?.id ?? ``);
    const [firstPlayer, setFirstPlayer] = useState<BotChallengeFirstPlayer>(`random`);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const timeControl = useLobbyTimeControl();

    const pendingQuery = useQueryBotChallenges(target.id, { enabled: isOpen });

    useEffect(() => {
        if (isOpen) {
            setChallengerBotProfileId(ownBots[0]?.id ?? ``);
            setFirstPlayer(`random`);
        }
    }, [isOpen, ownBots]);

    if (!isOpen) {
        return null;
    }

    const pendingChallenges = pendingQuery.data?.challenges ?? [];

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.botChallenges(target.id) });
    };

    const handleCreate = async () => {
        if (!challengerBotProfileId) {
            return;
        }

        setIsSubmitting(true);
        try {
            await createBotChallenge(target.id, {
                challengerBotProfileId,
                timeControl: timeControl.selectedTimeControl,
                firstPlayer,
            });
            refresh();
        } catch (error) {
            console.error(`Failed to create a challenge:`, error);
            const message = error instanceof Error ? error.message : t('failedToChallenge', 'The challenge could not be created.');
            toast.error(message, { toastId: `error:${message}` });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancel = async (challengeId: string) => {
        try {
            await cancelBotChallenge(target.id, challengeId);
            refresh();
        } catch (error) {
            console.error(`Failed to cancel a challenge:`, error);
            const message = error instanceof Error ? error.message : t('failedToCancelChallenge', 'The challenge could not be canceled.');
            toast.error(message, { toastId: `error:${message}` });
        }
    };

    return (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-950/70 px-4 py-6 backdrop-blur-md flex flex-col">
            <div
                className="absolute inset-0"
                onClick={onClose}
            />

            <div className="relative my-auto z-10 flex self-center items-center justify-center">
                <section className="relative my-auto w-full max-w-2xl overflow-hidden rounded-[1.25rem] border border-white/10 bg-[linear-gradient(155deg,rgba(15,23,42,0.97),rgba(17,24,39,0.95)_55%,rgba(30,41,59,0.92))] p-3.5 text-white shadow-[0_24px_80px_rgba(2,6,23,0.55)] sm:p-4">
                    <div className="absolute -right-10 -top-14 h-20 w-20 rounded-full bg-sky-400/16 blur-3xl" />

                    <div className="relative">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">
                            {t('challengeABot', 'Challenge a Bot')}
                        </div>

                        <h2 className="mt-1 text-lg font-black uppercase tracking-[0.05em] text-white sm:text-xl">
                            {target.username}
                        </h2>

                        <div className="mt-3 flex flex-col gap-4 sm:gap-6">
                            <section className="p-0">
                                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                                    {t('yourBot', 'Your bot')}
                                </label>
                                <select
                                    value={challengerBotProfileId}
                                    onChange={(event) => setChallengerBotProfileId(event.target.value)}
                                    className="w-full rounded-[0.9rem] border border-white/10 bg-slate-900/70 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-sky-300/40"
                                >
                                    {ownBots.map((bot) => (
                                        <option key={bot.id} value={bot.id}>
                                            {bot.username}
                                        </option>
                                    ))}
                                </select>
                            </section>

                            <section className="p-0">
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

                            <section className="p-0">
                                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                                    {t('firstPlayer', 'First Player')}
                                </label>
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    {firstPlayerOptions.map((option) => (
                                        <SelectableOptions
                                            key={option.value}
                                            onClick={() => setFirstPlayer(option.value)}
                                            selected={firstPlayer === option.value}
                                            title={option.title(t)}
                                            description={option.description(t)}
                                        />
                                    ))}
                                </div>
                            </section>

                            <div className="rounded-[0.9rem] border border-white/8 bg-white/4 px-3 py-2.5 text-xs leading-5 text-slate-300">
                                {t('challengeNote', 'Bot challenges are private and unrated. The challenged bot answers from its stream; an unanswered challenge expires after five minutes.')}
                            </div>

                            {pendingChallenges.length > 0 ? (
                                <section className="p-0">
                                    <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                                        {t('pendingChallenges', 'Pending challenges')}
                                    </label>
                                    <ul className="flex flex-col gap-2">
                                        {pendingChallenges.map((challenge) => (
                                            <li
                                                key={challenge.challengeId}
                                                className="flex items-center justify-between gap-3 rounded-[0.9rem] border border-white/10 bg-white/4 px-3 py-2 text-sm text-slate-200"
                                            >
                                                <span className="min-w-0 truncate">
                                                    {challenge.challenger.displayName}
                                                    {` → `}
                                                    {challenge.destUser.displayName}
                                                </span>
                                                <span className="flex shrink-0 items-center gap-2">
                                                    <Button
                                                        onClick={() => joinSession(challenge.sessionId)}
                                                        variant="outline" size="xs"
                                                    >
                                                        {t('watchGame', 'Watch')}
                                                    </Button>
                                                    <Button
                                                        onClick={() => void handleCancel(challenge.challengeId)}
                                                        variant="outline" size="xs"
                                                    >
                                                        {t('cancelChallenge', 'Cancel Challenge')}
                                                    </Button>
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            ) : null}
                        </div>

                        <div className="mt-2.5 flex items-center justify-between gap-3">
                            <Button
                                onClick={onClose}
                                variant="outline" size="default"
                            >
                                {t('cancel', 'Cancel')}
                            </Button>

                            <Button
                                onClick={() => void handleCreate()}
                                disabled={isSubmitting || !challengerBotProfileId}
                                variant="secondary" size="default"
                            >
                                {t('challenge', 'Challenge')}
                            </Button>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}

export default ChallengeDialog;
