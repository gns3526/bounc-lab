// Keep these constants and collision rules in sync with public/index.html.
// A replay contains only digital direction changes; the server owns all physics state.
export const REPLAY_ENGINE_VERSION = 'bounce-physics-v1';
export const REPLAY_HZ = 120;
export const MAX_REPLAY_TICKS = REPLAY_HZ * 60 * 5;
export const MAX_REPLAY_EVENTS = 4096;

const TILE = 32;
const WORLD_WIDTH = 640;
const WORLD_HEIGHT = 480;
const STEP = 1 / REPLAY_HZ;
const NORMAL_BOUNCE_SPEED = 325;
const SPRING_BOUNCE_SPEED = 550;
const COLLIDER_X = 5.6;
const COLLIDER_Y = 6.6;
const EXIT_CORNER_TOLERANCE = 8;
const WALL_KICK_UP_SPEED = 410;
const WALL_KICK_AWAY_SPEED = 160;
const WALL_KICK_LOCK_TIME = 0.14;
const WALL_KICK_COOLDOWN = 0.10;
const WALL_KICK_COYOTE_TIME = 0.15;

export function ellipseIntersectsRect(cx, cy, ellipseRadiusX, ellipseRadiusY, rectX, rectY, rectWidth, rectHeight) {
  const left = (rectX - cx) / ellipseRadiusX;
  const right = (rectX + rectWidth - cx) / ellipseRadiusX;
  const top = (rectY - cy) / ellipseRadiusY;
  const bottom = (rectY + rectHeight - cy) / ellipseRadiusY;
  const closestX = 0 < left ? left : (0 > right ? right : 0);
  const closestY = 0 < top ? top : (0 > bottom ? bottom : 0);
  return (closestX * closestX) + (closestY * closestY) < 1;
}

export function spawnHasClearance(map) {
  const { c, r } = map.spawn;
  const x = (c + 0.5) * TILE;
  const y = (r + 0.5) * TILE;
  const minColumn = Math.floor((x - COLLIDER_X) / TILE);
  const maxColumn = Math.floor((x + COLLIDER_X) / TILE);
  const minRow = Math.floor((y - COLLIDER_Y) / TILE);
  const maxRow = Math.floor((y + COLLIDER_Y) / TILE);
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      if (row < 0 || column < 0 || row >= 15 || column >= 20 || map.grid[row][column] === 0) continue;
      if (ellipseIntersectsRect(x, y, COLLIDER_X, COLLIDER_Y, column * TILE, row * TILE, TILE, TILE)) return false;
    }
  }
  return true;
}

function invalid(code, message, details) {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) };
}

function validateReplayShape(replay) {
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) {
    return invalid('REPLAY_REQUIRED', '클리어 입력 리플레이가 필요합니다.');
  }
  if (replay.version !== 1 || replay.engineVersion !== REPLAY_ENGINE_VERSION) {
    return invalid('REPLAY_ENGINE_MISMATCH', '게임 물리 버전이 달라 맵을 다시 검증해야 합니다.');
  }
  if (!Number.isInteger(replay.totalTicks) || replay.totalTicks < 1 || replay.totalTicks > MAX_REPLAY_TICKS) {
    return invalid('INVALID_REPLAY_LENGTH', `리플레이 길이는 1~${MAX_REPLAY_TICKS}틱이어야 합니다.`);
  }
  if (!Array.isArray(replay.events) || replay.events.length < 1 || replay.events.length > MAX_REPLAY_EVENTS) {
    return invalid('INVALID_REPLAY_EVENTS', `입력 이벤트는 1~${MAX_REPLAY_EVENTS}개여야 합니다.`);
  }
  let previousTick = -1;
  let previousDirection = null;
  const events = [];
  for (let index = 0; index < replay.events.length; index += 1) {
    const event = replay.events[index];
    if (!Array.isArray(event) || event.length !== 2) {
      return invalid('INVALID_REPLAY_EVENT', '각 입력 이벤트는 [tick, direction] 형식이어야 합니다.', { index });
    }
    const [tick, direction] = event;
    if (!Number.isInteger(tick) || tick < 0 || tick >= replay.totalTicks || tick < previousTick
      || !Number.isInteger(direction) || direction < -1 || direction > 1) {
      return invalid('INVALID_REPLAY_EVENT', '입력 이벤트의 tick 또는 direction이 올바르지 않습니다.', { index });
    }
    if (direction === previousDirection) {
      return invalid('REDUNDANT_REPLAY_EVENT', '같은 방향의 중복 입력 이벤트는 허용되지 않습니다.', { index });
    }
    events.push({ tick, direction });
    previousTick = tick;
    previousDirection = direction;
  }
  if (events[0].tick !== 0) {
    return invalid('REPLAY_INITIAL_INPUT_REQUIRED', '리플레이는 0틱의 초기 방향으로 시작해야 합니다.');
  }
  return { ok: true, totalTicks: replay.totalTicks, events };
}

