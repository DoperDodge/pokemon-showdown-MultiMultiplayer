'use strict';

/**
 * Pokemon Showdown server configuration
 *
 * This file is loaded at startup and overrides the defaults in config-example.js.
 * Environment variables are used here so the same file works both locally and
 * on Railway (or any other cloud host that injects settings via the environment).
 *
 * Quick-start for Railway:
 *   1. Deploy this repo on Railway — it picks up PORT automatically.
 *   2. Set RAILWAY_ENVIRONMENT=true in your Railway service variables so that
 *      trusted-proxy detection is enabled.
 *   3. Optionally set SERVER_NAME to a short ID for your server (no spaces).
 *
 * Quick-start for local development:
 *   Run `node pokemon-showdown` — defaults to port 8000.
 */

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/**
 * The port to listen on.
 * Railway (and most PaaS providers) inject PORT via the environment.
 * The cloud-env library (already a dependency) also reads it, but setting it
 * here makes it explicit and avoids any ordering issues.
 */
exports.port = parseInt(process.env.PORT || '8000', 10);

/**
 * Bind to all interfaces so Railway's internal router can reach the process.
 */
exports.bindaddress = '0.0.0.0';

// ---------------------------------------------------------------------------
// Reverse-proxy / trusted IPs
// ---------------------------------------------------------------------------

/**
 * Railway (and Heroku, Render, Fly, etc.) terminate TLS at a load-balancer
 * and forward the real client IP in the X-Forwarded-For header.  We need to
 * tell PS to trust that header, otherwise all users appear to come from the
 * proxy IP and get falsely duplicate-IP-matched.
 *
 * On Railway RAILWAY_ENVIRONMENT is set automatically.  Locally it is not,
 * so proxyip stays false and X-Forwarded-For is ignored (safer).
 *
 * '0.0.0.0/0' means "trust the header from any upstream".  This is safe
 * because Railway's edge already strips externally-supplied XFF headers
 * before they reach your service.
 */
exports.proxyip = process.env.RAILWAY_ENVIRONMENT ? ['0.0.0.0/0'] : false;

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

/**
 * A short, lower-case, no-spaces identifier for this server.
 * Shown in the client's server selector and used as a ladder namespace when
 * connecting to the main PS login server.
 * Default: 'showdown'
 */
exports.serverid = (process.env.SERVER_NAME || 'showdown').toLowerCase().replace(/[^a-z0-9-]/g, '');

// ---------------------------------------------------------------------------
// Stability / crash handling
// ---------------------------------------------------------------------------

/**
 * Keep the server alive after unexpected errors instead of crashing.
 * Recommended for production (Railway will restart the process anyway,
 * but this gives a softer landing and logs the error).
 */
exports.crashguard = true;

// ---------------------------------------------------------------------------
// Gameplay
// ---------------------------------------------------------------------------

/**
 * Report battle starts in the lobby room.
 * Turn off if you expect high traffic (>160 concurrent battles).
 */
exports.reportbattles = true;

/**
 * Allow players to offer / accept draws mid-battle.
 */
exports.allowrequestingties = true;

// ---------------------------------------------------------------------------
// Database (optional — only needed if you want persistent ladders/chat logs)
// ---------------------------------------------------------------------------

/**
 * Railway injects DATABASE_URL for PostgreSQL add-ons.
 * If it is present, enable the PostgreSQL ladder backend.
 * Otherwise fall back to the built-in local (file-based) ladder.
 *
 * To use SQLite instead of PostgreSQL, set USE_SQLITE=true.
 */
if (process.env.DATABASE_URL) {
	// Remote PostgreSQL ladder (stores ratings server-side like the main PS ladder)
	exports.remoteladder = false; // keep local ratings on this server
	exports.usesqlite = false;
	// PostgreSQL connection string is read automatically by the pg module via
	// DATABASE_URL — no extra config needed here.
} else if (process.env.USE_SQLITE === 'true') {
	exports.usesqlite = true;
}

// ---------------------------------------------------------------------------
// Development helpers
// ---------------------------------------------------------------------------

/**
 * Disable rate-limits when NODE_ENV=development so local testing is easier.
 * Never set this in production.
 */
if (process.env.NODE_ENV === 'development') {
	exports.nothrottle = true;
	exports.noipchecks = true;
}

// ---------------------------------------------------------------------------
// Client redirect
// ---------------------------------------------------------------------------

/**
 * If CLIENT_URL is set (e.g. https://your-client.up.railway.app), redirect
 * bare visits to the game server over to the separate PS client deployment.
 * This mirrors how psim.us works: server and client are on different domains
 * so the WebSocket connection is cross-origin and works correctly.
 *
 * Set CLIENT_URL in Railway → game-server service → Variables.
 */
if (process.env.CLIENT_URL) {
	const clientBase = process.env.CLIENT_URL.replace(/\/$/, '');
	exports.customhttpresponse = function (req, res) {
		// Only redirect the root and room paths, not API/asset requests.
		if (req.url && (req.url === '/' || /^\/[a-z0-9][a-z0-9-]*\/?(\?.*)?$/i.test(req.url))) {
			res.writeHead(302, { Location: clientBase + req.url });
			res.end();
			return true;
		}
		return false;
	};
}
