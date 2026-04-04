/**
 * FFA Lobby Plugin
 * Allows a host to open a Mass FFA lobby, have up to 4 players join,
 * then launch the battle all at once.
 *
 * Commands:
 *   /ffaopen [format]   - Host opens a lobby in the current room (default: Gen 9 Mass FFA Random Battle)
 *   /ffajoin            - Join the open lobby in this room
 *   /ffaleave           - Leave the lobby you joined
 *   /ffakick <user>     - Host removes a player from the lobby
 *   /ffastart           - Host launches the battle (min 3 players, max 100)
 *   /ffacancel          - Host cancels the lobby
 *   /ffastatus          - Show current lobby members
 */

'use strict';

const FFA_MAX_PLAYERS = 4;
const FFA_MIN_PLAYERS = 4;
const FFA_DEFAULT_FORMAT = 'gen9massffarandombattle';

interface FFALobby {
	hostId: ID;
	hostName: string;
	format: string;
	players: Map<ID, string>; // id -> name
	roomId: RoomID;
}

/** roomid -> active lobby */
const lobbies = new Map<RoomID, FFALobby>();

function getLobbyHTML(lobby: FFALobby): string {
	const playerList = [...lobby.players.values()]
		.map(name => Chat.escapeHTML(name))
		.join(', ');
	return (
		`<div class="broadcast-blue">` +
		`<strong>FFA Lobby</strong> &mdash; Format: <em>${Chat.escapeHTML(Dex.formats.get(lobby.format).name)}</em><br />` +
		`Host: <strong>${Chat.escapeHTML(lobby.hostName)}</strong> &mdash; ` +
		`Players (${lobby.players.size}/${FFA_MAX_PLAYERS}): ${playerList || '<em>none yet</em>'}<br />` +
		`Join with <code>/ffajoin</code> &bull; Start with <code>/ffastart</code> (host only)` +
		`</div>`
	);
}

