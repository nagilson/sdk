// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

export const DEFAULT_MAX_RUNS_PER_DAY = 10;
const MAX_DAILY_RESERVATIONS = 1000;

function isRecord(value)
{
    return value !== null && typeof value === "object"
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isState(state)
{
    return isRecord(state) && state.schemaVersion === 1 && isRecord(state.pipelines);
}

function isRunId(runId)
{
    return typeof runId === "string" && /^[1-9]\d{0,31}$/.test(runId);
}

function isDay(day)
{
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const date = new Date(`${day}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function utcDay(now)
{
    let milliseconds;
    if (now instanceof Date) milliseconds = now.getTime();
    else if (typeof now === "number" && Number.isSafeInteger(now)) milliseconds = now;
    else if (typeof now === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(now))
    {
        milliseconds = Date.parse(now);
        if (!Number.isFinite(milliseconds)) return null;
        const normalized = now.includes(".") ? now : now.replace("Z", ".000Z");
        if (new Date(milliseconds).toISOString() !== normalized) return null;
    }
    if (!Number.isFinite(milliseconds)) return null;
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) return null;
    const day = date.toISOString().slice(0, 10);
    return isDay(day) ? day : null;
}

function isLedger(ledger)
{
    if (!isRecord(ledger) || !isDay(ledger.day)
        || typeof ledger.bootstrap !== "boolean"
        || !Number.isSafeInteger(ledger.count) || ledger.count < 0 || ledger.count > MAX_DAILY_RESERVATIONS
        || !Array.isArray(ledger.runIds) || ledger.runIds.length !== ledger.count
        || !(ledger.highWaterRunId === "0" || isRunId(ledger.highWaterRunId))) return false;
    if (ledger.bootstrap && (ledger.count !== 0 || ledger.highWaterRunId !== "0")) return false;
    let previous = 0n;
    for (const runId of ledger.runIds)
    {
        if (!isRunId(runId) || BigInt(runId) <= previous) return false;
        previous = BigInt(runId);
    }
    return ledger.count === 0 || previous === BigInt(ledger.highWaterRunId);
}

function blocked(state, reason, remaining = 0)
{
    return {allowed: false, reason, remaining, state};
}

/**
 * Explicitly migrate a schema-1 state with no admission ledger. Missing history
 * cannot prove today's spend, so the entire bootstrap UTC day is closed. Persist
 * the returned state even though allowed is false; tomorrow can then roll over.
 * Never reset an existing ledger, including a corrupt one.
 */
export function initializeAdmission(state, {now} = {})
{
    if (!isState(state)) return blocked(state, "invalid-state");
    const day = utcDay(now);
    if (!day) return blocked(state, "invalid-time");
    if (Object.hasOwn(state, "admission"))
    {
        return blocked(state, isLedger(state.admission) ? "already-initialized" : "invalid-ledger");
    }
    return blocked({
        ...state,
        admission: {day, bootstrap: true, count: 0, runIds: [], highWaterRunId: "0"}
    }, "bootstrap");
}

/**
 * Pure, repository-global automatic AI dossier admission, not a per-pipeline cap.
 * now is explicit: epoch milliseconds, a Date, or a canonical UTC ISO timestamp.
 * runId is the positive decimal GITHUB_RUN_ID string, WITHOUT run_attempt.
 *
 * The caller must serialize all automatic collectors in one concurrency group,
 * restore their shared newest checkpoint, and durably upload result.state BEFORE
 * allowing any agent to run. A failed checkpoint upload must prevent AI. A spent
 * reservation is never refunded, even when inference or downstream writes fail.
 *
 * Daily entries are bounded and discarded on rollover. The global numeric high
 * water mark survives, rejecting both reruns and older out-of-order workflow IDs.
 * GitHub run IDs are used in allocation order; an older run arriving late is
 * conservatively denied rather than admitted without bounded replay protection.
 * Losing all history requires explicit bootstrap initialization, not a reset.
 */
export function reserveAdmission(state, {runId, now, maxRunsPerDay = DEFAULT_MAX_RUNS_PER_DAY} = {})
{
    if (!Number.isSafeInteger(maxRunsPerDay) || maxRunsPerDay < 0 || maxRunsPerDay > MAX_DAILY_RESERVATIONS)
    {
        return blocked(state, "invalid-limit");
    }
    if (!isRunId(runId)) return blocked(state, "invalid-run-id");
    const day = utcDay(now);
    if (!day) return blocked(state, "invalid-time");
    if (!isState(state)) return blocked(state, "invalid-state");
    if (!Object.hasOwn(state, "admission")) return blocked(state, "missing-ledger");
    if (!isLedger(state.admission)) return blocked(state, "invalid-ledger");

    let ledger = state.admission;
    if (ledger.day > day) return blocked(state, "clock-regression");
    if (BigInt(runId) <= BigInt(ledger.highWaterRunId))
    {
        const remaining = Math.max(0, maxRunsPerDay - (ledger.day === day ? ledger.count : 0));
        return blocked(state, "already-reserved-or-stale-run", remaining);
    }
    if (ledger.day < day)
    {
        ledger = {day, bootstrap: false, count: 0, runIds: [], highWaterRunId: ledger.highWaterRunId};
        state = {...state, admission: ledger};
    }
    if (ledger.bootstrap) return blocked(state, "bootstrap");
    if (ledger.count >= maxRunsPerDay) return blocked(state, "daily-limit");

    ledger = {
        ...ledger,
        count: ledger.count + 1,
        runIds: [...ledger.runIds, runId],
        highWaterRunId: runId
    };
    return {
        allowed: true,
        reason: "reserved",
        remaining: maxRunsPerDay - ledger.count,
        state: {...state, admission: ledger}
    };
}
