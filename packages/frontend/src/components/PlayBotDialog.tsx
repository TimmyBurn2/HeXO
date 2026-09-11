import { Button } from '@/components/ui/button';
import type { BotListing, CreateBotSessionRequest } from '@ih3t/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import BotBadge from './BotBadge';
import TimeControlSelector from './TimeControlSelector';
import { useLobbyTimeControl } from './lobbyOptionsShared';

type PlayBotDialogProps = {
    isOpen: boolean
    onClose: () => void
    bot: BotListing
    onStart: (request: CreateBotSessionRequest) => Promise<void>
};

/**
 * The one option a human picks against a bot: the time control. The server owns
 * the rest — the session is private, the first player is random, and every game
 * with a bot is unrated, so those pickers are absent on purpose.
 */
function PlayBotDialog({
    isOpen,
    onClose,
    bot,
    onStart,
}: Readonly<PlayBotDialogProps>) {
    const { t } = useTranslation()
    const [isStarting, setIsStarting] = useState(false);
    const timeControl = useLobbyTimeControl();

    if (!isOpen) {
        return null;
    }

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
                            {t('playABot', 'Play a Bot')}
                        </div>

                        <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-black uppercase tracking-[0.05em] text-white sm:text-xl">
                            {bot.displayName}
                            <BotBadge />
                        </h2>

                        <div className="mt-3 flex flex-col gap-4 sm:gap-6">
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

                            <div className="rounded-[0.9rem] border border-white/8 bg-white/4 px-3 py-2.5 text-xs leading-5 text-slate-300">
                                {t('botGameNote', 'Games against a bot are unrated, private, and the first player is chosen at random.')}
                            </div>
                        </div>

                        <div className="mt-2.5 flex items-center justify-between gap-3">
                            <Button
                                onClick={onClose}
                                variant="outline" size="default"
                            >
                                {t('cancel', 'Cancel')}
                            </Button>

                            <Button
                                onClick={() => {
                                    setIsStarting(true);
                                    void onStart({
                                        timeControl: timeControl.selectedTimeControl,
                                    }).finally(() => setIsStarting(false));
                                }}
                                disabled={isStarting}
                                variant="secondary" size="default"
                            >
                                {t('playBot', 'Play')}
                            </Button>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}

export default PlayBotDialog;
