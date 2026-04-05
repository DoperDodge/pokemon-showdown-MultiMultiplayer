var Config = Config || {};

// Connect back to whichever server is hosting this page.
(function () {
	var hostname = window.location.hostname;
	var port = parseInt(window.location.port, 10) ||
		(window.location.protocol === 'https:' ? 443 : 80);
	Config.defaultserver = {
		id: 'custom',
		host: hostname,
		port: port,
		httpport: port === 443 ? 8000 : port,
		registered: false,
	};
})();

// Keep all asset URLs pointing at the official CDN.
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