function approach(value, target, maximumDelta) {
  if (value < target) return Math.min(target, value + maximumDelta);
  if (value > target) return Math.max(target, value - maximumDelta);
  return target;
}

function createSimulation(map) {
  const grid = map.grid.map((row) => row.slice());
  const player = {
    x: (map.spawn.c + 0.5) * TILE,
    y: (map.spawn.r + 0.5) * TILE,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    rx: COLLIDER_X,
    ry: COLLIDER_Y,
    lastWallTimeMs: -Infinity,
    lastWallSide: 0,
    lastWallTile: 0,
  };
  return {
    grid,
    player,
    breakTimers: new Map(),
    direction: 0,
    lastDigitalDirection: 0,
    directionalPressSerial: 0,
    arrowDriveActive: false,
    arrowDirection: 0,
    arrowStartPressSerial: 0,
    suppressVerticalArrowThisStep: false,
    arrowRearmBlockKey: '',
    arrowRearmTimer: 0,
    arrowSourceKey: '',
    wallKickLockTimer: 0,
    wallKickCooldown: 0,
    wallKickPressSerial: 0,
    simulationTime: 0,
    bounds: 0,
    cleared: false,
    dead: false,
    deathReason: '',
  };
}

function tileAt(simulation, row, column) {
  return row >= 0 && column >= 0 && row < 15 && column < 20 ? simulation.grid[row][column] : 0;
}

function isSolid(tile) {
  return tile >= 1 && tile <= 6;
}

function exitSegments(simulation) {
  const segments = [];
  let start = -1;
  for (let row = 0; row <= 15; row += 1) {
    const open = row < 15 && simulation.grid[row]?.[19] === 0;
    if (open && start < 0) start = row;
    if (!open && start >= 0) {
      segments.push({ start, end: row - 1, top: start * TILE, bottom: row * TILE });
      start = -1;
    }
  }
  return segments;
}

function exitSegmentNearY(simulation, y, tolerance = 0) {
  return exitSegments(simulation).find((segment) => y >= segment.top - tolerance && y <= segment.bottom + tolerance) ?? null;
}

function isClimbableWallTile(tile) {
  return tile === 1 || tile === 2 || tile === 3;
}

function stopArrowDrive(simulation) {
  simulation.arrowDriveActive = false;
  simulation.arrowDirection = 0;
}

function performWallKick(simulation, side) {
  if (!side || simulation.wallKickCooldown > 0) return false;
  if (simulation.arrowDriveActive) stopArrowDrive(simulation);
  simulation.wallKickCooldown = WALL_KICK_COOLDOWN;
  simulation.wallKickLockTimer = WALL_KICK_LOCK_TIME;
  simulation.wallKickPressSerial = simulation.directionalPressSerial;
  simulation.player.vx = -side * WALL_KICK_AWAY_SPEED;
  simulation.player.vy = -WALL_KICK_UP_SPEED;
  return true;
}

function updateWallKick(simulation) {
  simulation.wallKickLockTimer = Math.max(0, simulation.wallKickLockTimer - STEP);
  simulation.wallKickCooldown = Math.max(0, simulation.wallKickCooldown - STEP);
  const player = simulation.player;
  const direction = simulation.direction;
  if (direction && player.lastWallSide && direction === -player.lastWallSide
    && simulation.directionalPressSerial > simulation.wallKickPressSerial
    && (simulation.simulationTime * 1000) - player.lastWallTimeMs <= WALL_KICK_COYOTE_TIME * 1000
    && isClimbableWallTile(player.lastWallTile)) {
    performWallKick(simulation, player.lastWallSide);
  }
  return simulation.wallKickLockTimer > 0;
}

function queueFragileBreak(simulation, row, column) {
  if (simulation.grid[row]?.[column] !== 3) return;
  const key = `${row},${column}`;
  if (!simulation.breakTimers.has(key)) simulation.breakTimers.set(key, 0.18);
}

function arrowDirectionForTile(tile) {
  return tile === 4 ? 1 : (tile === 5 ? -1 : 0);
}

