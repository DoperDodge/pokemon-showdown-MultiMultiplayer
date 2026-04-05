'use strict';

var http = require('http');
var PORT = parseInt(process.env.PORT || '3000', 10);
var GAME_SERVER_URL = (process.env.GAME_SERVER_URL || '').replace(/\/$/, '');

function getGameHost() {
	if (!GAME_SERVER_URL) return 'localhost';
	return new URL(GAME_SERVER_URL).hostname;
}
function getGamePort() {
	if (!GAME_SERVER_URL) return 8000;
	return parseInt(new URL(GAME_SERVER_URL).port, 10) || 443;
}

var CDN = 'https://play.pokemonshowdown.com';

function makeConfigJs() {
	var host = getGameHost();
	var port = getGamePort();
	return [
		'var Config = Config || {};',
		'Config.defaultserver = {',
		'  id: "multimultiplayer",',
		'  host: "' + host + '",',
		'  port: ' + port + ',',
		'  httpport: ' + port + ',',
		'  registered: false',
		'};',
		'Config.routes = {',
		'  root: "pokemonshowdown.com",',
		'  client: "play.pokemonshowdown.com",',
		'  dex: "dex.pokemonshowdown.com",',
		'  replays: "replay.pokemonshowdown.com",',
		'  users: "pokemonshowdown.com/users",',
		'  teams: "teams.pokemonshowdown.com"',
		'};',
		'Config.whitelist = ["wikipedia.org"];',
		'Config.bannedHosts = ["cool.jit.su"];',
	].join('\n');
}

function makeIndexHtml() {
	var battleJs = GAME_SERVER_URL
		? GAME_SERVER_URL + '/js/battle.js'
		: CDN + '/js/battle.js';

	var lines = [
		'<!DOCTYPE html>',
		'<meta charset="UTF-8">',
		'<title>Showdown!</title>',
		'<link rel="stylesheet" href="' + CDN + '/style/battle.css">',
		'<link rel="stylesheet" href="' + CDN + '/style/client.css">',
		'<link rel="stylesheet" href="' + CDN + '/style/sim-types.css">',
		'<link rel="stylesheet" href="' + CDN + '/style/utilichart.css">',
		'<link rel="stylesheet" href="' + CDN + '/style/font-awesome.css">',
		'<div id="header" class="header">',
		'<img class="logo" src="' + CDN + '/pokemonshowdownbeta.png" alt="Pokemon Showdown" width="146" height="44">',
		'<div class="maintabbarbottom"></div>',
		'</div>',
		'<div class="ps-room scrollable" id="mainmenu"><div class="mainmenuwrapper">',
		'<div class="leftmenu">',
		'<div class="mainmenu"><div id="loading-message" class="mainmessage">Initializing...</div></div>',
		'</div>',
		'<div class="rightmenu"></div>',
		'<div class="mainmenufooter"><div class="bgcredit"></div>',
		'<small><a href="https://dex.pokemonshowdown.com/">Pokedex</a> | <a href="https://replay.pokemonshowdown.com/">Replays</a></small>',
		'</div>',
		'</div></div>',
		'<script src="/config/config.js"></script>',
		'<script src="' + CDN + '/js/lib/jquery-2.2.4.min.js"></script>',
		'<script src="' + CDN + '/js/lib/jquery-cookie.js"></script>',
		'<script src="' + CDN + '/js/lib/autoresize.jquery.min.js"></script>',
		'<script src="' + CDN + '/js/battle-sound.js"></script>',
		'<script src="' + CDN + '/js/lib/html-css-sanitizer-minified.js"></script>',
		'<script src="' + CDN + '/js/lib/lodash.core.js"></script>',
		'<script src="' + CDN + '/js/lib/backbone.js"></script>',
		'<script src="' + CDN + '/js/lib/d3.v3.min.js"></script>',
		'<script src="' + CDN + '/js/battledata.js"></script>',
		'<script src="' + CDN + '/js/storage.js"></script>',
		'<script src="' + CDN + '/data/pokedex-mini.js"></script>',
		'<script src="' + CDN + '/data/typechart.js"></script>',
		'<script src="' + battleJs + '"></script>',
		'<script src="' + CDN + '/js/lib/sockjs-1.4.0-nwjsfix.min.js"></script>',
		'<script src="' + CDN + '/js/lib/color-thief.min.js"></script>',
		'<script src="' + CDN + '/data/commands.js"></script>',
		'<script src="' + CDN + '/js/client.js"></script>',
		'<script src="' + CDN + '/js/client-topbar.js"></script>',
		'<script src="' + CDN + '/js/client-mainmenu.js"></script>',
		'<script src="' + CDN + '/js/client-teambuilder.js"></script>',
		'<script src="' + CDN + '/js/client-ladder.js"></script>',
		'<script src="' + CDN + '/js/client-chat.js"></script>',
		'<script src="' + CDN + '/js/client-chat-tournament.js"></script>',
		'<script src="' + CDN + '/js/battle-tooltips.js"></script>',
		'<script src="' + CDN + '/js/client-battle.js"></script>',
		'<script src="' + CDN + '/js/client-rooms.js"></script>',
		'<script src="' + CDN + '/data/graphics.js"></script>',
		'<script>var app; if(self===top){app=new App();}',
		'else{document.getElementById("loading-message").textContent="Please visit Showdown directly.";top.location=self.location;}</script>',
		'<script src="' + CDN + '/data/pokedex.js" async></script>',
		'<script src="' + CDN + '/data/moves.js" async></script>',
		'<script src="' + CDN + '/data/items.js" async></script>',
		'<script src="' + CDN + '/data/abilities.js" async></script>',
		'<script src="' + CDN + '/data/search-index.js" async></script>',
		'<script src="' + CDN + '/data/teambuilder-tables.js" async></script>',
		'<script src="' + CDN + '/js/battle-dex-search.js" async></script>',
		'<script src="' + CDN + '/js/search.js" async></script>',
		'<script src="' + CDN + '/data/aliases.js" async></script>',
	];
	return lines.join('\n');
}

var indexHtml = makeIndexHtml();
var configJs = makeConfigJs();

var server = http.createServer(function(req, res) {
	var urlPath = (req.url || '/').split('?')[0].split('#')[0];
	if (urlPath === '/config/config.js') {
		res.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache'});
		res.end(configJs);
		return;
	}
	res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'});
	res.end(indexHtml);
});

server.listen(PORT, function() {
	console.log('PS client serving on port ' + PORT);
});
