/**
 * Battle Bot AI
 *
 * Provides Easy / Medium / Hard AI for bot players.
 * Username pattern:  Bot(Easy|Medium|Hard)\d*   (case-insensitive)
 *   e.g.  BotEasy1  BotMedium3  BotHard99
 *
 * How it works:
 *   When a RoomBattlePlayer has isBot=true, the listen() handler in
 *   room-battle.ts calls BattleBot.respond() instead of forwarding the
 *   request to a real user's socket.  BattleBot reads the request JSON,
 *   picks a choice, and writes it back to the battle stream.
 */

'use strict';

export type BotDifficulty = 'easy' | 'medium' | 'hard';

/** Parse a username and return its difficulty, or null if not a bot name. */
export function parseBotName(name: string): BotDifficulty | null {
	const m = /^bot(easy|medium|hard)\d*$/i.exec(toID(name));
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
	const delayMs = difficulty === 'easy' ? 600 : difficulty === 'medium' ? 800 : 1100;
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

	// Medium / Hard: score each move
	const activePokemon = req.side.pokemon.find(p => p.active)!;
	const selfTypes = getTypes(toID(speciesName(activePokemon?.details ?? '')));
	const oppTypes = oppSpecies ? getTypes(toID(oppSpecies)) : [];

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

		// ── Type effectiveness vs opponent ──
		if (oppTypes.length && bp > 0) {
			const eff = effectiveness(dexMove.type, oppTypes);
			if (eff === 0) {
				score = -999; // immune — never use
			} else {
				score *= eff;
			}
		}

		// ── Status / utility moves ──
		if (bp === 0) {
			const selfHp = hpPercent(activePokemon?.condition ?? '100/100');
			if (m.id === 'recover' || m.id === 'softboiled' || m.id === 'roost' || m.id === 'milkdrink' || m.id === 'slackoff') {
				score = selfHp < 50 ? 60 : 5; // heal when hurt
			} else if (m.id === 'spore' || m.id === 'sleeppowder' || m.id === 'lovelykiss') {
				score = diff === 'hard' ? 70 : 20; // put foe to sleep
			} else if (m.id === 'toxic' || m.id === 'willowisp') {
				score = diff === 'hard' ? 50 : 10;
			} else if (m.id === 'stealthrock' || m.id === 'spikes' || m.id === 'toxicspikes') {
				score = diff === 'hard' ? 45 : 5;
			} else if (m.id === 'swordsdance' || m.id === 'nastyplot' || m.id === 'calmmind' || m.id === 'dragondance') {
				score = diff === 'hard' && selfHp > 60 ? 55 : 10;
			} else {
				score = 5; // random low-value utility
			}
		}

		// ── Priority (Hard: use if we're slower and can finish) ──
		if (diff === 'hard' && (dexMove.priority ?? 0) > 0 && bp > 0) {
			score += 15;
		}

		return { m, score };
	});

	scored.sort((a, b) => b.score - a.score);

	// Hard: sometimes (15%) pick the 2nd-best move to be less predictable
	const pick = (diff === 'hard' && scored.length > 1 && Math.random() < 0.15)
		? scored[1]
		: scored[0];

	// Consider switching if heavily disadvantaged (medium 10%, hard 25%)
	const switchThreshold = diff === 'medium' ? 0.10 : 0.25;
	if (diff !== 'easy' && pick.score < 5 && Math.random() < switchThreshold) {
		const sw = pickSwitch(req, diff, oppSpecies);
		if (sw !== 'default') return sw;
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

	// Medium/Hard: pick the bench Pokemon with the best type matchup vs opponent
	const oppTypes = oppSpecies ? getTypes(toID(oppSpecies)) : [];

	const scored = bench.map(p => {
		const pTypes = getTypes(toID(speciesName(p.details)));
		let score = hpPercent(p.condition) * 0.5; // prefer healthy Pokemon

		if (oppTypes.length) {
			// Prefer Pokemon that resist the opponent's STAB moves
			for (const oppType of oppTypes) {
				const eff = effectiveness(oppType, pTypes);
				if (eff < 1) score += (1 - eff) * 30; // good resistance
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
