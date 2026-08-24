import { generateUnicornTraits, drawUnicorn, type UnicornTraits } from './render/unicorn';
import { generateMonsterTraits, archetypePreview, Archetype, type MonsterTraits } from './game/monster';
import { loadLifetimeStats, recordRun, type LifetimeStats } from './game/stats';
import { loadHeld, loadCashedIns, grantDust, dustBonusTotals, ITEM_NAMES } from './game/dust';
import { loadEncountered, markEncountered, variantKey } from './game/bestiary';
import { drawMonster } from './render/monster';
import { drawTreasureChest, drawTrapFloor } from './render/event';
import {
  drawHpBar,
  drawMenu,
  drawLog,
  drawFloorBadge,
  drawTitleCard,
  drawRunSummary,
  drawMutationReveal,
  drawTransformPanel,
  wrapText,
  drawStatsPanel,
  drawLevelBadge,
  drawMuteToggle,
  muteToggleWidth,
  drawPillButton,
  drawPanelBg,
} from './render/ui';
import { GOLD_TEXT, TEXT_COLOR, PANEL_BORDER } from './render/shared';
import { generateFloorEncounter, resolveTrap, resolveTreasure, type FloorEncounter, RoomType } from './game/dungeon';
import { createProgression, grantXp, xpForMonster, type Progression } from './game/progression';
import { rollMutationItem, CONSUMABLE_DROP_CHANCE, TREASURE_MUTATION_CHANCE } from './game/item';
import { mulberry32, chance } from './game/rng';
import { animOffset, animProgress } from './render/fx';
import {
  playMenuMove,
  playConfirm,
  playHit,
  playVictory,
  playCharm,
  playLevelUp,
  playDefeat,
  startAmbient,
  stopAmbient,
  toggleMute,
  isMuted,
} from './audio/audio';
import {
  createBattle,
  playerAttack,
  playerUseItem,
  playerCharm,
  isVulnerable,
  isBattleOver,
  type Combatant,
  type BattleState,
  BattlePhase,
} from './game/battle';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const context = canvas.getContext('2d')!;

const GAME_TITLE = '🦄 Rainbow Depths';
const GAME_SUBTITLE = 'Charm your way to happily ever after in a unicorn dungeon crawl';

const enum GameState { Title, Battle, Event, MutationReveal, MutationTransform, GameOver, Win }

let runSeed = 0;
let floor = 1;
let traits: UnicornTraits;
let player: Combatant;
// The charisma player started this specific run with (baseline stat +
// permanent dust bonus) — checkVictory() only fires once charisma rises
// past 90 *during* the run, not just because the permanent baseline already
// sits there, so a heavily-boosted player can still play a normal run
// instead of being bounced back to the Win screen on every "New Run".
let runStartCharisma = 0;
let progression: Progression;
let inventory = 0; // consumable potion count
let state: GameState = GameState.Title;
let encounter: FloorEncounter;
let monsterTraits: MonsterTraits | undefined;
let battle: BattleState | undefined;
let battleRewardsGranted = false;
let eventLines: string[] = [];
let gameOverLines: string[] = [];
// Per-kind drop count for the run in progress — one roll per boss defeated
// (Victory or Charmed), not just one per run. Reset in startRun(), read by
// the GameOver summary's "This Run" column.
let thisRunDust = [0, 0, 0, 0];
let selected = 0;
let lifetimeStats: LifetimeStats = loadLifetimeStats();
let heldDust = loadHeld();
let dustCashedIns = loadCashedIns();
let bestiaryOpen = false;
let bestiaryPage = 0; // page N is archetype N — see game/bestiary.ts's variantKey comment
const encountered = loadEncountered();

// Set when a mutation item is found; consumed the next time the player would
// otherwise advance a floor, showing the reveal screen (then the transform
// animation) first. pendingMutationBefore snapshots the unicorn's look
// before the mutation was applied, for the transform crossfade.
let pendingMutationReveal: { name: string; detail: string } | null = null;
let pendingMutationBefore: UnicornTraits | null = null;
let transformStart: number | null = null;
const TRANSFORM_DURATION = 1600;

// 90 matches game/battle.ts's charmChance() hard cap — once charisma alone
// reaches it, every charm attempt is already guaranteed, so that's the
// natural "you've become irresistible" win threshold. Requiring a rise
// above runStartCharisma (not just the raw >= 90 check) is what stops a
// heavily-boosted player from being bounced straight back to the Win
// screen on every single run — see runStartCharisma's comment.
function checkVictory(): boolean {
  if (player.charisma < 90 || player.charisma <= runStartCharisma) return false;
  stopAmbient();
  state = GameState.Win;
  return true;
}

function tryAdvanceOrReveal(): void {
  // A pending mutation reveal always takes priority over the victory check.
  // rollMutationItem() applies its stat boost the instant it's rolled (see
  // maybeGrantBattleRewards/the Treasure branch below), so a charisma-boosting
  // item can cross the win threshold before its own reveal has been shown.
  // Checking victory first would jump straight to the Win screen and
  // silently swallow that reveal — the player would never see what they
  // found. Showing the reveal here, then re-checking victory once it's
  // dismissed (in confirmSelection's MutationTransform branch), guarantees
  // the reveal is always seen before a win can end the run.
  if (pendingMutationReveal) {
    state = GameState.MutationReveal;
    return;
  }
  if (checkVictory()) return;
  advanceFloor();
}

// Run stats, tracked for the Game Over summary panel.
let monstersDefeated = 0;
let bossesDefeated = 0;
let treasuresFound = 0;
let trapsFound = 0;
let rainbowFruitsFound = 0; // permanent mutation items — "Rainbow Fruit" is the umbrella name

