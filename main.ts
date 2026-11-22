// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// The generator's levels are a one-square hallway with independent rooms off it: a box
// pushed out of a room into the hallway can never come back, so every box stays in its
// room and a level's push optimum is the sum of its rooms' optima. This solver cuts the
// hallway out of the floor — its squares are dead for boxes, since no push from them can
// reach a goal — solves each room on its own with a breadth-first search over pushes, and
// stitches the rooms' move strings together, the player walking on from room to room.
//
// The push search's state is the room's boxes plus the player's reachable region, named
// by its lowest square; expanding in order of pushes made makes the first solution found
// push-optimal. It prunes any push that lands a box on a dead square (one from which no
// push, ignoring the other boxes, can bring it to a goal — pulled back from the goals
// before the search) and any that freezes a box in a solid 2 x 2 block of walls and
// boxes with a box off its goal. If a level does not decompose into rooms, the same
// search runs on the whole level instead. All budgets are counted in states, never by
// the clock, and every tie breaks by square order, so two runs answer byte for byte alike.
//
// Local run: MAKEFUN_INPUT_DIR=<dir> MAKEFUN_OUTPUT_DIR=<dir> node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The most states one push search keeps before it gives up: work, never the clock. The
// generator keeps only rooms its own search solves within 250,000 states, so this cap
// leaves wide headroom while bounding memory.
const STATE_CAP = 600_000;

// Directions in a fixed order: up, down, left, right. A step is written with the lower
// letter, a push with the capital (the checker ignores case; the replay decides).
const WALK_CH = ['u', 'd', 'l', 'r'];
const PUSH_CH = ['U', 'D', 'L', 'R'];

interface Board {
  w: number;
  size: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: walls, goals, boxes and the player, short rows padded as walls, the frame all wall. */
function parseBoard(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + w - 1] = 1;
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, size: w * h, wall, goals, boxes, player };
}