function arrowTileKey(row, column) {
  return row >= 0 && column >= 0 ? `${row},${column}` : '';
}

function blockArrowTile(simulation, row, column, duration = 0.16) {
  const key = arrowTileKey(row, column);
  if (!key) return;
  simulation.arrowRearmBlockKey = key;
  simulation.arrowRearmTimer = Math.max(simulation.arrowRearmTimer, duration);
}

function applyArrowImpulse(simulation, tile, strength = 1, contactSide = 0, row = -1, column = -1) {
  const nextDirection = arrowDirectionForTile(tile);
  if (!nextDirection) return false;
  const key = arrowTileKey(row, column);
  if (key && simulation.arrowRearmTimer > 0 && key === simulation.arrowRearmBlockKey) return false;
  if (contactSide && nextDirection !== -contactSide) {
    blockArrowTile(simulation, row, column, 0.2);
    return false;
  }
  if (!contactSide && simulation.suppressVerticalArrowThisStep) {
    blockArrowTile(simulation, row, column, 0.14);
    return false;
  }
  simulation.wallKickLockTimer = 0;
  simulation.wallKickCooldown = 0;
  const fresh = !simulation.arrowDriveActive || simulation.arrowDirection !== nextDirection;
  simulation.arrowDirection = nextDirection;
  simulation.arrowSourceKey = key;
  if (fresh) {
    simulation.arrowDriveActive = true;
    simulation.arrowStartPressSerial = simulation.directionalPressSerial;
  }
  simulation.player.vx = simulation.arrowDirection * 690 * strength;
  simulation.player.vy = 0;
  return true;
}

function onLand(simulation, tile, row, column) {
  simulation.bounds += 1;
  simulation.player.vy = tile === 2 ? -SPRING_BOUNCE_SPEED : -NORMAL_BOUNCE_SPEED;
  if (tile === 3) queueFragileBreak(simulation, row, column);
  applyArrowImpulse(simulation, tile, 1, 0, row, column);
}

function resolveHorizontal(simulation) {
  const player = simulation.player;
  const oldX = player.x;
  player.px = oldX;
  player.x += player.vx * STEP;
  const minColumn = Math.floor((player.x - player.rx) / TILE) - 1;
  const maxColumn = Math.floor((player.x + player.rx) / TILE) + 1;
  const minRow = Math.floor((player.y - player.ry) / TILE);
  const maxRow = Math.floor((player.y + player.ry) / TILE);
  let hitSide = 0;
  let hitTile = 0;
  let hitRow = -1;
  let hitColumn = -1;
  const exitPass = player.vx > 0 ? exitSegmentNearY(simulation, player.y, EXIT_CORNER_TOLERANCE) : null;
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const tile = tileAt(simulation, row, column);
      if (!isSolid(tile) || tile === 6) continue;
      if (column === 19 && exitPass && (row < exitPass.start || row > exitPass.end)) continue;
      const tileX = column * TILE;
      const tileY = row * TILE;
      if (!ellipseIntersectsRect(player.x, player.y, player.rx, player.ry, tileX, tileY, TILE, TILE)) continue;
      if (player.vx > 0 && oldX + player.rx <= tileX + 2.2) {
        player.x = tileX - player.rx - 0.01;
        hitSide = 1;
      } else if (player.vx < 0 && oldX - player.rx >= tileX + TILE - 2.2) {
        player.x = tileX + TILE + player.rx + 0.01;
        hitSide = -1;
      } else {
        const leftPenetration = (player.x + player.rx) - tileX;
        const rightPenetration = (tileX + TILE) - (player.x - player.rx);
        if (leftPenetration < rightPenetration) {
          player.x = tileX - player.rx - 0.01;
          hitSide = 1;
        } else {
          player.x = tileX + TILE + player.rx + 0.01;
          hitSide = -1;
        }
      }
      hitTile = tile;
      hitRow = row;
      hitColumn = column;
    }
  }
  if (!hitSide) return;
  simulation.suppressVerticalArrowThisStep = true;
  if (simulation.arrowDriveActive && hitSide === simulation.arrowDirection) {
    if (simulation.arrowSourceKey) {
      simulation.arrowRearmBlockKey = simulation.arrowSourceKey;
      simulation.arrowRearmTimer = Math.max(simulation.arrowRearmTimer, 0.22);
    }
    stopArrowDrive(simulation);
  }
  const incoming = Math.abs(player.vx);
  const awayInput = (hitSide === 1 && simulation.direction < 0) || (hitSide === -1 && simulation.direction > 0);
  player.lastWallTimeMs = simulation.simulationTime * 1000;
  player.lastWallSide = hitSide;
  player.lastWallTile = hitTile;
  const kicked = awayInput && isClimbableWallTile(hitTile) && performWallKick(simulation, hitSide);
  if (!kicked) {
    player.vx = hitSide === 1 ? -Math.max(95, incoming * 0.75) : Math.max(95, incoming * 0.75);
    if (awayInput) player.vx = hitSide === 1
      ? -Math.max(Math.abs(player.vx), 225)
      : Math.max(Math.abs(player.vx), 225);
  }
  if (hitTile === 3) {
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        if (tileAt(simulation, row, column) === 3
          && ellipseIntersectsRect(player.x, player.y, player.rx + 1.5, player.ry + 1.5, column * TILE, row * TILE, TILE, TILE)) {
          queueFragileBreak(simulation, row, column);
        }
      }
    }
  }
  if (!kicked) applyArrowImpulse(simulation, hitTile, 0.94, hitSide, hitRow, hitColumn);
}