// HP bar tween state — bars animate toward the real value instead of snapping.
let displayedPlayerHp = 0;
let displayedEnemyHp = 0;
const HP_TWEEN_RATE = 0.15;

// Combat animation timing (attack lunges, hit flash/shake). null = inactive.
const LUNGE_DURATION = 260;
const LUNGE_DISTANCE = 46;
const HIT_DURATION = 380;
const SHAKE_MAGNITUDE = 16;
const ENEMY_TURN_OFFSET = 380;
let playerAttackAnimStart: number | null = null;
let enemyAttackAnimStart: number | null = null;
let playerHitAnimStart: number | null = null;
let enemyHitAnimStart: number | null = null;

// Screen transitions swap state at the midpoint of a fade — one mechanism
// covers Title<->Battle and Battle/Event->GameOver instead of hard cuts.
// Floor advances are instant (no transition).
const enum FadePhase { None, Out, In }
let fadePhase: FadePhase = FadePhase.None;
let fadeStart = 0;
let pendingAction: (() => void) | null = null;
const FADE_DURATION = 220;

function transitionTo(action: () => void): void {
  pendingAction = action;
  fadePhase = FadePhase.Out;
  fadeStart = performance.now();
}

// Abandons whatever's currently happening and returns to Title — used both
// by the GameOver/Win "Title Screen" option and by pressing Escape to end a
// run early. No lifetime-stat recording or dust drop happens here (those
// are earned by actually finishing a run via Defeat), so this can't be used
// to farm rewards by quitting right after a boss kill.
function returnToTitle(): void {
  stopAmbient();
  state = GameState.Title;
  traits = generateUnicornTraits(Math.floor(Math.random() * 1000000));
  selected = 0;
  // Escape can fire mid-reveal (state MutationReveal/MutationTransform never
  // excludes it), abandoning an unshown/undismissed item — clear it here so
  // nothing dangles between now and the next startRun(), which would null
  // these anyway but only once a new run actually begins.
  resetMutationState();
}

function resetMutationState(): void {
  pendingMutationReveal = null;
  pendingMutationBefore = null;
  transformStart = null;
}

function monsterToCombatant(m: MonsterTraits): Combatant {
  return { name: m.name, hp: m.hp, maxHp: m.maxHp, atk: m.atk, def: m.def, charisma: 0 };
}

function monsterSeedFor(seed: number, floorNum: number): number {
  return (seed ^ (floorNum * 0x27d4eb2f)) >>> 0;
}

// A seeded RNG for reward rolls (consumable drop, mutation item pick), distinct
// per floor so the same run seed always produces the same drops.
function rewardRngFor(offset: number): () => number {
  return mulberry32((runSeed ^ (floor * 0x2545f491) ^ offset) >>> 0);
}

// Command bar options for the current state — the same menu box drives combat
// actions, treasure collect/leave, and advancing to the next floor.
function currentMenuOptions(): string[] {
  if (state === GameState.Title) return ['Start'];
  if (state === GameState.MutationReveal) return ['Continue'];
  if (state === GameState.MutationTransform) {
    return transformStart !== null && performance.now() - transformStart < TRANSFORM_DURATION ? [] : ['Continue'];
  }
  if (state === GameState.GameOver || state === GameState.Win) return ['New Run', 'Title Screen'];
  if (state === GameState.Battle) {
    if (!battle) return [];
    if (isBattleOver(battle)) return battle.phase === BattlePhase.Defeat ? ['Continue'] : ['Proceed'];
    const options = ['Attack'];
    if (inventory > 0) options.push('Potion');
    options.push('Charm');
    return options;
  }
  // state === GameState.Event
  return ['Proceed'];
}

// Geometry for the currently active command-bar menu — shared by rendering
// (so drawMenu is called with these exact numbers) and click/tap
// hit-testing, so taps land exactly where the drawn rows are.
// Tuple layout: [x, y, width, height, centered].
type MenuRect = [number, number, number, number, boolean];

function menuBounds(): MenuRect | null {
  const modalCenterY = 720 / 2;
  if (state === GameState.Title) {
    return [1280 / 2 - 68, 720 - 140, 136, 48, true];
  }
  if (state === GameState.MutationReveal) {
    return [1280 / 2 - 90, modalCenterY + 380 / 2 - 66, 180, 48, true];
  }
  if (state === GameState.MutationTransform) {
    if (currentMenuOptions().length === 0) return null;
    return [1280 / 2 - 90, modalCenterY + 520 / 2 - 66, 180, 48, true];
  }
  if (state === GameState.Win) {
    return [1280 / 2 - 142, 720 - 170, 284, 150, true];
  }
  return [1280 - 340, 720 - 200, 284, 150, false];
}

// stats panel sits to the left of the combat log, both aligned to the same
// row so neither overlaps the player sprite above them
const STATS_PANEL_X = 16;
const STATS_PANEL_W = 78;

// combat log panel geometry — kept in sync with the drawLog() call below
const LOG_X = STATS_PANEL_X + STATS_PANEL_W + 12;
const LOG_Y = 720 - 200;
const LOG_W = 1280 - 400 - (LOG_X - 56);
const LOG_H = 150;

// level badge sits directly above the stats panel, same column
const LEVEL_BADGE_H = 74;
const LEVEL_BADGE_GAP = 10;
const LEVEL_BADGE_Y = LOG_Y - LEVEL_BADGE_GAP - LEVEL_BADGE_H;

