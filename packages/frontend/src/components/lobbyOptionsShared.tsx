import type { GameTimeControl } from '@ih3t/shared';
import { useMemo, useState } from 'react';

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
