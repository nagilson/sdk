// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_MAX_RUNS_PER_DAY,
    initializeAdmission,
    reserveAdmission
} from "../admission.mjs";

const bootstrapTime = "2026-09-07T12:00:00.000Z";
const today = "2026-09-08T12:00:00.000Z";
const tomorrow = "2026-09-09T00:00:00.000Z";

function initialState()
{
    return {schemaVersion: 1, pipelines: {main: {processedBuildKeys: ["build-1"]}}};
}

function bootstrappedState()
{
    return initializeAdmission(initialState(), {now: bootstrapTime}).state;
}

function reserve(state, runId = "100", now = today, options = {})
{
    return reserveAdmission(state, {runId, now, ...options});
}

test("conservative default caps daily AI dossiers at ten", () =>
{
    assert.equal(DEFAULT_MAX_RUNS_PER_DAY, 10);
    let state = bootstrappedState();
    for (let index = 0; index < 10; index++)
    {
        const result = reserve(state, String(100 + index));
        assert.equal(result.allowed, true);
        assert.equal(result.reason, "reserved");
        assert.equal(result.remaining, 9 - index);
        state = result.state;
    }
    const denied = reserve(state, "110");
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, "daily-limit");
    assert.equal(denied.remaining, 0);
    assert.equal(denied.state, state);
    assert.equal(state.admission.count, 10);
});

test("new admission reserves the first investigation immediately on its initialization day", () =>
{
    const original = initialState();
    assert.equal(reserve(original).reason, "missing-ledger");
    assert.equal(Object.hasOwn(original, "admission"), false);

    const initialized = initializeAdmission(original, {now: today});
    assert.equal(initialized.allowed, false);
    assert.equal(initialized.reason, "initialized");
    assert.equal(initialized.remaining, 0);
    assert.equal(initialized.state.admission.count, 0);
    assert.equal(initialized.state.pipelines, original.pipelines);
    assert.equal(Object.hasOwn(original, "admission"), false);
    const first = reserve(initialized.state);
    assert.equal(first.allowed, true);
    assert.equal(first.state.admission.count, 1);
    assert.deepEqual(first.state.admission.runIds, ["100"]);
    const second = reserve(first.state, "101", "2026-09-08T23:59:59.999Z");
    assert.equal(second.allowed, true);
    assert.equal(second.state.admission.count, 2);
    assert.equal(reserve(second.state, "102", tomorrow).state.admission.count, 1);
});

test("legacy zero-spend bootstrap ledgers no longer wait for midnight", () =>
{
    const state = initializeAdmission(initialState(), {now: today}).state;
    state.admission.bootstrap = true;
    const admitted = reserve(state);
    assert.equal(admitted.allowed, true);
    assert.equal(admitted.state.admission.bootstrap, false);
    assert.equal(admitted.state.admission.count, 1);
    assert.equal(state.admission.bootstrap, true);
    assert.equal(reserve(admitted.state).allowed, false);
});

test("restored schema-1 state without admission is migrated once rather than blocked forever", () =>
{
    const migrated = initializeAdmission(initialState(), {now: bootstrapTime});
    const persisted = JSON.parse(JSON.stringify(migrated.state));
    const secondInitialization = initializeAdmission(persisted, {now: today});
    assert.equal(secondInitialization.reason, "already-initialized");
    assert.equal(secondInitialization.state, persisted);
    assert.equal(reserve(secondInitialization.state).allowed, true);
});

test("reservation is pure, deterministic, JSON-serializable, and preserves other state", () =>
{
    const state = bootstrappedState();
    Object.freeze(state.admission.runIds);
    Object.freeze(state.admission);
    Object.freeze(state.pipelines);
    Object.freeze(state);
    const first = reserve(state);
    const second = reserve(state);
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
    assert.equal(state.admission.count, 0);
    assert.equal(first.state.pipelines, state.pipelines);
    assert.deepEqual(first.state.admission.runIds, ["100"]);
    assert.equal(first.state.admission.highWaterRunId, "100");
});

