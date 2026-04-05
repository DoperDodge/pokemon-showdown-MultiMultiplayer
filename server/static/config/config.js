// Pokemon Showdown client config
// Connects to this same server (auto-detected from window.location)
var Config = Config || {};

Config.defaultserver = {
	id: 'showdown',
	host: window.location.hostname,
	port: parseInt(window.location.port, 10) || (window.location.protocol === 'https:' ? 443 : 80),
	httpport: parseInt(window.location.port, 10) || (window.location.protocol === 'https:' ? 443 : 80),
	registered: false,
};

Config.routes = {
	root: 'pokemonshowdown.com',
	client: 'play.pokemonshowdown.com',
	dex: 'dex.pokemonshowdown.com',
	replays: 'replay.pokemonshowdown.com',
	users: 'pokemonshowdown.com/users',
	teams: 'teams.pokemonshowdown.com',
};

Config.whitelist = ['wikipedia.org'];
Config.bannedHosts = ['cool.jit.su', 'pokeball-nixonserver.rhcloud.com'];