// HP bar geometry — sprites are centered under their matching bar
const HP_BAR_W = 340;
const PLAYER_HP_X = 56;
const ENEMY_HP_X = 1280 - 396;
const PLAYER_SPRITE_X = PLAYER_HP_X + HP_BAR_W / 2;
const ENEMY_SPRITE_X = ENEMY_HP_X + HP_BAR_W / 2;

function resetCombatAnims(): void {
  playerAttackAnimStart = null;
  enemyAttackAnimStart = null;
  playerHitAnimStart = null;
  enemyHitAnimStart = null;
}

// Shown once per battle, the moment the enemy first crosses into "vulnerable"
// (see isVulnerable in game/battle.ts) — a flavor cue for the Charm glow
// rather than a number, so the player still has to notice and act on it.
// vulnerableMessageLogIndex/AnimStart drive drawLog's letter-grow-in effect
// on that specific line.
let vulnerableMessageShown = false;
let vulnerableMessageLogIndex = -1;
let vulnerableMessageAnimStart = 0;

function enterFloor(): void {
  encounter = generateFloorEncounter(runSeed, floor);
  selected = 0;
  battleRewardsGranted = false;
  vulnerableMessageShown = false;
  vulnerableMessageLogIndex = -1;
  resetCombatAnims();

  // encounter is -1 (boss) or RoomType.Monster (0) for a monster room, and
  // both sort below RoomType.Treasure (1) — see game/dungeon.ts's
  // FloorEncounter comment for the full -1-means-boss encoding.
  if (encounter < RoomType.Treasure) {
    const monsterSeed = monsterSeedFor(runSeed, floor);
    // Only -1 (not RoomType.Monster's 0) means boss.
    monsterTraits = generateMonsterTraits(monsterSeed, floor, encounter < RoomType.Monster);
    markEncountered(encountered, monsterTraits.archetypeIndex, monsterTraits.prefixIndex, monsterTraits.variant);
    battle = createBattle(player, monsterToCombatant(monsterTraits), monsterSeed);
    displayedEnemyHp = battle.enemy.hp;
    state = GameState.Battle;
    return;
  }

  monsterTraits = undefined;
  battle = undefined;

  if (encounter === RoomType.Treasure) {
    treasuresFound += 1;
    const result = resolveTreasure(runSeed, floor, TREASURE_MUTATION_CHANCE);
    // resolveTreasure signs its result: abs(result) is always the heal
    // amount, and a negative result also means "found a mutation item" —
    // see the comment on resolveTreasure in game/dungeon.ts.
    const heal = Math.abs(result);
    player.hp = Math.min(player.maxHp, player.hp + heal);
    eventLines = [`Floor ${floor}: Treasure Room`, `You find a treasure chest. Healed ${heal} HP.`];
    if (result < 0) {
      pendingMutationBefore = { ...traits };
      pendingMutationReveal = rollMutationItem(rewardRngFor(0x3), player, traits);
      rainbowFruitsFound += 1;
    }
    state = GameState.Event;
  } else {
    trapsFound += 1;
    const damage = resolveTrap(runSeed, floor, floor, player.hp);
    player.hp = Math.max(1, player.hp - damage);
    eventLines = [`Floor ${floor}: Trap Room`, `A hidden trap triggers! You take ${damage} damage.`];
    state = GameState.Event;
  }
}

function advanceFloor(): void {
  floor += 1;
  enterFloor();
}

function startRun(): void {
  runSeed = Math.floor(Math.random() * 1000000);
  traits = generateUnicornTraits(runSeed);
  player = { name: 'Unicorn', hp: 80, maxHp: 80, atk: 16, def: 10, charisma: 20 };
  // Permanent cross-run bonuses from cashed-in Mysterious Dust sets — see
  // game/dust.ts. bonus is [maxHp, atk, def, charisma].
  const bonus = dustBonusTotals(dustCashedIns);
  player.maxHp += bonus[0];
  player.hp += bonus[0];
  player.atk += bonus[1];
  player.def += bonus[2];
  player.charisma += bonus[3];
  runStartCharisma = player.charisma;
  progression = createProgression();
  inventory = 0;
  floor = 1;
  displayedPlayerHp = player.hp;
  monstersDefeated = 0;
  bossesDefeated = 0;
  treasuresFound = 0;
  trapsFound = 0;
  rainbowFruitsFound = 0;
  thisRunDust = [0, 0, 0, 0];
  resetMutationState();
  // No checkVictory() call here — it can never legitimately fire this early
  // now, since runStartCharisma is set to this exact charisma value above.
  startAmbient();
  enterFloor();
}

traits = generateUnicornTraits(Math.floor(Math.random() * 1000000)); // title-screen preview

// Awards XP/level-ups, a chance at a consumable, and (guaranteed on bosses) a
// permanent mutation item. Runs once per battle, right after it's won.
function maybeGrantBattleRewards(): void {
  if (!battle || battleRewardsGranted || !isBattleOver(battle)) return;
  if (battle.phase !== BattlePhase.Victory && battle.phase !== BattlePhase.Charmed) return;
  if (!monsterTraits) return;
  battleRewardsGranted = true;

  if (battle.phase === BattlePhase.Victory) {
    playVictory();
    monstersDefeated += 1;
    if (monsterTraits.isBoss) bossesDefeated += 1;
  } else {
    playCharm();
  }

  const xpGain = xpForMonster(monsterTraits);
  const levelResult = grantXp(progression, player, xpGain);
  levelResult.messages.forEach((m) => battle!.log.push(m));
  if (levelResult.levelsGained > 0) playLevelUp(0.4);

  if (chance(rewardRngFor(0x1), CONSUMABLE_DROP_CHANCE)) {
    inventory += 1;
    battle!.log.push('You found a Rainbow Potion! (Item +1)');
  }

  if (monsterTraits.isBoss) {
    pendingMutationBefore = { ...traits };
    pendingMutationReveal = rollMutationItem(rewardRngFor(0x2), player, traits);
    rainbowFruitsFound += 1;

    // One Mysterious item per boss defeated (Victory or Charmed), not just
    // one per run — see game/dust.ts's DropResult.
    const [kind, cashedIn, cashedIns] = grantDust(heldDust, dustCashedIns);
    dustCashedIns = cashedIns;
    thisRunDust[kind] += 1;
    battle!.log.push(`✨ Mysterious ${ITEM_NAMES[kind]} found${cashedIn ? ' — collection complete!' : '.'}`);
  }
}