test("a successful reservation cannot run AI again and does not spend another admission", () =>
{
    const first = reserve(bootstrappedState());
    const repeated = reserve(first.state);
    assert.equal(repeated.allowed, false);
    assert.equal(repeated.reason, "already-reserved-or-stale-run");
    assert.equal(repeated.remaining, first.remaining);
    assert.equal(repeated.state, first.state);
    assert.equal(repeated.state.admission.count, 1);
    assert.equal(reserve(first.state, "101").remaining, 8);
});

test("rollover resets daily count and entries but rejects cross-day replays and stale IDs", () =>
{
    const yesterday = reserve(bootstrappedState(), "900").state;
    const replay = reserve(yesterday, "900", tomorrow);
    assert.equal(replay.allowed, false);
    assert.equal(replay.state, yesterday);
    const next = reserve(yesterday, "901", tomorrow);
    assert.equal(next.allowed, true);
    assert.equal(next.remaining, 9);
    assert.equal(next.state.admission.count, 1);
    assert.deepEqual(next.state.admission.runIds, ["901"]);
    assert.equal(next.state.admission.highWaterRunId, "901");
    assert.equal(reserve(next.state, "900", tomorrow).allowed, false);
    assert.equal(reserve(next.state, "899", tomorrow).allowed, false);
});

test("run identity comparison is numeric and precise above Number.MAX_SAFE_INTEGER", () =>
{
    const small = reserve(bootstrappedState(), "9").state;
    const large = reserve(small, "10000000000000000001");
    assert.equal(large.allowed, true);
    assert.equal(reserve(large.state, "10000000000000000002").allowed, true);
    assert.equal(reserve(large.state, "10000000000000000000").allowed, false);
});

test("UTC midnight controls rollover regardless of Date representation", () =>
{
    const state = reserve(bootstrappedState(), "100", "2026-09-08T23:59:59.999Z", {maxRunsPerDay: 1}).state;
    assert.equal(reserve(state, "101", Date.parse("2026-09-08T23:59:59.999Z"), {maxRunsPerDay: 1}).reason, "daily-limit");
    const result = reserve(state, "101", new Date("2026-09-08T17:00:00-07:00"), {maxRunsPerDay: 1});
    assert.equal(result.allowed, true);
    assert.equal(result.state.admission.day, "2026-09-09");
    assert.equal(reserve(bootstrappedState(), "100", "2026-09-08T12:00:00Z").allowed, true);
});

test("a future ledger fails closed without erasing its reservations", () =>
{
    const state = reserve(bootstrappedState(), "100", tomorrow).state;
    const result = reserve(state, "101", today);
    assert.equal(result.reason, "clock-regression");
    assert.equal(result.state, state);
});

test("zero disables admissions and lowering a limit does not reset previous spend", () =>
{
    const first = reserve(bootstrappedState()).state;
    const disabled = reserve(first, "101", today, {maxRunsPerDay: 0});
    assert.equal(disabled.reason, "daily-limit");
    assert.equal(disabled.state, first);
    assert.equal(reserve(first, "101", today, {maxRunsPerDay: 1}).reason, "daily-limit");
    const rolled = reserve(first, "101", tomorrow, {maxRunsPerDay: 0});
    assert.equal(rolled.reason, "daily-limit");
    assert.equal(rolled.state.admission.count, 0);
    assert.equal(rolled.state.admission.highWaterRunId, "100");
    assert.equal(reserve(rolled.state, "100", tomorrow).allowed, false);
});

test("daily reservation storage remains bounded across many days", () =>
{
    let state = bootstrappedState();
    for (let index = 0; index < 90; index++)
    {
        const now = Date.parse(today) + index * 24 * 60 * 60 * 1000;
        const result = reserve(state, String(100 + index), now);
        assert.equal(result.allowed, true);
        assert.equal(result.state.admission.runIds.length, 1);
        state = result.state;
    }
    assert.equal(state.admission.highWaterRunId, "189");
});