function resolveVertical(simulation) {
  const player = simulation.player;
  const oldY = player.y;
  player.py = oldY;
  player.y += player.vy * STEP;
  const minColumn = Math.floor((player.x - player.rx) / TILE);
  const maxColumn = Math.floor((player.x + player.rx) / TILE);
  const minRow = Math.floor((player.y - player.ry) / TILE) - 1;
  const maxRow = Math.floor((player.y + player.ry) / TILE) + 1;
  let best = null;
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const tile = tileAt(simulation, row, column);
      if (!isSolid(tile) || tile === 6) continue;
      const tileX = column * TILE;
      const tileY = row * TILE;
      if (!ellipseIntersectsRect(player.x, player.y, player.rx, player.ry, tileX, tileY, TILE, TILE)) continue;
      if (player.vy > 0 && oldY + player.ry <= tileY + 3) {
        if (!best || tileY < best.tileY) best = { kind: 'floor', tileY, tile, row, column };
      } else if (player.vy < 0 && oldY - player.ry >= tileY + TILE - 3) {
        if (!best || tileY + TILE > best.tileY) best = { kind: 'ceiling', tileY: tileY + TILE, tile, row, column };
      } else {
        const topPenetration = (player.y + player.ry) - tileY;
        const bottomPenetration = (tileY + TILE) - (player.y - player.ry);
        if (topPenetration < bottomPenetration) {
          if (!best || tileY < best.tileY) best = { kind: 'floor', tileY, tile, row, column };
        } else if (!best) {
          best = { kind: 'ceiling', tileY: tileY + TILE, tile, row, column };
        }
      }
    }
  }
  if (!best) return;
  if (best.kind === 'floor') {
    player.y = best.tileY - player.ry - 0.01;
    onLand(simulation, best.tile, best.row, best.column);
  } else {
    player.y = best.tileY + player.ry + 0.01;
    const ceilingImpact = Math.abs(player.vy);
    if (best.tile === 3) queueFragileBreak(simulation, best.row, best.column);
    applyArrowImpulse(simulation, best.tile, 0.9, 0, best.row, best.column);
    player.vy = Math.max(105, ceilingImpact * 0.66);
  }
}

function checkBombs(simulation) {
  const player = simulation.player;
  const hitX = player.rx * 0.88;
  const hitY = player.ry * 0.88;
  const minColumn = Math.floor((player.x - hitX) / TILE);
  const maxColumn = Math.floor((player.x + hitX) / TILE);
  const minRow = Math.floor((player.y - hitY) / TILE);
  const maxRow = Math.floor((player.y + hitY) / TILE);
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      if (tileAt(simulation, row, column) === 6
        && ellipseIntersectsRect(player.x, player.y, hitX, hitY, column * TILE + 3, row * TILE + 3, TILE - 6, TILE - 6)) {
        simulation.dead = true;
        simulation.deathReason = 'bomb';
        return true;
      }
    }
  }
  return false;
}

function processFragileTimers(simulation) {
  for (const [key, time] of [...simulation.breakTimers]) {
    const nextTime = time - STEP;
    simulation.breakTimers.set(key, nextTime);
    if (nextTime <= 0) {
      const [row, column] = key.split(',').map(Number);
      if (simulation.grid[row][column] === 3) simulation.grid[row][column] = 0;
      simulation.breakTimers.delete(key);
    }
  }
}