// Player's lunge/enemy-hit-flash play immediately; if the enemy also
// counterattacks in this same resolved turn, its lunge/player-hit-flash are
// staggered to start after the player's animation, so the two hits read as
// sequential even though battle.ts resolved them in one synchronous call.
function triggerCombatAnims(enemyHpBefore: number, playerHpBefore: number, wasPlayerAttack: boolean): void {
  if (!battle) return;
  const now = performance.now();

  if (wasPlayerAttack && battle.enemy.hp < enemyHpBefore) {
    playerAttackAnimStart = now;
    enemyHitAnimStart = now + LUNGE_DURATION * 0.5;
    playHit((LUNGE_DURATION * 0.5) / 1000);
  }

  if (battle.player.hp < playerHpBefore) {
    const enemyStart = now + (wasPlayerAttack ? ENEMY_TURN_OFFSET : 0);
    enemyAttackAnimStart = enemyStart;
    playerHitAnimStart = enemyStart + LUNGE_DURATION * 0.5;
    playHit((enemyStart - now + LUNGE_DURATION * 0.5) / 1000);
  }
}

function confirmSelection(): void {
  const options = currentMenuOptions();
  const choice = options[selected];

  if (state === GameState.Title) {
    transitionTo(startRun);
    return;
  }

  if (state === GameState.MutationReveal) {
    state = GameState.MutationTransform;
    transformStart = performance.now();
    selected = 0;
    return;
  }

  if (state === GameState.MutationTransform) {
    resetMutationState();
    // Check victory right here, now that the item's stat boost has actually
    // been shown to the player — see tryAdvanceOrReveal's comment for why
    // this can't happen before the reveal.
    if (checkVictory()) return;
    advanceFloor();
    return;
  }

  if (state === GameState.GameOver || state === GameState.Win) {
    if (choice === 'Title Screen') transitionTo(returnToTitle);
    else transitionTo(startRun);
    return;
  }

  if (state === GameState.Battle) {
    if (!battle) return;
    if (isBattleOver(battle)) {
      if (battle.phase === BattlePhase.Defeat) {
        playDefeat();
        stopAmbient();
        transitionTo(() => {
          gameOverLines = [...battle!.log, `Fell on Floor ${floor}.`];
          lifetimeStats = recordRun(lifetimeStats, {
            floor,
            level: progression.level,
            monstersDefeated,
            bossesDefeated,
            treasuresFound,
            trapsFound,
            rainbowFruitsFound,
          });
          state = GameState.GameOver;
          selected = 0;
        });
      } else {
        tryAdvanceOrReveal();
      }
      return;
    }
    const enemyHpBefore = battle.enemy.hp;
    const playerHpBefore = battle.player.hp;
    const wasAttack = choice === 'Attack';

    if (choice === 'Attack') playerAttack(battle);
    else if (choice === 'Potion') {
      inventory -= 1;
      playerUseItem(battle);
    } else if (choice === 'Charm') playerCharm(battle);

    if (!vulnerableMessageShown && battle.enemy.hp > 0 && isVulnerable(battle.enemy)) {
      vulnerableMessageShown = true;
      vulnerableMessageLogIndex = battle.log.length;
      vulnerableMessageAnimStart = performance.now();
      battle.log.push(`${battle.enemy.name} finds your charisma hard to resist...`);
    }

    triggerCombatAnims(enemyHpBefore, playerHpBefore, wasAttack);
    maybeGrantBattleRewards();
    if (isBattleOver(battle)) selected = 0;
    return;
  }

  tryAdvanceOrReveal();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') {
    toggleMute();
    return;
  }
  if (e.key === 'b' || e.key === 'B' || (e.key === 'Escape' && bestiaryOpen)) {
    bestiaryOpen = !bestiaryOpen;
    return;
  }
  if (bestiaryOpen) {
    if (e.key === 'ArrowLeft' || e.key === 'a') bestiaryPage = (bestiaryPage + 8) % 9;
    else if (e.key === 'ArrowRight' || e.key === 'd') bestiaryPage = (bestiaryPage + 1) % 9;
    return;
  }
  if (fadePhase !== FadePhase.None) return;
  // Escape ends the current run early and returns to Title — available any
  // time a run is actually in progress (not already on Title/GameOver/Win,
  // which have their own menu options for this).
  if (e.key === 'Escape' && state !== GameState.Title && state !== GameState.GameOver && state !== GameState.Win) {
    transitionTo(returnToTitle);
    return;
  }
  const advance = e.key === 'Enter' || e.key === ' ';
  const options = currentMenuOptions();
  if (options.length === 0) return;

  if (e.key === 'ArrowUp' || e.key === 'w') {
    selected = (selected + options.length - 1) % options.length;
    playMenuMove();
  } else if (e.key === 'ArrowDown' || e.key === 's') {
    selected = (selected + 1) % options.length;
    playMenuMove();
  } else if (advance) {
    playConfirm();
    confirmSelection();
  }
});