export const commands: Chat.ChatCommands = {
	ffaopen(target, room, user) {
		if (!room) return this.requiresRoom();
		this.checkChat();
		if (lobbies.has(room.roomid)) {
			return this.errorReply(`There is already an open FFA lobby in this room. Use /ffacancel first.`);
		}

		const formatId = toID(target) || FFA_DEFAULT_FORMAT;
		const format = Dex.formats.get(formatId);
		if (!format.exists) {
			return this.errorReply(`Unknown format: ${target || FFA_DEFAULT_FORMAT}`);
		}
		if (format.gameType !== 'freeforall') {
			return this.errorReply(`${format.name} is not a free-for-all format.`);
		}

		const lobby: FFALobby = {
			hostId: user.id,
			hostName: user.name,
			format: format.id,
			players: new Map([[user.id, user.name]]),
			roomId: room.roomid,
		};
		lobbies.set(room.roomid, lobby);
		room.add(`|html|${getLobbyHTML(lobby)}`).update();
		this.modlog('FFAOPEN', null, `format: ${format.name}`);
	},

	ffajoin(target, room, user) {
		if (!room) return this.requiresRoom();
		this.checkChat();
		const lobby = lobbies.get(room.roomid);
		if (!lobby) return this.errorReply(`There is no open FFA lobby in this room.`);
		if (lobby.players.has(user.id)) return this.errorReply(`You are already in this lobby.`);
		if (lobby.players.size >= FFA_MAX_PLAYERS) {
			return this.errorReply(`This lobby is full (${FFA_MAX_PLAYERS} players).`);
		}
		lobby.players.set(user.id, user.name);
		room.add(`|html|${getLobbyHTML(lobby)}`).update();
	},

	ffaleave(target, room, user) {
		if (!room) return this.requiresRoom();
		const lobby = lobbies.get(room.roomid);
		if (!lobby) return this.errorReply(`There is no open FFA lobby in this room.`);
		if (!lobby.players.has(user.id)) return this.errorReply(`You are not in this lobby.`);
		if (lobby.hostId === user.id) {
			return this.errorReply(`Hosts cannot leave their own lobby. Use /ffacancel to close it.`);
		}
		lobby.players.delete(user.id);
		room.add(`|html|${getLobbyHTML(lobby)}`).update();
	},

	ffakick(target, room, user) {
		if (!room) return this.requiresRoom();
		const lobby = lobbies.get(room.roomid);
		if (!lobby) return this.errorReply(`There is no open FFA lobby in this room.`);
		if (lobby.hostId !== user.id && !this.can('mute', null, room)) return false;
		const targetId = toID(target);
		if (!targetId) return this.parse('/help ffakick');
		if (!lobby.players.has(targetId)) return this.errorReply(`${target} is not in this lobby.`);
		if (targetId === lobby.hostId) return this.errorReply(`Cannot kick the host.`);
		const name = lobby.players.get(targetId)!;
		lobby.players.delete(targetId);
		room.add(`|html|${getLobbyHTML(lobby)}`).update();
		this.modlog('FFAKICK', targetId, `from FFA lobby`);
		this.sendReply(`${name} was removed from the lobby.`);
	},

	ffastart(target, room, user) {
		if (!room) return this.requiresRoom();
		const lobby = lobbies.get(room.roomid);
		if (!lobby) return this.errorReply(`There is no open FFA lobby in this room.`);
		if (lobby.hostId !== user.id && !this.can('mute', null, room)) return false;

		if (lobby.players.size < FFA_MIN_PLAYERS) {
			return this.errorReply(`Need at least ${FFA_MIN_PLAYERS} players to start (have ${lobby.players.size}).`);
		}

		const format = Dex.formats.get(lobby.format);
		const playerCount = lobby.players.size;

		// Build the player list; Users that went offline get a guest slot.
		const players: RoomBattlePlayerOptions[] = [];
		for (const [id, name] of lobby.players) {
			const u = Users.get(id);
			players.push({ user: u || name, name } as any);
		}

		lobbies.delete(room.roomid);

		try {
			const newRoom = Rooms.createBattle({
				format: lobby.format,
				players,
				playerCount,
			} as any);
			room.add(`|html|<div class="broadcast-green"><strong>FFA started!</strong> ` +
				`<a href="/${newRoom?.roomid}">${playerCount}-player ${format.name}</a></div>`).update();
			this.modlog('FFASTART', null, `${playerCount} players`);
		} catch (err: any) {
			room.add(`|error|Failed to create FFA battle: ${err.message}`).update();
		}
	},

	ffacancel(target, room, user) {
		if (!room) return this.requiresRoom();
		const lobby = lobbies.get(room.roomid);
		if (!lobby) return this.errorReply(`There is no open FFA lobby in this room.`);
		if (lobby.hostId !== user.id && !this.can('mute', null, room)) return false;
		lobbies.delete(room.roomid);
		room.add(`|html|<div class="broadcast-red"><strong>FFA lobby cancelled by ${Chat.escapeHTML(user.name)}.</strong></div>`).update();
		this.modlog('FFACANCEL');
	},

	ffastatus(target, room, user) {
		if (!room) return this.requiresRoom();
		const lobby = lobbies.get(room.roomid);
		if (!lobby) return this.sendReply(`No open FFA lobby in this room.`);
		this.sendReplyBox(getLobbyHTML(lobby));
	},

	ffahelp() {
		return this.sendReplyBox(
			`<strong>FFA Lobby commands:</strong><br />` +
			`<code>/ffaopen [format]</code> &mdash; Open a lobby (default: Mass FFA Random Battle)<br />` +
			`<code>/ffajoin</code> &mdash; Join the open lobby<br />` +
			`<code>/ffaleave</code> &mdash; Leave the lobby<br />` +
			`<code>/ffakick &lt;user&gt;</code> &mdash; Kick a player (host/staff only)<br />` +
			`<code>/ffastart</code> &mdash; Launch the battle (host/staff only, min ${FFA_MIN_PLAYERS} players)<br />` +
			`<code>/ffacancel</code> &mdash; Cancel the lobby (host/staff only)<br />` +
			`<code>/ffastatus</code> &mdash; Show lobby status`
		);
	},
};
