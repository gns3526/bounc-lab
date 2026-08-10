import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_REPLAY_TICKS,
  REPLAY_ENGINE_VERSION,
  spawnHasClearance,
  verifyCompletionReplay,
} from '../physics-proof.mjs';

function replayMap() {
  const grid = Array.from({ length: 15 }, () => Array(20).fill(0));
  grid[14].fill(1);
  for (let row = 0; row < 14; row += 1) grid[row][19] = 1;
  grid[12][19] = 0;
  grid[10][6] = 2;
  grid[9][10] = 3;
  grid[8][13] = 4;
  grid[7][14] = 5;
  grid[13][17] = 6;
  return { version: 1, grid, spawn: { c: 1, r: 12 }, exitRow: 12 };
}

function replay(totalTicks, events = [[0, 1]]) {
  return { version: 1, engineVersion: REPLAY_ENGINE_VERSION, totalTicks, events };
}

test('deterministic verifier accepts the exact successful input replay', () => {
  const result = verifyCompletionReplay(replayMap(), replay(344));
  assert.equal(result.ok, true);
  assert.equal(result.clearTick, 343);
  assert.equal(result.bounds, 5);
  assert.equal(result.engineVersion, REPLAY_ENGINE_VERSION);
});

test('deterministic verifier rejects incomplete, post-clear, and malformed replays', () => {
  const map = replayMap();
  assert.equal(MAX_REPLAY_TICKS, 7_200);
  assert.equal(verifyCompletionReplay(map, replay(343)).code, 'REPLAY_DID_NOT_CLEAR');
  assert.equal(verifyCompletionReplay(map, replay(345)).code, 'REPLAY_AFTER_CLEAR');
  assert.equal(verifyCompletionReplay(map, replay(500, [[0, 0]])).code, 'REPLAY_DID_NOT_CLEAR');
  assert.equal(verifyCompletionReplay(map, {
    version: 1,
    engineVersion: 'unknown-engine',
    totalTicks: 1,
    events: [[0, 1]],
  }).code, 'REPLAY_ENGINE_MISMATCH');
  assert.equal(verifyCompletionReplay(map, replay(10, [[1, 1]])).code, 'REPLAY_INITIAL_INPUT_REQUIRED');
  assert.equal(verifyCompletionReplay(map, replay(10, [[0, 1], [2, 1]])).code, 'REDUNDANT_REPLAY_EVENT');
  assert.equal(verifyCompletionReplay(map, replay(MAX_REPLAY_TICKS + 1)).code, 'INVALID_REPLAY_LENGTH');
});

test('spawn clearance uses the same ellipse collision rule as the game', () => {
  const map = replayMap();
  assert.equal(spawnHasClearance(map), true);
  map.grid[map.spawn.r][map.spawn.c] = 1;
  assert.equal(spawnHasClearance(map), false);
});