// Maps a mouse/touch event's client coordinates onto canvas-space pixels,
// accounting for the CSS-scaled display size (1280x720 is the fixed internal
// resolution, not the on-screen size). Returns a [x, y] tuple.
function canvasPoint(e: MouseEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) * (1280 / rect.width), (e.clientY - rect.top) * (720 / rect.height)];
}

// Click/tap support for the command-bar menu. A single tap both selects and
// confirms the tapped row — mobile browsers synthesize a 'click' from a
// tap, so this doubles as touch support with no separate touch handlers.
// The audio engine lazily unlocks on first sound played from a user
// gesture, and click qualifies just like keydown does.
canvas.addEventListener('click', (e) => {
  const [mx, my] = canvasPoint(e);

  if (bestiaryOpen) {
    // Prev/next arrow hit zones, positioned to match drawBestiary's '‹'/'›'
    // glyphs at the panel's top-left/top-right corners — generously sized
    // (50x50) for comfortable tapping. Any other tap closes the panel.
    const [bx, by, bw] = bestiaryPanelRect();
    if (mx >= bx + 7 && mx <= bx + 57 && my >= by + 7 && my <= by + 57) {
      bestiaryPage = (bestiaryPage + 8) % ARCHETYPE_COUNT;
      return;
    }
    if (mx >= bx + bw - 57 && mx <= bx + bw - 7 && my >= by + 7 && my <= by + 57) {
      bestiaryPage = (bestiaryPage + 1) % ARCHETYPE_COUNT;
      return;
    }
    bestiaryOpen = false;
    return;
  }
  if (fadePhase !== FadePhase.None) return;

  if (state !== GameState.Title) {
    const mtw = muteToggleWidth(context, isMuted());
    // Fixed toggle bounds in the 1280x720 layout: right edge x=1264, top
    // y=16, height 34 — see muteToggleWidth's comment in render/ui.ts.
    if (mx >= 1264 - mtw && mx <= 1264 && my >= 16 && my <= 50) {
      toggleMute();
      return;
    }
    // Bestiary button sits 10px left of the mute toggle — see
    // drawBestiaryButton's comment.
    const btw = bestiaryButtonWidth();
    if (mx >= 1264 - mtw - 10 - btw && mx <= 1264 - mtw - 10 && my >= 16 && my <= 50) {
      bestiaryOpen = true;
      return;
    }
  }

  const mb = menuBounds();
  if (!mb) return;
  const options = currentMenuOptions();
  if (options.length === 0) return;
  // mb is [x, y, width, height, centered] — see MenuRect above.
  if (mx < mb[0] || mx > mb[0] + mb[2] || my < mb[1] || my > mb[1] + mb[3]) return;

  const rowH = mb[3] / options.length;
  const row = Math.min(options.length - 1, Math.floor((my - mb[1]) / rowH));
  selected = row;
  playConfirm();
  confirmSelection();
});

// Small round "B" button, same visual family as the mute toggle — gives
// mouse/touch users a way to open the Bestiary (keydown 'B' otherwise).
const BESTIARY_LABEL = '[B]estiary';

// Same pill shape/sizing as muteToggleWidth's toggle, just a different label.
function bestiaryButtonWidth(): number {
  context.font = '600 16px sans-serif';
  return context.measureText(BESTIARY_LABEL).width + 28;
}

function drawBestiaryButton(): void {
  const mtw = muteToggleWidth(context, isMuted());
  const bw = bestiaryButtonWidth();
  // 1264 - mtw is the mute toggle's left edge (see muteToggleWidth's comment
  // in render/ui.ts); this button sits another 10px gap to the left of that.
  const x = 1264 - mtw - 10 - bw;
  drawPillButton(context, x, bw, BESTIARY_LABEL);
}

// Same pill style as the mute toggle/Bestiary button, and same row —
// another 10px gap to the left of the Bestiary button. Not a button (no
// click handler) — Escape has no touch equivalent, so there's nothing
// useful to make clickable here.
const ESCAPE_LABEL = '[Esc] End Run';

function drawEscapeHint(): void {
  context.font = '600 16px sans-serif';
  const w = context.measureText(ESCAPE_LABEL).width + 28;
  const mtw = muteToggleWidth(context, isMuted());
  const bw = bestiaryButtonWidth();
  const x = 1264 - mtw - 10 - bw - 10 - w;
  drawPillButton(context, x, w, ESCAPE_LABEL);
}

const ARCHETYPE_COUNT = 9;
const BESTIARY_PREFIXES = 4;
const BESTIARY_VARIANTS = 3;
const BESTIARY_COL_W = 220;
const BESTIARY_ROW_H = 180;
const BESTIARY_HEADER_H = 100;
const BESTIARY_SCALE = 0.85;

// Display names for the Bestiary's page title — must stay in the same order
// as game/monster.ts's Archetype enum / MONSTER_DRAWERS.
const ARCHETYPE_NAMES = ['Blob', 'Quadruped', 'Avian', 'Arachnid', 'Crystal', 'Sea Creature', 'Flora', 'Robot', 'Swarm'];

// Fixed panel geometry, computed once and reused by both drawBestiary and
// the click handler's prev/next arrow hit-testing below.
function bestiaryPanelRect(): [number, number, number, number] {
  const bw = BESTIARY_COL_W * BESTIARY_PREFIXES + 40;
  const bh = BESTIARY_HEADER_H + BESTIARY_ROW_H * BESTIARY_VARIANTS + 20;
  return [1280 / 2 - bw / 2, 720 / 2 - bh / 2, bw, bh];
}

