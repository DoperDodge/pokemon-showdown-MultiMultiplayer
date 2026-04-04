/**
 * Battle Bot AI
 *
 * Provides Easy / Medium / Hard / Extreme AI for bot players.
 * Username pattern:  Bot(Easy|Medium|Hard|Extreme)\d*   (case-insensitive)
 *   e.g.  BotEasy1  BotMedium3  BotHard99  BotExtreme1
 *
 * How it works:
 *   When a RoomBattlePlayer has isBot=true, the listen() handler in
 *   room-battle.ts calls BattleBot.respond() instead of forwarding the
 *   request to a real user's socket.  BattleBot reads the request JSON,
 *   picks a choice, and writes it back to the battle stream.
 */

'use strict';

export type BotDifficulty = 'easy' | 'medium' | 'hard' | 'extreme';

/** Parse a username and return its difficulty, or null if not a bot name. */
export function parseBotName(name: string): BotDifficulty | null {
	const m = /^bot(easy|medium|hard|extreme)\d*$/i.exec(toID(name));
	if (!m) return null;
	return m[1].toLowerCase() as BotDifficulty;
}

// ---------------------------------------------------------------------------
// Request types (subset of what the battle engine sends)
// ---------------------------------------------------------------------------

interface MoveRequest {
	id: string;
	move: string;
	pp: number;
	maxpp: number;
	disabled: boolean;
	target?: string;
}

interface ZMoveOption {
	move: string;
	target: string;
	basePower?: number;
}

interface ActiveRequest {
	moves: MoveRequest[];
	canDynamax?: boolean;
	canMegaEvo?: boolean;
	canMegaEvoX?: boolean;
	canMegaEvoY?: boolean;
	canUltraBurst?: boolean;
	canZMove?: (ZMoveOption | null)[];
	canTerastallize?: string; // the tera type
	maxMoves?: { maxMoves: { move: string; target: string }[] };
	trapped?: boolean;
	maybeTrapped?: boolean;
}

interface SidePokemon {
	ident: string;       // e.g. "p1: Charizard"
	details: string;     // e.g. "Charizard, L100, M"
	condition: string;   // e.g. "281/281" or "0 fnt"
	active: boolean;
	stats: { atk: number; def: number; spa: number; spd: number; spe: number };
	moves: string[];
	baseAbility: string;
	item: string;
	ability: string;
}