/** The squares a lone box can be pushed from onto some goal, pulled back from the goals over open floor. */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
      const y = x - d;
      const stand = y - d;
      if (y < 0 || stand < 0 || y >= wall.length || stand >= wall.length) continue;
      if (!wall[y] && !wall[stand] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 x 2 block: four squares of walls
 * and boxes with a box among them off its goal. No box of such a block can ever move
 * again — each push of one needs a standing or landing square inside the block, and all
 * are solid — so a state holding one is dead unless every box in it is home.
 */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goalSet: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    let solid = true;
    let stranded = false;
    for (const c of [a, a + 1, a + w, a + w + 1]) {
      if (!wall[c] && !occupied[c]) {
        solid = false;
        break;
      }
      if (occupied[c] && !goalSet[c]) stranded = true;
    }
    if (solid && stranded) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and the boxes in `occupied`, in lower LURD letters. */
function walkPath(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
      const q = p + d;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: the square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = WALK_CH[how[p]!] + s;
  return s;
}

/** The square the player stands on after playing `moves` from `from` on a board `w` wide. */
function endSquare(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of one (sub-)level: breadth-first over pushes, at most `cap`
 * states kept. Returns { pushes, moves } or null when the search gives up or the position
 * cannot be solved. Other boxes of the level, if any, are already walls in `wall`.
 */
function solvePushes(
  w: number,
  wall: Uint8Array,
  goals: number[],
  startBoxes: number[],
  startPlayer: number,
  cap: number,
): { pushes: number; moves: string } | null {
  const size = wall.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, wall, goals);
  const nb = startBoxes.length;
  if (startBoxes.some((b) => !live[b])) return null;
  const isSolved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b] === 1);
  if (isSolved(startBoxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const stack = new Int32Array(size);
  // Two stamp-marked reachability maps: A for the region of the state being expanded (the
  // pushes' standing squares are read from it), B for a child's region (its key's name).
  const seenA = new Int32Array(size);
  const seenB = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;
  const fill = (seen: Int32Array, stamp: number, from: number): number => {
    let n = 0;
    let low = from;
    stack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      let q = p - w;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
      q = p + w;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
      q = p - 1;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
      q = p + 1;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
    return low;
  };

  // A state's key: its region's lowest square, then its boxes in order — packed into one
  // number while the box count is small (always, for a room), a string of char codes for
  // a whole level's many boxes.
  const packed = nb <= 6;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!packed) return String.fromCharCode(low, ...boxes);
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const sBoxes: number[][] = [startBoxes.slice()];
  const sPlayer: number[] = [startPlayer];
  const sParent: number[] = [-1];
  const visited = new Map<number | string, number>();
  for (const b of startBoxes) occupied[b] = 1;
  visited.set(keyOf(startBoxes, fill(seenB, ++stampB, startPlayer)), 0);
  for (const b of startBoxes) occupied[b] = 0;

  let found = -1;
  for (let head = 0; head < sBoxes.length && found < 0; head++) {
    const boxes = sBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    const myStamp = ++stampA;
    fill(seenA, myStamp, sPlayer[head]!);
    for (let bi = 0; bi < nb && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
        if (seenA[b - d] !== myStamp) continue;
        const t = b + d;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(w, wall, occupied, goalSet, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const child = boxes.slice();
        child[bi] = t;
        child.sort((x, y) => x - y);
        const key = keyOf(child, fill(seenB, ++stampB, b));
        occupied[t] = 0;
        occupied[b] = 1;
        if (visited.has(key)) continue;
        if (sBoxes.length >= cap) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        visited.set(key, sBoxes.length);
        sBoxes.push(child);
        sPlayer.push(b);
        sParent.push(head);
        if (isSolved(child)) found = sBoxes.length - 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The chain of states back to the root, then the moves forward: walk to each push's
  // standing square, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  const occ = new Uint8Array(size);
  for (const s of chain) {
    const next = sBoxes[s]!;
    const from = boxes.find((b) => !next.includes(b))!;
    const to = next.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const k = d === -w ? 0 : d === w ? 1 : d === -1 ? 2 : 3;
    for (const b of boxes) occ[b] = 1;
    moves += walkPath(w, wall, occ, player, from - d);
    for (const b of boxes) occ[b] = 0;
    moves += PUSH_CH[k];
    player = from;
    boxes = next;
  }
  return { pushes: chain.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway) out of the
 * floor; each part left holding boxes is a room, with its boxes and goals. Null when the
 * level is no set of rooms: a box starts in the hallway, a goal is cut off, or some part
 * holds boxes and goals in different numbers.
 */
function roomsOf(board: Board): { boxes: number[]; goals: number[] }[] | null {
  const { w, size, wall, goals, boxes, player } = board;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(size).fill(-1);
  const comps: { boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const comp: { boxes: number[]; goals: number[] } = { boxes: [], goals: [] };
    const id = comps.length;
    const stack = [s];
    part[s] = id;
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (let k = 0; k < 4; k++) {
        const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
        const q = p + d;
        if (q < 0 || q >= size || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = id;
        stack.push(q);
      }
    }
    comps.push(comp);
  }
  for (const b of boxes) comps[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    comps[part[g]!]!.goals.push(g);
  }
  if (comps.some((c) => c.boxes.length !== c.goals.length)) return null;
  return comps.filter((c) => c.boxes.length > 0);
}

/** One level's moves: room by room when it decomposes, the whole level's search otherwise. */
function solveLevel(board: Board): string {
  if (board.boxes.length === 0) return '';
  const rooms = roomsOf(board);
  if (rooms !== null) {
    let player = board.player;
    let moves = '';
    const done = rooms.map(() => false);
    let all = true;
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const wall = board.wall.slice();
      rooms.forEach((other, oi) => {
        if (oi === ri) return;
        for (const c of done[oi] ? other.goals : other.boxes) wall[c] = 1;
      });
      const sub = solvePushes(board.w, wall, room.goals, room.boxes, player, STATE_CAP);
      if (sub === null) {
        all = false;
        break;
      }
      moves += sub.moves;
      player = endSquare(board.w, player, sub.moves);
      done[ri] = true;
    }
    if (all) return moves;
  }
  const whole = solvePushes(board.w, board.wall, board.goals, board.boxes, board.player, STATE_CAP);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(parseBoard(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