test("maximum supported daily limit has bounded storage without evicting spent reservations", () =>
{
    let state = bootstrappedState();
    for (let index = 1; index <= 1000; index++)
    {
        const result = reserve(state, String(index), today, {maxRunsPerDay: 1000});
        assert.equal(result.allowed, true);
        state = result.state;
    }
    assert.equal(state.admission.count, 1000);
    assert.equal(state.admission.runIds.length, 1000);
    assert.equal(reserve(state, "1001", today, {maxRunsPerDay: 1000}).reason, "daily-limit");
    assert.equal(reserve(state, "1", tomorrow, {maxRunsPerDay: 1000}).allowed, false);
});

test("invalid limits are never coerced or replaced by defaults", () =>
{
    for (const maxRunsPerDay of [null, "10", "", false, -1, 0.5, NaN, Infinity, 1001, Number.MAX_SAFE_INTEGER + 1])
    {
        const state = bootstrappedState();
        const result = reserve(state, "100", today, {maxRunsPerDay});
        assert.equal(result.allowed, false);
        assert.equal(result.reason, "invalid-limit");
        assert.equal(result.state, state);
    }
});

test("run IDs must be canonical stable positive decimal strings, not attempt identities", () =>
{
    for (const runId of [undefined, null, 100, "", "0", "01", "-1", "1.5", "100:2", " 100", "1e3", "1".repeat(33)])
    {
        const state = bootstrappedState();
        const result = reserveAdmission(state, {runId, now: today});
        assert.equal(result.allowed, false);
        assert.equal(result.reason, "invalid-run-id");
        assert.equal(result.state, state);
    }
});

test("invalid and ambiguous times are rejected without consulting the wall clock", () =>
{
    for (const now of [undefined, null, "", "2026-09-08", "2026-09-08T12:00:00", "2026-02-30T12:00:00Z",
        "2026-09-08T24:00:00Z", new Date(NaN), NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER])
    {
        const state = bootstrappedState();
        assert.equal(reserveAdmission(state, {runId: "100", now}).reason, "invalid-time");
        assert.equal(initializeAdmission(initialState(), {now}).reason, "invalid-time");
    }
});

test("invalid state envelopes fail closed even during explicit initialization", () =>
{
    for (const state of [undefined, null, [], {}, {schemaVersion: 2, pipelines: {}},
        {schemaVersion: 1, pipelines: null}, {schemaVersion: 1, pipelines: []}])
    {
        const result = reserve(state);
        assert.equal(result.allowed, false);
        assert.equal(result.reason, "invalid-state");
        assert.equal(result.state, state);
        assert.equal(initializeAdmission(state, {now: today}).reason, "invalid-state");
    }
});

test("corrupt ledgers cannot be silently initialized or reset on a later day", () =>
{
    const valid = reserve(bootstrappedState()).state.admission;
    const corrupt = [
        undefined, null, {}, [],
        {...valid, day: "2026-02-30"},
        {...valid, day: 123},
        {...valid, bootstrap: undefined},
        {...valid, bootstrap: true},
        {...valid, count: "1"},
        {...valid, count: -1},
        {...valid, count: 1.5},
        {...valid, count: 0},
        {...valid, count: 2},
        {...valid, count: 1001, runIds: Array(1001).fill("100")},
        {...valid, runIds: null},
        {...valid, runIds: [100]},
        {...valid, count: 2, runIds: ["100", "100"]},
        {...valid, count: 2, runIds: ["101", "100"]},
        {...valid, highWaterRunId: undefined},
        {...valid, highWaterRunId: "99"},
        {...valid, highWaterRunId: "101"}
    ];
    for (const admission of corrupt)
    {
        const state = {...initialState(), admission};
        const result = reserve(state, "102", tomorrow);
        assert.equal(result.allowed, false);
        assert.equal(result.reason, "invalid-ledger");
        assert.equal(result.state, state);
        assert.equal(initializeAdmission(state, {now: tomorrow}).reason, "invalid-ledger");
    }
});