// One page per archetype (108 total combos = 9 archetypes x 4 prefixes x 3
// variants — see game/bestiary.ts's variantKey comment), so every combo for
// the current archetype is shown together before paging to the next one.
// Each page is a 4 (prefix, across) x 3 (variant, down) grid; all 12
// portraits share one archetype, so its base stats are shown once at the
// top rather than repeated in every cell.
function drawBestiary(t: number): void {
  if (!bestiaryOpen) return;
  context.fillStyle = 'rgba(10,6,18,0.6)';
  context.fillRect(0, 0, 1280, 720);

  const [bx, by, bw, bh] = bestiaryPanelRect();
  const a = bestiaryPage;

  drawPanelBg(context, bx, by, bw, bh, 18);

  context.textAlign = 'center';
  context.fillStyle = TEXT_COLOR;
  context.font = '700 20px sans-serif';
  context.textBaseline = 'top';
  context.fillText('Bestiary', 1280 / 2, by + 12);

  context.font = '700 16px sans-serif';
  context.fillStyle = 'rgba(244,236,255,0.85)';
  context.fillText(`${ARCHETYPE_NAMES[a]}s`, 1280 / 2, by + 40);

  let anySeen = false;
  for (let p = 0; p < BESTIARY_PREFIXES && !anySeen; p++) {
    for (let v = 0; v < BESTIARY_VARIANTS; v++) {
      if (encountered.has(variantKey(a, p, v))) {
        anySeen = true;
        break;
      }
    }
  }
  const base = archetypePreview(a, 0, 0);
  context.font = '600 13px sans-serif';
  context.fillStyle = 'rgba(244,236,255,0.7)';
  context.fillText(
    anySeen ? `HP ${base.hp}  ·  ATK ${base.atk}  ·  DEF ${base.def}` : 'HP ???  ·  ATK ???  ·  DEF ???',
    1280 / 2,
    by + 66
  );

  // Prev/next arrows, at the panel's own top-left/top-right corners —
  // hit-tested in the click handler using the same bestiaryPanelRect() +
  // fixed offsets.
  context.textBaseline = 'middle';
  context.font = '700 28px sans-serif';
  context.fillStyle = TEXT_COLOR;
  context.fillText('‹', bx + 32, by + 32);
  context.fillText('›', bx + bw - 32, by + 32);

  // Page indicator, bottom-right of the panel.
  context.textAlign = 'right';
  context.textBaseline = 'alphabetic';
  context.font = '600 13px sans-serif';
  context.fillText(`${a + 1}/${ARCHETYPE_COUNT}`, bx + bw - 16, by + bh - 14);

  const gx = bx + 20;
  const gy = by + BESTIARY_HEADER_H;
  // Flora draws from a ground-level origin (stem + petals stacked entirely
  // above y=0), unlike every other archetype's roughly origin-centered body,
  // so at the same anchor point it reads as floating too high — nudge it
  // down to visually match. One page is always a single archetype, so this
  // is computed once per page rather than per cell.
  const archetypeYOffset = a === Archetype.Flora ? 35 : 0;

  for (let p = 0; p < BESTIARY_PREFIXES; p++) {
    const colMidX = gx + p * BESTIARY_COL_W + BESTIARY_COL_W / 2;

    for (let v = 0; v < BESTIARY_VARIANTS; v++) {
      const rowY = gy + v * BESTIARY_ROW_H;

      if (encountered.has(variantKey(a, p, v))) {
        const preview = archetypePreview(a, p, v);
        context.save();
        context.translate(colMidX, rowY + 80 + archetypeYOffset);
        context.scale(BESTIARY_SCALE, BESTIARY_SCALE);
        drawMonster(context, 0, 0, preview, t);
        context.restore();

        context.textAlign = 'center';
        context.textBaseline = 'top';
        context.font = '600 13px sans-serif';
        context.fillStyle = TEXT_COLOR;
        context.fillText(preview.name, colMidX, rowY + BESTIARY_ROW_H - 20);
      } else {
        context.fillStyle = 'rgba(255,255,255,0.08)';
        context.beginPath();
        context.roundRect(colMidX - 55, rowY + 15, 110, 130, 12);
        context.fill();
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = '700 28px sans-serif';
        context.fillStyle = 'rgba(244,236,255,0.4)';
        context.fillText('?', colMidX, rowY + 78);
      }
    }
  }
  context.textAlign = 'left';
}