interface BattleRequest {
	active?: ActiveRequest[];
	side: { name: string; id: string; pokemon: SidePokemon[] };
	forceSwitch?: boolean[];
	noCancel?: boolean;
	rqid: number;
	wait?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hpPercent(condition: string): number {
	if (condition === '0 fnt') return 0;
	const [cur, max] = condition.split('/').map(Number);
	return max > 0 ? (cur / max) * 100 : 0;
}

function speciesName(details: string): string {
	return details.split(',')[0].trim();
}

/** Small lookup: move type → effectiveness multiplier vs given type(s). */
function effectiveness(moveType: string, defTypes: string[]): number {
	let mult = 1;
	for (const dt of defTypes) {
		const v = Dex.getImmunity(moveType, dt);
		if (!v) return 0;
		mult *= Dex.getEffectiveness(moveType, dt);
	}
	return mult;
}

/** Get the Dex types of a species name (falls back to ['Normal']). */
function getTypes(speciesId: string): string[] {
	const s = Dex.species.get(speciesId);
	return s.exists ? (s.types as string[]) : ['Normal'];
}

// ---------------------------------------------------------------------------
// Pro-level helpers (Extreme difficulty)
// ---------------------------------------------------------------------------

/** Approximate damage calculation (simplified but accounts for key factors). */
function estimateDamage(
	bp: number, category: 'Physical' | 'Special' | 'Status',
	moveType: string, selfTypes: string[],
	selfStats: { atk: number; def: number; spa: number; spd: number; spe: number },
	selfAbility: string, selfItem: string,
	oppTypes: string[], oppBaseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null,
): number {
	if (category === 'Status' || bp === 0 || !oppBaseStats) return 0;
	// Attack / defense
	const atk = category === 'Physical' ? selfStats.atk : selfStats.spa;
	const def = category === 'Physical' ? oppBaseStats.def : oppBaseStats.spd;
	// Base damage formula (level 100 assumed)
	let dmg = ((2 * 100 / 5 + 2) * bp * atk / def) / 50 + 2;
	// STAB
	if (selfTypes.includes(moveType)) {
		dmg *= selfAbility === 'adaptability' ? 2.0 : 1.5;
	}
	// Type effectiveness
	const eff = effectiveness(moveType, oppTypes);
	if (eff === 0) return 0;
	dmg *= eff;
	// Item boosts
	if (selfItem === 'choiceband' && category === 'Physical') dmg *= 1.5;
	if (selfItem === 'choicespecs' && category === 'Special') dmg *= 1.5;
	if (selfItem === 'lifeorb') dmg *= 1.3;
	// Ability boosts
	if (selfAbility === 'technician' && bp <= 60) dmg *= 1.5;
	if (selfAbility === 'strongjaw' && Dex.moves.get(moveType)?.flags?.bite) dmg *= 1.5;
	if (selfAbility === 'ironfist' && Dex.moves.get(moveType)?.flags?.punch) dmg *= 1.2;
	if (selfAbility === 'sheerforce' && Dex.moves.get(moveType)?.secondary) dmg *= 1.3;
	if (selfAbility === 'hugepower' || selfAbility === 'purepower') {
		if (category === 'Physical') dmg *= 2.0;
	}
	return dmg;
}

/** Estimate what % of opponent's HP a move deals. */
function estimateKOPercent(
	bp: number, category: 'Physical' | 'Special' | 'Status',
	moveType: string, selfTypes: string[], selfStats: SidePokemon['stats'],
	selfAbility: string, selfItem: string,
	oppTypes: string[], oppBaseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null,
): number {
	if (!oppBaseStats) return 0;
	const dmg = estimateDamage(bp, category, moveType, selfTypes, selfStats, selfAbility, selfItem, oppTypes, oppBaseStats);
	// Approximate opponent's HP at level 100 from base stats
	const oppHP = Math.floor((2 * oppBaseStats.hp + 31 + 63) * 100 / 100) + 110;
	return (dmg / oppHP) * 100;
}

/** Check if a Pokemon is likely a setup sweeper based on its moves. */
function hasSetupMoves(moves: string[]): boolean {
	const setup = ['swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'quiverdance',
		'shellsmash', 'shiftgear', 'coil', 'bulkup', 'agility', 'autotomize',
		'bellydrum', 'tailglow', 'growth', 'workup', 'honeclaws', 'rockpolish',
		'cottonguard', 'irondefense', 'curse'];
	return moves.some(m => setup.includes(m));
}

/** Check if a Pokemon has priority moves. */
function hasPriorityMoves(moves: string[]): boolean {
	const priorityMoves = ['extremespeed', 'fakeout', 'quickattack', 'machpunch',
		'bulletpunch', 'iceshard', 'shadowsneak', 'aquajet', 'suckerpunch',
		'accelerock', 'jetpunch', 'firstimpression', 'grassyglide'];
	return moves.some(m => priorityMoves.includes(m));
}

/** Determine if the active Pokemon is a "win condition" (sweeper with setup potential). */
function isWinCondition(pokemon: SidePokemon): boolean {
	const stats = pokemon.stats;
	const isOffensive = stats.atk > 120 || stats.spa > 120 || stats.spe > 100;
	return isOffensive && hasSetupMoves(pokemon.moves);
}

/** Count how many alive Pokemon are on the bench. */
function countAlive(team: SidePokemon[]): number {
	return team.filter(p => hpPercent(p.condition) > 0).length;
}

/** Check if move is a multi-hit move. */
function isMultiHit(moveId: string): boolean {
	const multiHit = ['bulletseed', 'iciclespear', 'rockblast', 'pinmissile', 'tailslap',
		'scaleshot', 'surgingstrikes', 'watershuriken', 'tripleaxel', 'populationbomb',
		'bonerush', 'doublehit', 'dualwingbeat', 'triplekick'];
	return multiHit.includes(moveId);
}

/** Check if move has recoil. */
function isRecoilMove(moveId: string): boolean {
	const recoil = ['bravebird', 'doubleedge', 'flareblitz', 'headsmash', 'headcharge',
		'highjumpkick', 'jumpkick', 'lightofruin', 'submission', 'takedown',
		'volttackle', 'wildcharge', 'woodhammer', 'wavecash', 'chloroblast'];
	return recoil.includes(moveId);
}

/** Weather-boosted types. */
function getWeatherBoost(moveType: string, ability: string): number {
	// Without actual weather tracking, use ability-based inference
	if (ability === 'drought' || ability === 'desolateland') {
		if (moveType === 'Fire') return 1.5;
		if (moveType === 'Water') return 0.5;
	}
	if (ability === 'drizzle' || ability === 'primordialsea') {
		if (moveType === 'Water') return 1.5;
		if (moveType === 'Fire') return 0.5;
	}
	if (ability === 'sandstream') {
		if (moveType === 'Rock') return 1.0; // SpD boost, not direct damage boost
	}
	return 1.0;
}

// ---------------------------------------------------------------------------
// Core AI
// ---------------------------------------------------------------------------

/** Called once per turn from room-battle.ts when the bot needs to move. */
export function respond(
	stream: { write: (s: string) => any },
	slot: string,
	requestJSON: string,
	difficulty: BotDifficulty,
	/** Species name of the current opposing active Pokemon (may be empty). */
	opponentSpecies: string,
): void {
	let request: BattleRequest;
	try {
		request = JSON.parse(requestJSON) as BattleRequest;
	} catch {
		void stream.write(`>${slot} default`);
		return;
	}

	if (request.wait) return; // nothing to do

	const choice = computeChoice(request, difficulty, opponentSpecies);
	// Small artificial delay so the bot doesn't look instant
	const delayMs = difficulty === 'easy' ? 600 : difficulty === 'medium' ? 800 :
		difficulty === 'hard' ? 1100 : 1400;
	setTimeout(() => void stream.write(`>${slot} ${choice}`), delayMs);
}

function computeChoice(
	req: BattleRequest,
	diff: BotDifficulty,
	oppSpecies: string,
): string {
	// --- Force-switch ---
	if (req.forceSwitch) {
		return pickSwitch(req, diff, oppSpecies);
	}

	// --- Move request ---
	if (req.active?.length) {
		return pickMove(req, diff, oppSpecies);
	}

	return 'default';
}

// ---------------------------------------------------------------------------
// Move selection
// ---------------------------------------------------------------------------

function pickMove(req: BattleRequest, diff: BotDifficulty, oppSpecies: string): string {
	const active = req.active![0];
	const available = active.moves
		.map((m, i) => ({ ...m, idx: i + 1 }))
		.filter(m => !m.disabled && m.pp > 0);

	if (!available.length) return 'move 1'; // struggle

	if (diff === 'easy') {
		return `move ${randItem(available).idx}`;
	}

	// Medium / Hard / Extreme: score each move
	const activePokemon = req.side.pokemon.find(p => p.active)!;
	const selfTypes = getTypes(toID(speciesName(activePokemon?.details ?? '')));
	const oppTypes = oppSpecies ? getTypes(toID(oppSpecies)) : [];
	const selfHp = hpPercent(activePokemon?.condition ?? '100/100');

	// Extreme: look up own ability and item for smarter decisions
	const selfAbility = diff === 'extreme' ? toID(activePokemon?.ability ?? '') : '';
	const selfItem = diff === 'extreme' ? toID(activePokemon?.item ?? '') : '';

	// Extreme: look up opponent's species data for ability/stat awareness
	const oppDexSpecies = diff === 'extreme' && oppSpecies ? Dex.species.get(toID(oppSpecies)) : null;
	const oppBaseStats = oppDexSpecies?.exists ? oppDexSpecies.baseStats : null;
	const oppAbilities = oppDexSpecies?.exists
		? Object.values(oppDexSpecies.abilities).map(a => toID(a as string)) : [];

	// Extreme: estimate if the opponent is likely physically or specially oriented
	const oppLikelyPhysical = oppBaseStats ? oppBaseStats.atk > oppBaseStats.spa : false;

	const scored = available.map(m => {
		const dexMove = Dex.moves.get(m.id);
		let score = 0;

		// ── Base power ──
		const bp = dexMove.basePower ?? 0;
		score += bp * 0.1;

		// ── Accuracy penalty ──
		const acc = dexMove.accuracy === true ? 100 : (dexMove.accuracy ?? 100);
		score *= acc / 100;

		// ── STAB ──
		if (selfTypes.includes(dexMove.type)) score *= 1.5;

		// ── Extreme: Adaptability doubles STAB bonus ──
		if (diff === 'extreme' && selfAbility === 'adaptability' && selfTypes.includes(dexMove.type)) {
			score *= 1.33; // 2.0/1.5 extra multiplier on top of STAB
		}

		// ── Type effectiveness vs opponent ──
		if (oppTypes.length && bp > 0) {
			const eff = effectiveness(dexMove.type, oppTypes);
			if (eff === 0) {
				score = -999; // immune — never use
			} else {
				score *= eff;
			}
		}

		// ── Extreme: use physical vs special category intelligently ──
		if (diff === 'extreme' && bp > 0) {
			const selfStats = activePokemon?.stats;
			if (selfStats) {
				if (dexMove.category === 'Physical' && selfStats.atk > selfStats.spa) {
					score *= 1.2;
				} else if (dexMove.category === 'Special' && selfStats.spa > selfStats.atk) {
					score *= 1.2;
				} else if (dexMove.category === 'Physical' && selfStats.spa > selfStats.atk * 1.3) {
					score *= 0.7; // penalize wrong-category moves
				} else if (dexMove.category === 'Special' && selfStats.atk > selfStats.spa * 1.3) {
					score *= 0.7;
				}
			}

			// Factor in opponent's lower defensive stat
			if (oppBaseStats) {
				if (dexMove.category === 'Physical' && oppBaseStats.def < oppBaseStats.spd) {
					score *= 1.15; // target the weaker defense
				} else if (dexMove.category === 'Special' && oppBaseStats.spd < oppBaseStats.def) {
					score *= 1.15;
				}
			}
		}

		// ── Extreme: item-aware boosts ──
		if (diff === 'extreme' && bp > 0) {
			if (selfItem === 'choiceband' && dexMove.category === 'Physical') score *= 1.3;
			if (selfItem === 'choicespecs' && dexMove.category === 'Special') score *= 1.3;
			if (selfItem === 'lifeorb') score *= 1.15;
			// Punish status moves when locked into a choice item
			if ((selfItem === 'choiceband' || selfItem === 'choicespecs' || selfItem === 'choicescarf') &&
				dexMove.category === 'Status') {
				score = -999;
			}
		}
		if (diff === 'extreme' && bp === 0 &&
			(selfItem === 'choiceband' || selfItem === 'choicespecs' || selfItem === 'choicescarf')) {
			score = -999; // never use status with choice items
		}

		// ── Extreme: ability-aware scoring ──
		if (diff === 'extreme' && bp > 0) {
			// Don't use contact moves into Rough Skin / Iron Barbs / Flame Body
			const contactDangerAbilities = ['roughskin', 'ironbarbs', 'flamebody', 'static', 'effectspore'];
			if (dexMove.flags?.contact && oppAbilities.some(a => contactDangerAbilities.includes(a))) {
				score *= 0.8;
			}
			// Don't use sound moves into Soundproof
			if (dexMove.flags?.sound && oppAbilities.includes('soundproof')) {
				score = -999;
			}
			// Don't use bullet/ball moves into Bulletproof
			if (dexMove.flags?.bullet && oppAbilities.includes('bulletproof')) {
				score = -999;
			}
			// Technician boost for low-BP moves
			if (selfAbility === 'technician' && bp <= 60) {
				score *= 1.5;
			}
			// Sheer Force boost for moves with secondary effects
			if (selfAbility === 'sheerforce' && dexMove.secondary) {
				score *= 1.3;
			}
			// Strong Jaw boost for biting moves
			if (selfAbility === 'strongjaw' && dexMove.flags?.bite) {
				score *= 1.5;
			}
			// Iron Fist boost for punching moves
			if (selfAbility === 'ironfist' && dexMove.flags?.punch) {
				score *= 1.2;
			}
			// Huge Power / Pure Power doubles physical attack
			if ((selfAbility === 'hugepower' || selfAbility === 'purepower') &&
				dexMove.category === 'Physical') {
				score *= 1.5;
			}
			// Tinted Lens makes resisted moves neutral
			if (selfAbility === 'tintedlens' && oppTypes.length) {
				const eff = effectiveness(dexMove.type, oppTypes);
				if (eff > 0 && eff < 1) score *= 1.8;
			}
			// Aerilate/Pixilate/Refrigerate/Galvanize boost Normal-type moves
			const ateAbilities = ['aerilate', 'pixilate', 'refrigerate', 'galvanize'];
			if (ateAbilities.includes(selfAbility) && dexMove.type === 'Normal' && bp > 0) {
				score *= 1.4;
			}
			// Protean/Libero gives STAB on everything
			if ((selfAbility === 'protean' || selfAbility === 'libero') && !selfTypes.includes(dexMove.type)) {
				score *= 1.3;
			}
			// Guts boost when statused (Guts users often carry Flame/Toxic Orb)
			if (selfAbility === 'guts' && dexMove.category === 'Physical') {
				score *= 1.15;
			}
			// Mold Breaker / Turboblaze / Teravolt ignores defensive abilities
			if (['moldbreaker', 'turboblaze', 'teravolt'].includes(selfAbility)) {
				score *= 1.05;
			}
			// Powder moves don't work on Grass types or Overcoat
			if (dexMove.flags?.powder && (oppTypes.includes('Grass') || oppAbilities.includes('overcoat'))) {
				score = -999;
			}
			// Prankster status moves don't affect Dark types (Gen 7+)
			if (selfAbility === 'prankster' && dexMove.category === 'Status' && oppTypes.includes('Dark')) {
				score = -999;
			}
			// Opponent ability-based immunities
			if (dexMove.type === 'Water' && (oppAbilities.includes('waterabsorb') ||
				oppAbilities.includes('stormdrain') || oppAbilities.includes('dryskin'))) {
				score = -999;
			}
			if (dexMove.type === 'Fire' && oppAbilities.includes('flashfire')) {
				score = -999;
			}
			if (dexMove.type === 'Electric' && (oppAbilities.includes('voltabsorb') ||
				oppAbilities.includes('lightningrod') || oppAbilities.includes('motordrive'))) {
				score = -999;
			}
			if (dexMove.type === 'Grass' && oppAbilities.includes('sapsipper')) {
				score = -999;
			}
			if (dexMove.type === 'Ground' && oppAbilities.includes('levitate')) {
				score = -999;
			}

			// ── Recoil awareness ──
			if (isRecoilMove(m.id)) {
				if (selfHp < 40) score *= 0.6;
				else if (selfHp < 60) score *= 0.85;
				if (selfAbility === 'rockhead') score *= 1.2;
			}

			// ── Multi-hit move bonus (breaks Subs, Focus Sash, Sturdy) ──
			if (isMultiHit(m.id)) {
				score *= 1.15;
				if (selfAbility === 'skilllink') score *= 1.3;
			}

			// ── Weather ability boosting ──
			const weatherBoost = getWeatherBoost(dexMove.type, selfAbility);
			if (weatherBoost !== 1.0) score *= weatherBoost;

			// ── KO estimation: big bonus if we can likely KO ──
			if (oppBaseStats && activePokemon?.stats) {
				const koPct = estimateKOPercent(
					bp, dexMove.category as 'Physical' | 'Special',
					dexMove.type, selfTypes, activePokemon.stats,
					selfAbility, selfItem, oppTypes, oppBaseStats,
				);
				if (koPct >= 90) score += 40;
				else if (koPct >= 60) score += 20;
				else if (koPct >= 40) score += 10;
			}

			// ── Sucker Punch awareness: conditional move ──
			if (m.id === 'suckerpunch') {
				score *= 0.85;
			}
		}

		// ── Status / utility moves ──
		if (bp === 0) {
			const healMoves = ['recover', 'softboiled', 'roost', 'milkdrink', 'slackoff',
				'moonlight', 'morningsun', 'synthesis', 'shoreup', 'wish', 'strengthsap'];
			const sleepMoves = ['spore', 'sleeppowder', 'lovelykiss', 'darkvoid', 'hypnosis', 'yawn'];
			const hazardMoves = ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'];
			const setupMoves = ['swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'irondefense',
				'quiverdance', 'shellsmash', 'shiftgear', 'coil', 'bulkup', 'agility', 'autotomize',
				'bellydrum', 'tailglow', 'growth', 'workup', 'honeclaws', 'rockpolish', 'cottonguard'];
			const screenMoves = ['reflect', 'lightscreen', 'auroraveil'];
			const pivotMoves = ['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport'];

			if (healMoves.includes(m.id)) {
				if (diff === 'extreme') {
					// Smart healing: heal aggressively when moderately hurt, not at full HP
					score = selfHp < 30 ? 85 : selfHp < 50 ? 70 : selfHp < 75 ? 25 : 2;
				} else {
					score = selfHp < 50 ? 60 : 5;
				}
			} else if (sleepMoves.includes(m.id)) {
				if (diff === 'extreme') {
					score = 80; // sleep is always high-value
					// Spore is 100% accurate, prioritize it
					if (m.id === 'spore') score = 90;
					// Don't sleep if opponent has Insomnia/Vital Spirit
					if (oppAbilities.includes('insomnia') || oppAbilities.includes('vitalspirit') ||
						oppAbilities.includes('sweetveil') || oppAbilities.includes('overcoat')) {
						score = -999;
					}
				} else {
					score = diff === 'hard' ? 70 : 20;
				}
			} else if (m.id === 'toxic' || m.id === 'willowisp' || m.id === 'thunderwave') {
				if (diff === 'extreme') {
					score = 55;
					// Will-O-Wisp is great against physical attackers
					if (m.id === 'willowisp' && oppLikelyPhysical) score = 70;
					// Thunder Wave is great against fast opponents
					if (m.id === 'thunderwave' && oppBaseStats && oppBaseStats.spe > 90) score = 65;
					// Don't burn/paralyze/poison opponents who might have immunity abilities
					if (m.id === 'willowisp' && (oppAbilities.includes('flashfire') ||
						oppAbilities.includes('waterveil') || oppAbilities.includes('waterbubble') ||
						oppTypes.includes('Fire'))) {
						score = -999;
					}
					if (m.id === 'toxic' && (oppTypes.includes('Poison') || oppTypes.includes('Steel'))) {
						score = -999;
					}
					if (m.id === 'thunderwave' && (oppTypes.includes('Electric') || oppTypes.includes('Ground') ||
						oppAbilities.includes('limber') || oppAbilities.includes('voltabsorb') ||
						oppAbilities.includes('lightningrod') || oppAbilities.includes('motordrive'))) {
						score = -999;
					}
				} else {
					score = diff === 'hard' ? 50 : 10;
				}
			} else if (hazardMoves.includes(m.id)) {
				if (diff === 'extreme') {
					score = 55; // hazards are always valuable
					// Stealth Rock is the best hazard
					if (m.id === 'stealthrock') score = 65;
					if (m.id === 'stickyweb') score = 60;
				} else {
					score = diff === 'hard' ? 45 : 5;
				}
			} else if (setupMoves.includes(m.id)) {
				if (diff === 'extreme') {
					// Pro-level setup logic: consider matchup, team state, and payoff
					if (selfHp > 75) {
						score = 70;
						// Tier the setup moves by power level
						if (m.id === 'shellsmash') score = 85;
						if (m.id === 'bellydrum' && selfHp > 85) score = 90;
						if (m.id === 'quiverdance') score = 82;
						if (m.id === 'dragondance') score = 80;
						if (m.id === 'nastyplot') score = 78;
						if (m.id === 'swordsdance') score = 78;
						if (m.id === 'calmmind') score = 72;
						if (m.id === 'agility' || m.id === 'autotomize' || m.id === 'rockpolish') {
							// Speed-boosting only: great if we're slow but powerful
							const selfStats = activePokemon?.stats;
							if (selfStats && oppBaseStats && selfStats.spe < oppBaseStats.spe) {
								score = 75; // we're slower, speed boost is great
							} else {
								score = 30; // already fast, less valuable
							}
						}
						// Boost more aggressively if we resist the opponent
						if (oppTypes.length) {
							let resists = false;
							for (const oppType of oppTypes) {
								if (effectiveness(oppType, selfTypes) < 1) resists = true;
							}
							if (resists) score += 15;
						}
						// Boost more if opponent is defensive/slow (can't threaten us)
						if (oppBaseStats && oppBaseStats.spe < 60) score += 10;
						// Penalize setup if opponent has Unaware
						if (oppAbilities.includes('unaware')) score -= 40;
						// Penalize setup if opponent has Haze/Clear Smog/Whirlwind
						// (can't know, but tanky opponents often carry phazing)
						if (oppBaseStats && oppBaseStats.hp > 100 && oppBaseStats.def > 100) {
							score -= 10; // tanky opponents may phaze
						}
					} else if (selfHp > 50) {
						score = 30; // risky but possible
					} else {
						score = 5; // too low HP to set up
					}
				} else {
					score = diff === 'hard' && selfHp > 60 ? 55 : 10;
				}
			} else if (diff === 'extreme' && screenMoves.includes(m.id)) {
				score = selfHp > 50 ? 50 : 20;
			} else if (diff === 'extreme' && pivotMoves.includes(m.id)) {
				// Pivoting is great when at a type disadvantage
				if (oppTypes.length) {
					let dominated = false;
					for (const oppType of oppTypes) {
						if (effectiveness(oppType, selfTypes) > 1) dominated = true;
					}
					score = dominated ? 60 : 15;
				} else {
					score = 15;
				}
			} else if (diff === 'extreme' && (m.id === 'defog' || m.id === 'rapidspin' || m.id === 'courtchange')) {
				score = 30; // hazard removal has moderate value
			} else if (diff === 'extreme' && (m.id === 'trick' || m.id === 'switcheroo')) {
				// Trick is great with choice items to cripple opponents
				if (selfItem === 'choiceband' || selfItem === 'choicespecs' || selfItem === 'choicescarf' ||
					selfItem === 'flameorb' || selfItem === 'toxicorb' || selfItem === 'stickybarb' ||
					selfItem === 'laggingtail' || selfItem === 'ironball') {
					score = 65;
				} else {
					score = 10;
				}
			} else {
				score = 5; // random low-value utility
			}
		}

		// ── Priority moves ──
		if ((diff === 'hard' || diff === 'extreme') && (dexMove.priority ?? 0) > 0 && bp > 0) {
			if (diff === 'extreme') {
				// Extreme: use priority smartly — great for finishing off or when outsped
				if (oppBaseStats && oppBaseStats.spe > (activePokemon?.stats?.spe ?? 0)) {
					score += 25; // we're slower, priority is very valuable
				} else {
					score += 10;
				}
			} else {
				score += 15;
			}
		}

		// ── Extreme: negative priority awareness (moves like Trick Room, Roar) ──
		if (diff === 'extreme' && (dexMove.priority ?? 0) < 0 && bp > 0) {
			score *= 0.85; // slightly penalize negative priority attacking moves
		}

		return { m, score };
	});

	scored.sort((a, b) => b.score - a.score);

	// Hard: sometimes (15%) pick the 2nd-best move to be less predictable
	// Extreme: very rarely (5%) to maintain near-optimal play but avoid being 100% predictable
	let pick;
	if (diff === 'extreme' && scored.length > 1 && Math.random() < 0.05) {
		pick = scored[1];
	} else if (diff === 'hard' && scored.length > 1 && Math.random() < 0.15) {
		pick = scored[1];
	} else {
		pick = scored[0];
	}

	// Consider switching if heavily disadvantaged
	// Extreme: proactively switch when at a type disadvantage (50% chance)
	const switchThreshold = diff === 'extreme' ? 0.50 : diff === 'hard' ? 0.25 : 0.10;
	const switchScoreThreshold = diff === 'extreme' ? 10 : 5;
	if (diff !== 'easy' && !active.trapped && !active.maybeTrapped &&
		pick.score < switchScoreThreshold && Math.random() < switchThreshold) {
		const sw = pickSwitch(req, diff, oppSpecies);
		if (sw !== 'default') return sw;
	}

	// Extreme: pro-level switch-out evaluation
	if (diff === 'extreme' && !active.trapped && !active.maybeTrapped && oppTypes.length) {
		let dominated = false;
		let severeDomination = false;
		for (const oppType of oppTypes) {
			const eff = effectiveness(oppType, selfTypes);
			if (eff > 1) dominated = true;
			if (eff >= 2) severeDomination = true; // 4x weakness
		}

		// Severe domination (4x weakness): almost always switch
		if (severeDomination && selfHp > 15) {
			const sw = pickSwitch(req, diff, oppSpecies);
			if (sw !== 'default') return sw;
		}

		// Regular domination: switch if our best move isn't threatening enough
		if (dominated && pick.score < 25 && selfHp > 30 && Math.random() < 0.70) {
			const sw = pickSwitch(req, diff, oppSpecies);
			if (sw !== 'default') return sw;
		}

		// Even without type disadvantage, switch if we can't do anything useful
		if (pick.score < 8 && selfHp > 40) {
			const sw = pickSwitch(req, diff, oppSpecies);
			if (sw !== 'default') return sw;
		}

		// Don't stay in with a wall if opponent has a setup move user in
		// (indicated by low offensive stats but high speed — likely a sweeper)
		if (oppBaseStats && oppBaseStats.spe > 100 && pick.score < 15 && selfHp > 50) {
			const selfStats = activePokemon?.stats;
			const isDefensive = selfStats && selfStats.atk < 80 && selfStats.spa < 80;
			if (isDefensive) {
				// We're a defensive Pokemon that can't threaten a fast opponent
				const sw = pickSwitch(req, diff, oppSpecies);
				if (sw !== 'default') return sw;
			}
		}
	}

	// ── Extreme: Mechanic decisions (Mega, Dynamax, Terastallize, Z-Move, Ultra Burst) ──
	if (diff === 'extreme') {
		return pickMoveWithMechanic(req, active, pick, activePokemon, selfTypes, selfHp,
			oppTypes, oppBaseStats, oppAbilities);
	}

	return `move ${pick.m.idx}`;
}

/**
 * Extreme-only: decide whether to activate a battle mechanic alongside the chosen move.
 * Pro players use these at optimal moments — not immediately, not randomly.
 */
function pickMoveWithMechanic(
	req: BattleRequest,
	active: ActiveRequest,
	pick: { m: { idx: number; id: string }; score: number },
	activePokemon: SidePokemon,
	selfTypes: string[],
	selfHp: number,
	oppTypes: string[],
	oppBaseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null,
	oppAbilities: string[],
): string {
	const moveIdx = pick.m.idx;
	const dexMove = Dex.moves.get(pick.m.id);
	const selfStats = activePokemon?.stats;
	const selfAbility = toID(activePokemon?.ability ?? '');
	const selfItem = toID(activePokemon?.item ?? '');
	const aliveCount = countAlive(req.side.pokemon);

	// ── Mega Evolution: Almost always beneficial — do it immediately ──
	// Mega evolution provides stat boosts and often better abilities.
	// Pro play: mega evolve on the first opportunity unless there's a reason not to.
	if (active.canMegaEvo) {
		return `move ${moveIdx} mega`;
	}
	if (active.canMegaEvoX) {
		return `move ${moveIdx} megax`;
	}
	if (active.canMegaEvoY) {
		return `move ${moveIdx} megay`;
	}

	// ── Ultra Burst: Always do it (Necrozma-Ultra is strictly better) ──
	if (active.canUltraBurst) {
		return `move ${moveIdx} ultra`;
	}

	// ── Z-Move: Use for burst damage at critical moments ──
	if (active.canZMove) {
		const zMoveDecision = decideZMove(active, pick, activePokemon, selfTypes, selfHp,
			oppTypes, oppBaseStats, oppAbilities, aliveCount);
		if (zMoveDecision) return zMoveDecision;
	}

	// ── Dynamax: Strategic 3-turn power boost ──
	if (active.canDynamax) {
		const dynamaxDecision = decideDynamax(active, pick, activePokemon, selfTypes, selfHp,
			oppTypes, oppBaseStats, aliveCount);
		if (dynamaxDecision) return dynamaxDecision;
	}

	// ── Terastallize: Type change for offense or defense ──
	if (active.canTerastallize) {
		const teraDecision = decideTerastallize(active, pick, activePokemon, selfTypes, selfHp,
			oppTypes, oppBaseStats, aliveCount);
		if (teraDecision) return teraDecision;
	}

	return `move ${moveIdx}`;
}

/**
 * Z-Move decision logic.
 * Pro strategy: Z-moves are one-time nukes. Use them to:
 * 1. Secure a KO on a key threat
 * 2. Break through a wall that otherwise checks you
 * 3. Use Z-Status moves for powerful self-buffs
 */
function decideZMove(
	active: ActiveRequest,
	pick: { m: { idx: number; id: string }; score: number },
	activePokemon: SidePokemon,
	selfTypes: string[],
	selfHp: number,
	oppTypes: string[],
	oppBaseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null,
	oppAbilities: string[],
	aliveCount: number,
): string | null {
	const zMoves = active.canZMove!;
	const selfStats = activePokemon?.stats;
	const selfAbility = toID(activePokemon?.ability ?? '');
	const selfItem = toID(activePokemon?.item ?? '');

	// Find the best Z-move option
	let bestZIdx = -1;
	let bestZScore = -Infinity;

	for (let i = 0; i < zMoves.length; i++) {
		const zOption = zMoves[i];
		if (!zOption) continue;

		const baseMove = Dex.moves.get(active.moves[i]?.id ?? '');
		const zMove = Dex.moves.get(toID(zOption.move));
		const zBp = zOption.basePower ?? zMove.basePower ?? 0;

		if (zBp === 0 && zMove.category === 'Status') {
			// Z-Status moves: powerful one-time buffs
			// Z-Splash = +3 Atk, Z-Celebrate = +1 all stats, etc.
			// These are very strong setup tools
			if (selfHp > 70) {
				const statusScore = 75;
				if (statusScore > bestZScore) {
					bestZScore = statusScore;
					bestZIdx = i;
				}
			}
			continue;
		}

		if (zBp <= 0) continue;

		// Score the Z-move damage potential
		let zScore = 0;
		const eff = oppTypes.length ? effectiveness(zMove.type || baseMove.type, oppTypes) : 1;
		if (eff === 0) continue; // immune

		zScore = zBp * 0.1 * eff;

		// STAB bonus
		if (selfTypes.includes(zMove.type || baseMove.type)) zScore *= 1.5;

		// Category matching
		if (selfStats) {
			const cat = zMove.category || baseMove.category;
			if (cat === 'Physical' && selfStats.atk > selfStats.spa) zScore *= 1.2;
			if (cat === 'Special' && selfStats.spa > selfStats.atk) zScore *= 1.2;
		}

		// KO potential bonus
		if (oppBaseStats && selfStats) {
			const cat = zMove.category || baseMove.category;
			const koPct = estimateKOPercent(
				zBp, cat as 'Physical' | 'Special',
				zMove.type || baseMove.type, selfTypes, selfStats,
				selfAbility, selfItem, oppTypes, oppBaseStats,
			);
			if (koPct >= 80) zScore += 50; // very likely KO — great Z target
			else if (koPct >= 50) zScore += 25;
		}

		if (zScore > bestZScore) {
			bestZScore = zScore;
			bestZIdx = i;
		}
	}

	if (bestZIdx < 0) return null;

	// Decision criteria: use Z-move if it's significantly better than the normal move
	// or if we can secure a key KO
	const normalScore = pick.score;

	// Use Z-move if:
	// 1. Z-score is much higher than normal move (1.5x threshold)
	// 2. We're at decent HP (not desperation)
	// 3. Or we need the burst to KO
	if (bestZScore > normalScore * 1.4 || bestZScore > 60) {
		return `move ${bestZIdx + 1} zmove`;
	}

	// Use Z-move if we're in a late-game 1v1 and need maximum damage
	if (aliveCount <= 2 && bestZScore > normalScore) {
		return `move ${bestZIdx + 1} zmove`;
	}

	return null;
}

/**
 * Dynamax decision logic.
 * Pro strategy: Dynamax gives doubled HP and Max Moves with side effects.
 * Use it to:
 * 1. Survive a hit you otherwise wouldn't
 * 2. Set up weather/terrain with Max Moves for team benefit
 * 3. Sweep weakened teams
 * 4. Break through defensive cores
 */
function decideDynamax(
	active: ActiveRequest,
	pick: { m: { idx: number; id: string }; score: number },
	activePokemon: SidePokemon,
	selfTypes: string[],
	selfHp: number,
	oppTypes: string[],
	oppBaseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null,
	aliveCount: number,
): string | null {
	const selfStats = activePokemon?.stats;

	// Don't dynamax with very low HP (waste of the mechanic)
	if (selfHp < 25) return null;

	let shouldDynamax = false;

	// 1. Offensive sweeper: high attacking stats and good matchup
	if (selfStats) {
		const bestAtk = Math.max(selfStats.atk, selfStats.spa);
		const hasOffensiveMatchup = oppTypes.length > 0 && pick.score > 15;

		// Dynamax strong offensive Pokemon to sweep
		if (bestAtk > 110 && hasOffensiveMatchup && selfHp > 60) {
			shouldDynamax = true;
		}

		// Dynamax to survive: if we're at moderate HP and opponent threatens us
		if (selfHp > 40 && selfHp < 70 && oppTypes.length > 0) {
			let dominated = false;
			for (const oppType of oppTypes) {
				if (effectiveness(oppType, selfTypes) > 1) dominated = true;
			}
			if (dominated && pick.score > 10) {
				shouldDynamax = true; // double HP helps survive
			}
		}
	}

	// 2. Late-game: dynamax your last/best Pokemon to close out
	if (aliveCount <= 2 && selfHp > 40 && pick.score > 10) {
		shouldDynamax = true;
	}

	// 3. Setup sweeper: dynamax after a boost to become unstoppable
	if (isWinCondition(activePokemon) && selfHp > 50) {
		shouldDynamax = true;
	}

	if (shouldDynamax) {
		return `move ${pick.m.idx} dynamax`;
	}

	return null;
}

/**
 * Terastallize decision logic.
 * Pro strategy: Terastallization changes your type. Use it to:
 * 1. Gain STAB on a coverage move for a KO
 * 2. Drop a defensive weakness to survive
 * 3. Stack STAB on your primary type for massive damage
 */
function decideTerastallize(
	active: ActiveRequest,
	pick: { m: { idx: number; id: string }; score: number },
	activePokemon: SidePokemon,
	selfTypes: string[],
	selfHp: number,
	oppTypes: string[],
	oppBaseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null,
	aliveCount: number,
): string | null {
	const teraType = active.canTerastallize!;
	if (!teraType) return null;

	const dexMove = Dex.moves.get(pick.m.id);
	const selfStats = activePokemon?.stats;
	const selfAbility = toID(activePokemon?.ability ?? '');
	const selfItem = toID(activePokemon?.item ?? '');

	let shouldTera = false;

	// 1. Offensive Tera: If our best move matches the tera type, we get boosted STAB
	if (dexMove.type === teraType && dexMove.basePower > 0) {
		// Tera-STAB stacking: if we already have STAB, tera gives 2.25x instead of 1.5x
		// If we don't have STAB, we gain it (1.5x)
		if (selfTypes.includes(teraType)) {
			// Already STAB — tera boosts to 2x. Great for nuking.
			if (pick.score > 15 && selfHp > 40) {
				shouldTera = true;
			}
		} else {
			// Gaining new STAB — good for coverage moves
			if (oppTypes.length > 0 && effectiveness(teraType, oppTypes) > 1) {
				shouldTera = true; // SE coverage move becomes STAB+SE
			}
		}
	}

	// 2. Defensive Tera: Change type to resist opponent's STAB
	if (!shouldTera && oppTypes.length > 0 && selfHp > 30) {
		let currentlyWeak = false;
		let teraResists = true;
		const teraTypeArr = [teraType];

		for (const oppType of oppTypes) {
			if (effectiveness(oppType, selfTypes) > 1) currentlyWeak = true;
			if (effectiveness(oppType, teraTypeArr) >= 1) teraResists = false;
		}

		// Tera to drop a critical weakness
		if (currentlyWeak && teraResists) {
			shouldTera = true;
		}
	}

	// 3. Late-game Tera for the win: maximize damage output when it matters most
	if (!shouldTera && aliveCount <= 2 && selfHp > 30) {
		if (dexMove.type === teraType && dexMove.basePower > 0) {
			shouldTera = true;
		}
	}

	// 4. Tera to gain immunity (e.g., Tera Ghost to dodge Fighting/Normal)
	if (!shouldTera && oppTypes.length > 0 && selfHp > 20) {
		const teraTypeArr = [teraType];
		for (const oppType of oppTypes) {
			if (effectiveness(oppType, selfTypes) > 1 && effectiveness(oppType, teraTypeArr) === 0) {
				shouldTera = true; // gain immunity to a threatening type
				break;
			}
		}
	}

	// 5. Don't tera early in the game unless it's clearly beneficial
	// Pro players save tera for the right moment
	if (shouldTera && aliveCount >= 5 && pick.score < 25) {
		shouldTera = false; // too early, save it
	}

	if (shouldTera) {
		return `move ${pick.m.idx} terastallize`;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Switch selection
// ---------------------------------------------------------------------------

function pickSwitch(req: BattleRequest, diff: BotDifficulty, oppSpecies: string): string {
	const bench = req.side.pokemon
		.map((p, i) => ({ ...p, slot: i + 1 }))
		.filter(p => !p.active && hpPercent(p.condition) > 0);

	if (!bench.length) return 'default';
	if (diff === 'easy') return `switch ${randItem(bench).slot}`;

	// Medium/Hard/Extreme: pick the bench Pokemon with the best type matchup vs opponent
	const oppTypes = oppSpecies ? getTypes(toID(oppSpecies)) : [];
	const oppDexSpecies = oppSpecies ? Dex.species.get(toID(oppSpecies)) : null;
	const oppBaseStats = oppDexSpecies?.exists ? oppDexSpecies.baseStats : null;

	const scored = bench.map(p => {
		const pTypes = getTypes(toID(speciesName(p.details)));
		const hp = hpPercent(p.condition);
		let score = hp * 0.5; // prefer healthy Pokemon

		if (oppTypes.length) {
			// Prefer Pokemon that resist the opponent's STAB moves
			for (const oppType of oppTypes) {
				const eff = effectiveness(oppType, pTypes);
				if (eff === 0) score += 50;           // immune — excellent
				else if (eff < 1) score += (1 - eff) * 30; // good resistance
				if (eff > 1) score -= eff * 20;        // bad weakness
			}
			// Prefer Pokemon whose moves are effective vs opponent
			for (const moveId of p.moves) {
				const dm = Dex.moves.get(moveId);
				if (dm.basePower && dm.basePower > 0) {
					const eff = effectiveness(dm.type, oppTypes);
					score += eff * 10;
					if (pTypes.includes(dm.type)) score += 5; // STAB bonus
				}
			}
		}

		// ── Extreme: advanced switch-in evaluation ──
		if (diff === 'extreme') {
			// Strongly penalize switching to low-HP Pokemon
			if (hp < 25) score -= 30;
			if (hp < 15) score -= 30; // even more penalty for nearly dead

			// Reward Pokemon with recovery moves (can sustain better)
			const healMoves = ['recover', 'softboiled', 'roost', 'milkdrink', 'slackoff',
				'moonlight', 'morningsun', 'synthesis', 'shoreup', 'wish', 'strengthsap'];
			if (p.moves.some(mid => healMoves.includes(mid))) {
				score += 10;
				// Recovery + good HP = very sustainable switch-in
				if (hp > 60) score += 5;
			}

			// Consider the switch-in's ability
			const switchAbility = toID(p.ability || p.baseAbility || '');
			// Immunities via ability
			if (oppTypes.length) {
				if (oppTypes.includes('Water') && (switchAbility === 'waterabsorb' ||
					switchAbility === 'stormdrain' || switchAbility === 'dryskin')) {
					score += 40;
				}
				if (oppTypes.includes('Fire') && (switchAbility === 'flashfire')) {
					score += 40;
				}
				if (oppTypes.includes('Fire') && switchAbility === 'dryskin') {
					score -= 20; // Dry Skin takes MORE damage from Fire
				}
				if (oppTypes.includes('Electric') && (switchAbility === 'voltabsorb' ||
					switchAbility === 'lightningrod' || switchAbility === 'motordrive')) {
					score += 40;
				}
				if (oppTypes.includes('Ground') && switchAbility === 'levitate') {
					score += 40;
				}
				if (oppTypes.includes('Grass') && switchAbility === 'sapsipper') {
					score += 40;
				}
				if (oppTypes.includes('Normal') || oppTypes.includes('Fighting')) {
					if (pTypes.includes('Ghost')) score += 30; // Ghost immunity
				}
			}

			// Intimidate is great against physical attackers
			if (switchAbility === 'intimidate' && oppBaseStats && oppBaseStats.atk > oppBaseStats.spa) {
				score += 20;
			}

			// Natural Cure is great for removing status on switch
			if (switchAbility === 'naturalcure') {
				score += 8;
			}

			// Regenerator recovers HP, making switches less costly
			if (switchAbility === 'regenerator') {
				score += 18; // very valuable for defensive pivoting
			}

			// Multiscale/Shadow Shield: great at full HP
			if ((switchAbility === 'multiscale' || switchAbility === 'shadowshield') && hp > 95) {
				score += 25; // halves damage on first hit
			}

			// Unaware: great against setup sweepers
			if (switchAbility === 'unaware') {
				score += 10;
			}

			// Sturdy: guarantees surviving one hit at full HP
			if (switchAbility === 'sturdy' && hp > 95) {
				score += 15;
			}

			// Magic Bounce: reflects hazards/status
			if (switchAbility === 'magicbounce') {
				score += 12;
			}

			// Consider the switch-in's item
			const switchItem = toID(p.item || '');
			if (switchItem === 'heavydutyboots') {
				score += 8; // immune to hazards on switch
			}
			if (switchItem === 'assaultvest') {
				// Great special bulk but can't use status moves
				if (oppBaseStats && oppBaseStats.spa > oppBaseStats.atk) {
					score += 12; // good against special attackers
				}
			}
			if (switchItem === 'eviolite') {
				score += 10; // 1.5x both defenses
			}

			// Prefer switch-ins with good offensive matchup AND defensive matchup
			let offensivelyGood = false;
			let defensivelyGood = false;
			let superEffectiveCount = 0;
			if (oppTypes.length) {
				for (const moveId of p.moves) {
					const dm = Dex.moves.get(moveId);
					if (dm.basePower && dm.basePower > 0 && effectiveness(dm.type, oppTypes) > 1) {
						offensivelyGood = true;
						superEffectiveCount++;
					}
				}
				defensivelyGood = oppTypes.every(t => effectiveness(t, pTypes) <= 1);
			}
			if (offensivelyGood && defensivelyGood) score += 25; // ideal counter
			if (superEffectiveCount >= 2) score += 10; // multiple coverage options

			// Preserve win conditions: penalize switching in your sweeper carelessly
			if (isWinCondition(p as SidePokemon) && hp > 70) {
				// Only switch in win conditions if they hard-counter the opponent
				if (!offensivelyGood || !defensivelyGood) {
					score -= 15; // don't waste your sweeper as fodder
				}
			}

			// Prefer Pokemon with priority moves when opponent is fast and weakened
			if (oppBaseStats && oppBaseStats.spe > 100 && hasPriorityMoves(p.moves)) {
				score += 8;
			}

			// Speed tier awareness: if we outspeed, we get to act first
			if (oppBaseStats) {
				const switchSpecies = Dex.species.get(toID(speciesName(p.details)));
				if (switchSpecies.exists && switchSpecies.baseStats.spe > oppBaseStats.spe) {
					score += 8; // outspeeding is valuable
				}
			}

			// Pivot moves on the switch-in allow momentum
			const pivotMoves = ['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport'];
			if (p.moves.some(mid => pivotMoves.includes(mid))) {
				score += 5; // can pivot back out if needed
			}
		}

		return { slot: p.slot, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return `switch ${scored[0].slot}`;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function randItem<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}
