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

interface ActiveRequest {
	moves: MoveRequest[];
	canDynamax?: boolean;
	canMegaEvo?: boolean;
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
					// Only set up when healthy and in a favorable matchup
					if (selfHp > 75) {
						score = 70;
						// Shell Smash and Belly Drum are extremely powerful
						if (m.id === 'shellsmash') score = 80;
						if (m.id === 'bellydrum' && selfHp > 85) score = 85;
						if (m.id === 'quiverdance') score = 80;
						// Boost more aggressively if we resist the opponent
						if (oppTypes.length) {
							let resists = false;
							for (const oppType of oppTypes) {
								if (effectiveness(oppType, selfTypes) < 1) resists = true;
							}
							if (resists) score += 15;
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

	// Extreme: also consider switching if the opponent hard-counters us even if we have OK moves
	if (diff === 'extreme' && !active.trapped && !active.maybeTrapped && oppTypes.length) {
		let dominated = false;
		for (const oppType of oppTypes) {
			if (effectiveness(oppType, selfTypes) > 1.5) dominated = true;
		}
		// If we're dominated AND our best move isn't great, switch
		if (dominated && pick.score < 20 && selfHp > 30 && Math.random() < 0.60) {
			const sw = pickSwitch(req, diff, oppSpecies);
			if (sw !== 'default') return sw;
		}
	}

	return `move ${pick.m.idx}`;
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

			// Reward Pokemon with recovery moves (can sustain better)
			const healMoves = ['recover', 'softboiled', 'roost', 'milkdrink', 'slackoff',
				'moonlight', 'morningsun', 'synthesis', 'shoreup', 'wish', 'strengthsap'];
			if (p.moves.some(mid => healMoves.includes(mid))) {
				score += 10;
			}

			// Consider the switch-in's ability
			const switchAbility = toID(p.ability || p.baseAbility || '');
			// Immunities via ability
			if (oppTypes.length) {
				if (oppTypes.includes('Water') && (switchAbility === 'waterabsorb' ||
					switchAbility === 'stormdrain' || switchAbility === 'dryskin')) {
					score += 40;
				}
				if (oppTypes.includes('Fire') && (switchAbility === 'flashfire' ||
					switchAbility === 'dryskin')) {
					score += 40;
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
			}

			// Intimidate is great for physical attackers
			if (switchAbility === 'intimidate' && oppBaseStats && oppBaseStats.atk > oppBaseStats.spa) {
				score += 20;
			}

			// Natural Cure is great for removing status on switch
			if (switchAbility === 'naturalcure' || switchAbility === 'regenerator') {
				score += 8;
			}

			// Regenerator recovers HP, making switches less costly
			if (switchAbility === 'regenerator') {
				score += 12;
			}

			// Consider the switch-in's item
			const switchItem = toID(p.item || '');
			if (switchItem === 'heavydutyboots') {
				score += 8; // immune to hazards on switch
			}

			// Prefer switch-ins with good offensive matchup AND defensive matchup
			// (double bonus if both offensive and defensive matchups are favorable)
			let offensivelyGood = false;
			let defensivelyGood = false;
			if (oppTypes.length) {
				for (const moveId of p.moves) {
					const dm = Dex.moves.get(moveId);
					if (dm.basePower && dm.basePower > 0 && effectiveness(dm.type, oppTypes) > 1) {
						offensivelyGood = true;
						break;
					}
				}
				defensivelyGood = oppTypes.every(t => effectiveness(t, pTypes) <= 1);
			}
			if (offensivelyGood && defensivelyGood) score += 20; // ideal counter
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