function applyDirectionEvent(simulation, direction) {
  if (direction !== 0 && direction !== simulation.lastDigitalDirection) simulation.directionalPressSerial += 1;
  simulation.lastDigitalDirection = direction;
  simulation.direction = direction;
}

function simulateStep(simulation) {
  simulation.simulationTime += STEP;
  simulation.suppressVerticalArrowThisStep = false;
  simulation.arrowRearmTimer = Math.max(0, simulation.arrowRearmTimer - STEP);
  if (simulation.arrowRearmTimer <= 0) simulation.arrowRearmBlockKey = '';

  if (simulation.arrowDriveActive && simulation.directionalPressSerial > simulation.arrowStartPressSerial) {
    stopArrowDrive(simulation);
    if (simulation.direction) simulation.player.vx = simulation.direction * 225;
  }
  const wallKickLocked = updateWallKick(simulation);
  const arrowGliding = simulation.arrowDriveActive && !wallKickLocked;
  if (wallKickLocked) {
    // Preserve wall-kick velocity during its lock window.
  } else if (simulation.arrowDriveActive) {
    simulation.player.vx = simulation.arrowDirection * 690;
  } else {
    const targetVelocityX = simulation.direction * 225;
    const response = simulation.direction ? 1700 : 760;
    simulation.player.vx = approach(simulation.player.vx, targetVelocityX, response * STEP);
  }

  if (arrowGliding) simulation.player.vy = 0;
  else simulation.player.vy += 1120 * STEP;
  simulation.player.vy = Math.min(820, simulation.player.vy);

  resolveHorizontal(simulation);
  resolveVertical(simulation);
  if (checkBombs(simulation)) return;

  const atExitY = !!exitSegmentNearY(simulation, simulation.player.y, EXIT_CORNER_TOLERANCE);
  if (simulation.player.vx > 0 && simulation.player.x + simulation.player.rx >= WORLD_WIDTH - 2 && atExitY) {
    simulation.cleared = true;
    return;
  }
  if (simulation.player.x > WORLD_WIDTH + simulation.player.rx * 0.25) {
    if (atExitY) {
      simulation.cleared = true;
      return;
    }
    simulation.player.x = WORLD_WIDTH - simulation.player.rx;
    simulation.player.vx = -Math.max(110, Math.abs(simulation.player.vx) * 0.7);
  }
  if (simulation.player.x < simulation.player.rx) {
    const edgeImpact = Math.abs(simulation.player.vx);
    simulation.player.x = simulation.player.rx;
    simulation.player.vx = Math.max(110, edgeImpact * 0.78);
  }
  if (simulation.player.y < simulation.player.ry) {
    const topImpact = Math.abs(simulation.player.vy);
    simulation.player.y = simulation.player.ry;
    simulation.player.vy = Math.max(105, topImpact * 0.68);
  }
  if (simulation.player.y > WORLD_HEIGHT + 50) {
    simulation.dead = true;
    simulation.deathReason = 'fall';
    return;
  }
  processFragileTimers(simulation);
}

export function verifyCompletionReplay(map, replay) {
  const validated = validateReplayShape(replay);
  if (!validated.ok) return validated;
  const simulation = createSimulation(map);
  let eventIndex = 0;
  for (let tick = 0; tick < validated.totalTicks; tick += 1) {
    while (eventIndex < validated.events.length && validated.events[eventIndex].tick === tick) {
      applyDirectionEvent(simulation, validated.events[eventIndex].direction);
      eventIndex += 1;
    }
    simulateStep(simulation);
    if (simulation.dead) {
      return invalid('REPLAY_PLAYER_DIED', '리플레이 도중 캐릭터가 사망했습니다.', {
        tick,
        reason: simulation.deathReason,
      });
    }
    if (simulation.cleared) {
      if (tick !== validated.totalTicks - 1) {
        return invalid('REPLAY_AFTER_CLEAR', '클리어 이후의 추가 리플레이 틱은 허용되지 않습니다.', { clearTick: tick });
      }
      return {
        ok: true,
        engineVersion: REPLAY_ENGINE_VERSION,
        totalTicks: validated.totalTicks,
        clearTick: tick,
        time: validated.totalTicks / REPLAY_HZ,
        bounds: simulation.bounds,
      };
    }
  }
  return invalid('REPLAY_DID_NOT_CLEAR', '입력 리플레이가 출구에 도달하지 못했습니다.');
}
