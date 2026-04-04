/** @type {import('../../play.pokemonshowdown.com/src/client-main').PSConfig} */
var Config = Config || {};

Config.version = "0";

Config.bannedHosts = [];
Config.whitelist = ['wikipedia.org'];

// Dynamically connect back to whichever server is hosting this page.
Config.defaultserver = {
	id: 'multimultiplayer',
	host: window.location.hostname,
	port: parseInt(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80),
	httpport: parseInt(window.location.port) || 8000,
	altport: 80,
	registered: false,
};

Config.routes = {
	root: window.location.hostname,
	client: window.location.hostname,
	dex: 'dex.pokemonshowdown.com',
	replays: 'replay.pokemonshowdown.com',
	users: 'pokemonshowdown.com/users',
	teams: 'teams.pokemonshowdown.com',
};