// The game's only true win condition — reaching the charm-chance hard cap
// (see checkVictory). A full-screen celebration takeover, same shape as the
// Title branch in render(): no combat HUD, just the moment.
function drawWin(t: number): void {
  // drawBackdrop() already painted the pastel sky behind this — no need for
  // a second background here.
  // Sparkles: fixed deterministic spread, cheap twinkle via an alpha pulse.
  for (let i = 0; i < 30; i++) {
    context.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(t / 300 + i));
    context.fillStyle = '#fff2cf'; // matches the unicorn horn's color — a
    // free byte win, since it's an exact repeat of an existing string.
    context.beginPath();
    context.arc((i * 173) % 1280, (i * 97) % 560, 2 + (i % 3), 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;

  context.save();
  context.translate(1280 / 2 - 130, 720 * 0.62);
  context.scale(0.9, 0.9);
  drawUnicorn(context, traits, t);
  context.restore();

  if (monsterTraits) {
    context.save();
    context.translate(1280 / 2 + 150, 720 * 0.58);
    context.scale(0.9, 0.9);
    drawMonster(context, 0, 0, monsterTraits, t);
    context.restore();
  }

  drawTransformPanel(context, 1280 / 2, 150, 820, 220, t);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillStyle = GOLD_TEXT;
  context.font = '800 30px sans-serif';
  context.fillText('🌈 You Win! 🌈', 1280 / 2, 60);

  context.font = '600 17px sans-serif';
  const lines = wrapText(
    context,
    'You have become so irresistible that you and the monster live in harmony forever.',
    700
  );
  lines.forEach((line, i) => context.fillText(line, 1280 / 2, 110 + i * 26));
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';

  const menu = menuBounds()!;
  drawMenu(context, menu[0], menu[1], menu[2], menu[3], currentMenuOptions(), selected, true);
}

function drawFadeOverlay(t: number): void {
  if (fadePhase === FadePhase.None) return;
  const progress = Math.min(1, (t - fadeStart) / FADE_DURATION);
  const alpha = fadePhase === FadePhase.Out ? progress : 1 - progress;
  context.fillStyle = `rgba(20,12,32,${alpha})`;
  context.fillRect(0, 0, 1280, 720);
}

function drawBackdrop() {
  const sky = context.createLinearGradient(0, 0, 0, 720 * 0.72);
  sky.addColorStop(0, '#dff1ff');
  sky.addColorStop(1, '#fbeaff');
  context.fillStyle = sky;
  context.fillRect(0, 0, 1280, 720);

  context.fillStyle = '#eadcff';
  context.beginPath();
  context.ellipse(1280 / 2, 720 * 0.82 + 90, 1280 * 0.72, 110, 0, 0, Math.PI * 2);
  context.fill();
}

function render(): void {
    const t = performance.now();

    if (fadePhase === FadePhase.Out && t - fadeStart >= FADE_DURATION) {
      pendingAction?.();
      pendingAction = null;
      fadePhase = FadePhase.In;
      fadeStart = t;
    } else if (fadePhase === FadePhase.In && t - fadeStart >= FADE_DURATION) {
      fadePhase = FadePhase.None;
    }

    drawBackdrop();
    const uiScale = 720 / 600;

    if (state === GameState.Title) {
      context.save();
      context.translate(1280 / 2, 720 * 0.72);
      context.scale(uiScale * 1.4, uiScale * 1.4);
      drawUnicorn(context, traits, t);
      context.restore();

      drawTitleCard(context, 48, 40, GAME_TITLE, GAME_SUBTITLE, t);
      if (lifetimeStats.bestFloor > 0) {
        context.font = '700 16px sans-serif';
        context.fillStyle = GOLD_TEXT;
        context.textAlign = 'right';
        context.fillText(`🏆 Best Floor: ${lifetimeStats.bestFloor}`, 1280 - 48, 720 - 48);
        context.textAlign = 'left';
      }
      if (dustCashedIns > 0) {
        context.font = '700 16px sans-serif';
        context.fillStyle = GOLD_TEXT;
        context.textAlign = 'right';
        context.fillText(`✨ Mysteries Found: ${dustCashedIns}`, 1280 - 48, 720 - 24);
        context.textAlign = 'left';
      }
      const titleMenu = menuBounds()!;
      drawMenu(context, titleMenu[0], titleMenu[1], titleMenu[2], titleMenu[3], currentMenuOptions(), selected, true);
      drawFadeOverlay(t);
      drawBestiary(t);
      return;
    }

    if (state === GameState.Win) {
      drawWin(t);
      drawFadeOverlay(t);
      return;
    }

    drawMuteToggle(context, isMuted());
    drawBestiaryButton();
    if (state !== GameState.GameOver) drawEscapeHint();

    const playerLunge = animOffset(playerAttackAnimStart, t, LUNGE_DURATION, LUNGE_DISTANCE);
    const playerHitP = animProgress(playerHitAnimStart, t, HIT_DURATION);
    const playerShakeX = playerHitP !== null ? (Math.random() - 0.5) * SHAKE_MAGNITUDE * (1 - playerHitP) : 0;
    const playerShakeY = playerHitP !== null ? (Math.random() - 0.5) * SHAKE_MAGNITUDE * 0.5 * (1 - playerHitP) : 0;

    if (state !== GameState.MutationTransform) {
      context.save();
      context.translate(PLAYER_SPRITE_X + playerLunge + playerShakeX, 720 * 0.62 + playerShakeY);
      context.scale(uiScale, uiScale);
      drawUnicorn(context, traits, t);
      context.restore();
    }

    if (state === GameState.Battle && monsterTraits) {
      const enemyLunge = animOffset(enemyAttackAnimStart, t, LUNGE_DURATION, LUNGE_DISTANCE);
      const enemyHitP = animProgress(enemyHitAnimStart, t, HIT_DURATION);
      const enemyShakeX = enemyHitP !== null ? (Math.random() - 0.5) * SHAKE_MAGNITUDE * (1 - enemyHitP) : 0;
      const enemyShakeY = enemyHitP !== null ? (Math.random() - 0.5) * SHAKE_MAGNITUDE * 0.5 * (1 - enemyHitP) : 0;

      context.save();
      context.translate(ENEMY_SPRITE_X - enemyLunge + enemyShakeX, 720 * 0.5 + enemyShakeY);
      context.scale(uiScale, uiScale);
      drawMonster(context, 0, 0, monsterTraits, t);
      context.restore();
    } else if (state === GameState.Event) {
      context.save();
      context.translate(ENEMY_SPRITE_X, 720 * 0.5);
      context.scale(uiScale, uiScale);
      if (encounter === RoomType.Treasure) drawTreasureChest(context, 0, 0, t);
      else drawTrapFloor(context, 0, 0, t);
      context.restore();
    } else if (state === GameState.GameOver) {
      // A kind is "known" (shows its real name in the label instead of
      // "???") once you've ever held one of it, or once any set has ever
      // been cashed in (which requires having held all 4 at once) — no
      // separate tracking needed, both facts already live in
      // heldDust/dustCashedIns. heldDust alone resets a kind's count to 0 on
      // every cash-in, so dustCashedIns > 0 is what keeps it revealed
      // afterward instead of reverting to a mystery.
      const dustRows: [string, number | string, number | string][] = ITEM_NAMES.map((name, i) => [
        dustCashedIns > 0 || heldDust[i] > 0 ? `Mysterious ${name}` : '???',
        thisRunDust[i],
        heldDust[i],
      ]);
      drawRunSummary(
        context,
        1280 / 2,
        270,
        560,
        400,
        {
          floorReached: floor,
          level: progression.level,
          monstersDefeated,
          bossesDefeated,
          treasuresFound,
          trapsFound,
          rainbowFruitsFound,
        },
        lifetimeStats,
        t,
        dustRows
      );
    }

    if (state !== GameState.GameOver) {
      // Only -1 means boss; RoomType.Monster (0) is a normal monster room.
      drawFloorBadge(context, 1280 / 2, 16, floor, encounter < RoomType.Monster);
    }

    displayedPlayerHp += (player.hp - displayedPlayerHp) * HP_TWEEN_RATE;
    if (Math.abs(player.hp - displayedPlayerHp) < 0.4) displayedPlayerHp = player.hp;
    drawHpBar(context, PLAYER_HP_X, 80, HP_BAR_W, 26, player, displayedPlayerHp, progression.level);

    if (state === GameState.Battle && battle) {
      displayedEnemyHp += (battle.enemy.hp - displayedEnemyHp) * HP_TWEEN_RATE;
      if (Math.abs(battle.enemy.hp - displayedEnemyHp) < 0.4) displayedEnemyHp = battle.enemy.hp;
      drawHpBar(context, ENEMY_HP_X, 80, HP_BAR_W, 26, battle.enemy, displayedEnemyHp);
    }

    drawLevelBadge(context, STATS_PANEL_X, LEVEL_BADGE_Y, STATS_PANEL_W, LEVEL_BADGE_H, progression.level, t);

    drawStatsPanel(context, STATS_PANEL_X, LOG_Y, STATS_PANEL_W, LOG_H, [
      ['ATK', player.atk],
      ['DEF', player.def],
      ['CHA', player.charisma],
      ['POT', inventory],
    ]);

    const currentLog = state === GameState.Battle && battle ? battle.log : state === GameState.Event ? eventLines : gameOverLines;
    drawLog(
      context,
      LOG_X,
      LOG_Y,
      LOG_W,
      LOG_H,
      currentLog,
      state === GameState.Battle ? vulnerableMessageLogIndex : -1,
      vulnerableMessageAnimStart,
      t
    );

    const modalCenterY = 720 / 2;

    if (state === GameState.MutationReveal && pendingMutationReveal) {
      context.fillStyle = 'rgba(10,6,18,0.45)';
      context.fillRect(0, 0, 1280, 720);
      drawMutationReveal(context, 1280 / 2, modalCenterY, 680, 380, pendingMutationReveal.name, pendingMutationReveal.detail, t);
    } else if (state === GameState.MutationTransform && pendingMutationBefore && pendingMutationReveal) {
      const progress = transformStart === null ? 1 : Math.min(1, (t - transformStart) / TRANSFORM_DURATION);
      const tcx = 1280 / 2;
      const tcy = modalCenterY;
      const tw = 820;
      const th = 520;

      context.fillStyle = 'rgba(10,6,18,0.45)';
      context.fillRect(0, 0, 1280, 720);
      drawTransformPanel(context, tcx, tcy, tw, th, t);

      // Unicorn geometry stands with feet at the translate origin and its
      // head/horn extending roughly 300 units upward and negligibly below
      // it — read from drawUnicorn's own coordinate math, not guessed.
      const spriteScale = uiScale * 0.68;
      const spriteY = tcy + 105;
      const leftX = tcx - tw * 0.27;
      const rightX = tcx + tw * 0.27;

      context.save();
      context.translate(leftX, spriteY);
      context.scale(spriteScale, spriteScale);
      drawUnicorn(context, pendingMutationBefore, t);
      context.restore();

      context.save();
      context.translate(rightX, spriteY);
      context.scale(spriteScale, spriteScale);
      context.globalAlpha = progress;
      drawUnicorn(context, traits, t);
      context.globalAlpha = 1;
      context.restore();

      context.textAlign = 'center';
      context.fillStyle = GOLD_TEXT;
      context.textBaseline = 'middle';
      context.font = '700 42px sans-serif';
      context.fillText('→', tcx, spriteY - 135);

      context.textBaseline = 'top';
      context.font = '700 20px sans-serif';
      context.fillText(`✨ ${pendingMutationReveal.name} ✨`, tcx, tcy - th / 2 + 20);

      context.font = '600 15px sans-serif';
      const transformLines = wrapText(context, pendingMutationReveal.detail, tw - 100);
      transformLines.forEach((line, i) => context.fillText(line, tcx, tcy - th / 2 + 52 + i * 22));
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
    }

    const menuOptions = currentMenuOptions();
    const mb = menuBounds();
    if (mb) {
      const charmGlow =
        state === GameState.Battle && battle && !isBattleOver(battle) && isVulnerable(battle.enemy)
          ? menuOptions.indexOf('Charm')
          : -1;
      drawMenu(context, mb[0], mb[1], mb[2], mb[3], menuOptions, selected, mb[4], charmGlow, t);
    }
    drawFadeOverlay(t);
    drawBestiary(t);
}

function loop(): void {
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
