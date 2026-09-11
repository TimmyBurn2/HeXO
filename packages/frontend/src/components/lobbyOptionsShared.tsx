import type { GameTimeControl } from '@ih3t/shared';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import TimeControlSelector from './TimeControlSelector';

/** The lobby options more than one dialog offers: the time control picker's state. */
export const TURN_TIME_STEP_SECONDS = [
    5, 10, 15, 20, 30, 45, 60, 90, 120,
] as const;
export const TURN_TIME_DEFAULT = 45;

export const MATCH_TIME_STEP_MINUTES = [
    1, 2, 3, 4, 5, 10, 15, 20, 30, 45, 60,
] as const;
export const MATCH_TIME_DEFAULT = 5;

export const INCREMENT_STEP_SECONDS = [
    0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300,
] as const;
export const INCREMENT_DEFAULT = 5;

export function useLobbyTimeControl() {
    const [mode, setMode] = useState<GameTimeControl[`mode`]>(`match`);
    const [turnTimeStepIndex, setTurnTimeStepIndex] = useState(TURN_TIME_STEP_SECONDS.indexOf(TURN_TIME_DEFAULT));
    const [matchTimeStepIndex, setMatchTimeStepIndex] = useState(MATCH_TIME_STEP_MINUTES.indexOf(MATCH_TIME_DEFAULT));
    const [incrementStepIndex, setIncrementStepIndex] = useState(INCREMENT_STEP_SECONDS.indexOf(INCREMENT_DEFAULT));

    const turnTimeSeconds = TURN_TIME_STEP_SECONDS[turnTimeStepIndex];
    const matchTimeMinutes = MATCH_TIME_STEP_MINUTES[matchTimeStepIndex];
    const incrementSeconds = INCREMENT_STEP_SECONDS[incrementStepIndex];

    const selectedTimeControl = useMemo<GameTimeControl>(() => {
        if (mode === `turn`) {
            return {
                mode: `turn`,
                turnTimeMs: turnTimeSeconds * 1000,
            };
        }

        if (mode === `match`) {
            return {
                mode: `match`,
                mainTimeMs: matchTimeMinutes * 60 * 1000,
                incrementMs: incrementSeconds * 1000,
            };
        }

        return {
            mode: `unlimited`,
        };
    }, [
        incrementSeconds, matchTimeMinutes, mode, turnTimeSeconds,
    ]);

    return {
        mode,
        setMode,
        turnTimeSeconds,
        matchTimeMinutes,
        incrementSeconds,
        turnTimeStepCount: TURN_TIME_STEP_SECONDS.length,
        matchTimeStepCount: MATCH_TIME_STEP_MINUTES.length,
        incrementStepCount: INCREMENT_STEP_SECONDS.length,
        turnTimeStepIndex,
        matchTimeStepIndex,
        incrementStepIndex,
        setTurnTimeStepIndex,
        setMatchTimeStepIndex,
        setIncrementStepIndex,
        selectedTimeControl,
    };
}

export function SelectableOptions({ onClick, selected, title, description, disabled = false }: Readonly<{ onClick: () => void, selected: boolean, title: string, description: string, disabled?: boolean }>) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`flex flex-col items-start rounded-[0.9rem] border p-3 text-left transition ${selected
                ? `border-sky-300/35 bg-sky-300/10 shadow-[0_8px_18px_rgba(14,165,233,0.1)]`
                : disabled
                    ? `cursor-not-allowed border-white/8 bg-white/4 opacity-60`
                    : `border-white/10 bg-white/6 hover:border-white/20 hover:bg-white/10`
                }`}
        >
            <div className="flex flex-row items-center text-sm font-bold text-white">
                <span className={`mr-2 inline-block h-3.5 w-3.5 align-sub rounded-full border ${selected ? `border-sky-200 bg-sky-300` : `border-white/20 bg-slate-900/40`}`} />
                {title}
            </div>

            <div className="mt-1 text-[11px] leading-4.5 text-slate-300">
                {description}
            </div>
        </button>
    );
}

/** The modal shell the lobby dialogs share: overlay, click-away backdrop, the
 * framed section. `accent` carries a dialog's extra decoration, if it has one. */
export function LobbyDialogShell({ onClose, accent, children }: Readonly<{ onClose: () => void, accent?: ReactNode, children: ReactNode }>) {
    return (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-950/70 px-4 py-6 backdrop-blur-md flex flex-col">
            <div
                className="absolute inset-0"
                onClick={onClose}
            />

            <div className="relative my-auto z-10 flex self-center items-center justify-center">
                <section className="relative my-auto w-full max-w-2xl overflow-hidden rounded-[1.25rem] border border-white/10 bg-[linear-gradient(155deg,rgba(15,23,42,0.97),rgba(17,24,39,0.95)_55%,rgba(30,41,59,0.92))] p-3.5 text-white shadow-[0_24px_80px_rgba(2,6,23,0.55)] sm:p-4">
                    <div className="absolute -right-10 -top-14 h-20 w-20 rounded-full bg-sky-400/16 blur-3xl" />
                    {accent}

                    <div className="relative">
                        {children}
                    </div>
                </section>
            </div>
        </div>
    );
}

/** The selector fed from the hook in one line instead of seventeen props. */
export function LobbyTimeControlSelector({ timeControl }: Readonly<{ timeControl: ReturnType<typeof useLobbyTimeControl> }>) {
    return (
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
    );
}
