<?php
// vim: set ai ts=4 sw=4 ft=php:
/**
 * Zeus Voice Plane — a read-only view of the voice plane, inside the PBX.
 *
 * WHY THIS EXISTS
 * ---------------
 * The voice plane has one screen (the portal's `/dashboard/voice`) and two doors:
 * the portal itself, and — from the PBX side — a link in the sign-in banner of the
 * reverse proxy in front of FreePBX. That banner was the module-free way in,
 * because a FreePBX **admin-menu entry is only expressible as a module**: the
 * framework builds its menu from each installed module's `module.xml`
 * `<menuitems>` (FreePBX 17, `admin/libraries/modulefunctions.class.php`), and
 * there is no user-defined menu store to write instead. This is that module, and
 * it is deliberately the smallest thing that could be one: a page, no settings,
 * no writes.
 *
 * NOT A SECOND WRITER — the rule that shapes everything below
 * ----------------------------------------------------------
 * Two products write this PBX (Zeus's `pbx/ava_routes.py` and Capstone's
 * `scripts/sync_dograh_routes.py`), and the failure that cost the most was not a
 * bad route but a *disagreement*: every DID unwired while both products believed
 * the numbers were routed (`pbx/README.md`, "a route that points somewhere else
 * still answers a call, just as the wrong thing"). A control panel that could
 * edit routing would be a third opinion, so this one cannot:
 *
 *   * there is no `doConfigPageInit()`, so the framework has no POST path into
 *     this module and the page has no form;
 *   * every request it makes is a GET (the portal's plan, Asterisk's ARI channel
 *     list); nothing here is an API client for a write endpoint;
 *   * the only filesystem read is `/etc/asterisk/ari.conf`, for the credentials
 *     the portal already uses.
 *
 * What it shows instead is the *disagreement*, which is the thing nobody could
 * see before: the plan next to the route table, per DID, with the mismatch named.
 *
 * THE TWO HALVES, AND WHY BOTH
 * ----------------------------
 * 1. **The plan** — `GET {portal}/api/admin/voice-routing` with the same
 *    `PBX_SYNC_TOKEN` bearer the `zeus-pbx-sync` timer uses, so this page and the
 *    rendered `[zeus-ai-accounts]` context are reading the same authority. It is
 *    per-DID: agent, provider, audio profile, whether the Capstone hand-off is
 *    entitled, and which interview workflow the line reaches.
 * 2. **The routes** — FreePBX's own `incoming` table, which is what actually
 *    answers a call. A DID the plan names with no route, or a route pointing
 *    somewhere that is not the voice plane, is the exact state a plan-only view
 *    reports as healthy.
 *
 * `classify()` is the join, and it is pure so it can be tested without a PBX
 * (`tests/reconcile_test.php`, run by CI). `summarise()` is the counts.
 *
 * CONFIGURATION
 * -------------
 * Nothing is typed into the GUI. The installer writes `config.json` beside this
 * file (see `pbx/install-freepbx-voiceplane.py`), and environment variables win
 * over it — the module reads, it never stores.
 */

namespace FreePBX\modules;

use BMO;
use FreePBX_Helpers;

class Voiceplane extends FreePBX_Helpers implements BMO {

	/**
	 * The destinations that *are* the voice plane, as FreePBX stores them.
	 *
	 * `zeus-ai-router,s,1` is the Custom Destination the platform's own route
	 * writer registers for every platform DID (`pbx/ava_routes.py` → `ROUTER`,
	 * and the `customappsreg` registry row that names it), and `dograh-inbound,`
	 * is Capstone's per-agent context. A prefix list rather than an exact set,
	 * because the agent contexts carry the extension in the destination
	 * (`dograh-inbound,8007,1`) and new ones appear without this file changing.
	 *
	 * Anything else is *somebody else's phone service* and is counted, not
	 * judged — a ring group, a partner's number and a pattern route are not
	 * this module's business (`pbx/ava_routes.py` leaves them alone for the same
	 * reason).
	 */
	public const VOICE_PLANE_DESTINATIONS = array('zeus-ai-router,s,1', 'dograh-inbound,');

	/** Where Asterisk serves ARI, and whose credentials to use. */
	public const ARI_DEFAULT_URL = 'http://127.0.0.1:8088/ari';
	public const ARI_DEFAULT_USER = 'pbxportal';
	public const ARI_CONFIG = '/etc/asterisk/ari.conf';

	public function __construct($freepbx = null) {
		$this->FreePBX = $freepbx;
	}

	public function install() {}
	public function uninstall() {}

	// ── configuration (read-only) ────────────────────────────────────────────

	/**
	 * The settings this page runs on, lowest precedence first: built-in defaults,
	 * then `config.json` beside this class (written by the installer), then the
	 * environment. Environment last so a stack can point the page at a different
	 * portal without rewriting a file inside a container.
	 */
	public function settings() : array {
		static $cache = null;
		if ($cache !== null) {
			return $cache;
		}
		$settings = array(
			'portal_url' => '',
			'pbx_sync_token' => '',
			'verify_tls' => true,
			'timeout_seconds' => 5,
			'ari_url' => self::ARI_DEFAULT_URL,
			'ari_user' => self::ARI_DEFAULT_USER,
			'ari_config' => self::ARI_CONFIG,
			'voice_plane_destinations' => self::VOICE_PLANE_DESTINATIONS,
		);

		$file = __DIR__ . '/config.json';
		if (is_readable($file)) {
			$decoded = json_decode((string) @file_get_contents($file), true);
			if (is_array($decoded)) {
				$settings = array_merge($settings, array_intersect_key($decoded, $settings));
			}
		}

		$env = array(
			'portal_url' => 'VOICEPLANE_PORTAL_URL',
			'pbx_sync_token' => 'VOICEPLANE_PBX_SYNC_TOKEN',
			'ari_url' => 'VOICEPLANE_ARI_URL',
			'ari_user' => 'VOICEPLANE_ARI_USER',
			'ari_config' => 'VOICEPLANE_ARI_CONFIG',
		);
		foreach ($env as $key => $name) {
			$value = getenv($name);
			if (is_string($value) && $value !== '') {
				$settings[$key] = $value;
			}
		}

		$settings['portal_url'] = rtrim((string) $settings['portal_url'], '/');
		$settings['ari_url'] = rtrim((string) $settings['ari_url'], '/');
		return $cache = $settings;
	}

	/** Whether the page can reach a portal at all — the plan panel's whole state. */
	public function portalConfigured() : bool {
		$settings = $this->settings();
		return $settings['portal_url'] !== '' && $settings['pbx_sync_token'] !== '';
	}

	// ── the plan (the portal's own answer) ───────────────────────────────────

	/**
	 * `GET /api/admin/voice-routing` — one entry per active DID, the same
	 * document `bootstrap-zeus-pbx.sh` renders `[zeus-ai-accounts]` from.
	 *
	 * Never throws: a page that dies because a portal is down hides the half of
	 * the answer this PBX already holds, which is the half an operator needs
	 * most when something is wrong. The failure is returned as data and shown.
	 */
	public function plan() : array {
		if (!$this->portalConfigured()) {
			return array('ok' => false, 'reason' => 'not-configured');
		}
		$settings = $this->settings();
		$response = $this->httpGet(
			$settings['portal_url'] . '/api/admin/voice-routing',
			array('Authorization: Bearer ' . $settings['pbx_sync_token'])
		);
		if (!$response['ok']) {
			return array('ok' => false, 'reason' => 'unreachable', 'detail' => $response['error']);
		}
		if ((int) $response['status'] === 401 || (int) $response['status'] === 403) {
			return array('ok' => false, 'reason' => 'unauthorised', 'detail' => $response['error']);
		}
		if ((int) $response['status'] !== 200) {
			// 503 is the portal refusing to publish at all (an indecisive
			// entitlement gate) — a routing verdict in its own right, not an
			// outage, so it is named rather than flattened into "error".
			return array('ok' => false, 'reason' => 'refused', 'status' => (int) $response['status'],
				'detail' => $response['error']);
		}
		$plan = json_decode((string) $response['body'], true);
		if (!is_array($plan) || !isset($plan['accounts']) || !is_array($plan['accounts'])) {
			return array('ok' => false, 'reason' => 'unreadable', 'detail' => 'expected an `accounts` array');
		}
		$plan['ok'] = true;
		return $plan;
	}

	// ── the routes (what this PBX actually answers with) ─────────────────────

	/**
	 * FreePBX's own inbound-route table. This is the authority on what a call to
	 * a DID does, and it is deliberately read from the *framework's* database
	 * rather than re-derived from the rendered dialplan: the dialplan is a
	 * build product, and this page exists to compare intent against it.
	 */
	public function inboundRoutes() : array {
		try {
			$rows = $this->FreePBX->Database
				->query('SELECT extension, cidnum, description, destination FROM incoming ORDER BY extension')
				->fetchAll(\PDO::FETCH_ASSOC);
		} catch (\Exception $e) {
			return array();
		}
		return is_array($rows) ? $rows : array();
	}

	// ── the live half ────────────────────────────────────────────────────────

	/**
	 * Live channels, straight from Asterisk's ARI (`GET /ari/channels`) with the
	 * credentials the portal's own extension API already authenticates with.
	 *
	 * Read-only by construction at this end — the only method used is GET — and
	 * the page says so rather than implying it could hang a call up.
	 */
	public function liveChannels() : array {
		$settings = $this->settings();
		$credentials = $this->ariCredentials($settings['ari_user'], $settings['ari_config']);
		if ($credentials === null) {
			return array('ok' => false, 'reason' => 'no-credentials');
		}
		$response = $this->httpGet($settings['ari_url'] . '/channels', array(),
			$credentials['username'] . ':' . $credentials['password']);
		if (!$response['ok']) {
			return array('ok' => false, 'reason' => 'unreachable', 'detail' => $response['error']);
		}
		if ((int) $response['status'] === 401) {
			return array('ok' => false, 'reason' => 'unauthorised');
		}
		if ((int) $response['status'] !== 200) {
			return array('ok' => false, 'reason' => 'refused', 'status' => (int) $response['status']);
		}
		$channels = json_decode((string) $response['body'], true);
		return array('ok' => true, 'channels' => is_array($channels) ? $channels : array());
	}

	/**
	 * The ARI credentials for one user, read from `ari.conf` — or null.
	 *
	 * **The section name is the username.** That is Asterisk's own rule (an ARI
	 * section is a user: `[pbxportal]` + `password = …`), and it is not a detail
	 * this page can assume away: measured on the live PBX, the `[pbxportal]`
	 * section carries a `password`, a `password_format` and **no `username` key at
	 * all**, so a parser that waits for one reports "no credentials" on a PBX
	 * whose credentials are right there. An explicit `username =` line still
	 * wins when a config has one.
	 *
	 * Public so the parsing is testable against a fixture file rather than against
	 * whatever a given PBX happens to have written.
	 */
	public function ariCredentials(string $user, string $config = '') : ?array {
		$config = $config !== '' ? $config : self::ARI_CONFIG;
		if (!is_readable($config)) {
			return null;
		}
		$section = null;
		$username = null;
		$password = null;
		foreach (explode("\n", (string) @file_get_contents($config)) as $line) {
			$line = trim($line);
			if ($line === '' || $line[0] === ';' || $line[0] === '#') {
				continue;
			}
			if ($line[0] === '[') {
				$section = trim($line, "[] \t");
				// Entering the requested section: the section name is the user.
				if ($section === $user) {
					$username = $user;
				}
				continue;
			}
			if ($section !== $user) {
				continue;
			}
			$parts = explode('=', $line, 2);
			if (count($parts) !== 2) {
				continue;
			}
			$key = strtolower(trim($parts[0]));
			if ($key === 'username') {
				$username = trim($parts[1]);
			} elseif ($key === 'password') {
				$password = trim($parts[1]);
			}
		}
		if ($username === null || $password === null || $username === '' || $password === '') {
			return null;
		}
		return array('username' => $username, 'password' => $password);
	}

	/**
	 * One GET, with the timeout the settings ask for. Kept in one place so the
	 * "this module only ever GETs" claim is verifiable at a glance.
	 */
	private function httpGet(string $url, array $headers = array(), string $basic = '') : array {
		$settings = $this->settings();
		$handle = curl_init($url);
		curl_setopt_array($handle, array(
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_TIMEOUT => max(1, (int) $settings['timeout_seconds']),
			CURLOPT_CONNECTTIMEOUT => max(1, (int) $settings['timeout_seconds']),
			CURLOPT_HTTPHEADER => array_merge(array('Accept: application/json'), $headers),
			CURLOPT_SSL_VERIFYPEER => (bool) $settings['verify_tls'],
			CURLOPT_SSL_VERIFYHOST => $settings['verify_tls'] ? 2 : 0,
		));
		if ($basic !== '') {
			curl_setopt($handle, CURLOPT_USERPWD, $basic);
		}
		$body = curl_exec($handle);
		$error = curl_error($handle);
		$status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
		curl_close($handle);
		if ($body === false) {
			return array('ok' => false, 'status' => $status, 'error' => $error !== '' ? $error : 'request failed');
		}
		if ($status >= 400) {
			return array('ok' => false, 'status' => $status, 'body' => $body,
				'error' => 'HTTP ' . $status);
		}
		return array('ok' => true, 'status' => $status, 'body' => $body, 'error' => '');
	}

	// ── the join (pure, and tested) ──────────────────────────────────────────

	/**
	 * A DID, as opposed to an internal extension.
	 *
	 * The distinction is load-bearing: the route table carries both (`8007` is an
	 * agent extension, `4132643964` is a DID), and only DIDs are compared against
	 * a plan. Judging an extension route against billing would invent a finding
	 * every time a new agent extension was added.
	 */
	public static function isDid(string $extension) : bool {
		return (bool) preg_match('/^[0-9]{7,15}$/', trim($extension));
	}

	/**
	 * The plan and the route table, joined per DID.
	 *
	 * One row per DID either side names, so nothing is silently dropped in
	 * either direction, with a verdict that says who disagrees:
	 *
	 *   ok             the plan names it and this PBX routes it into the voice plane
	 *   unrouted       the plan names it; this PBX has no inbound route for it
	 *   elsewhere      the plan names it; the route points somewhere that is not
	 *                  the voice plane — it still answers a call, as the wrong thing
	 *   unplanned      this PBX routes it into the voice plane; the plan does not
	 *                  name it. A call arrives and is handled by an agent that is
	 *                  not billed for it; the plan is the authority, so this is a
	 *                  finding rather than a pass
	 *   other-service  a DID route that is neither the voice plane nor the plan —
	 *                  somebody else's phone service, counted and left alone
	 *
	 * @param array $plan   the `accounts` half of GET /api/admin/voice-routing
	 * @param array $routes rows from `incoming` (extension, cidnum, description, destination)
	 * @param array $destinations destination prefixes that are the voice plane
	 */
	public static function classify(array $plan, array $routes, array $destinations = self::VOICE_PLANE_DESTINATIONS) : array {
		$byDid = array();
		foreach ($plan as $account) {
			$did = isset($account['did']) ? trim((string) $account['did']) : '';
			if ($did === '') {
				continue;
			}
			$byDid[$did]['plan'] = $account;
		}
		foreach ($routes as $route) {
			$extension = isset($route['extension']) ? trim((string) $route['extension']) : '';
			if (!self::isDid($extension)) {
				continue;
			}
			$byDid[$extension]['routes'][] = $route;
		}

		// PHP turns a numeric-string array key into an integer, so a DID has to be
		// cast back on the way out: every caller compares DIDs as strings, and an
		// `int` in the row compares equal to nothing.
		ksort($byDid, SORT_NATURAL);
		$rows = array();
		foreach ($byDid as $did => $halves) {
			$did = (string) $did;
			$account = $halves['plan'] ?? null;
			$didRoutes = $halves['routes'] ?? array();
			$route = $didRoutes[0] ?? null;
			$destination = $route !== null ? trim((string) ($route['destination'] ?? '')) : '';
			$onVoicePlane = $destination !== '' && self::isVoicePlane($destination, $destinations);

			if ($account !== null && $route === null) {
				$verdict = 'unrouted';
			} elseif ($account !== null && $onVoicePlane) {
				$verdict = 'ok';
			} elseif ($account !== null) {
				$verdict = 'elsewhere';
			} elseif ($onVoicePlane) {
				$verdict = 'unplanned';
			} else {
				$verdict = 'other-service';
			}

			$rows[] = array(
				'did' => $did,
				'plan' => $account,
				'route' => $route,
				'route_count' => count($didRoutes),
				'destination' => $destination,
				'on_voice_plane' => $onVoicePlane,
				'verdict' => $verdict,
			);
		}
		return $rows;
	}

	/** Is this destination one of the ones that *are* the voice plane? */
	public static function isVoicePlane(string $destination, array $destinations = self::VOICE_PLANE_DESTINATIONS) : bool {
		foreach ($destinations as $prefix) {
			if ($prefix !== '' && strpos($destination, $prefix) === 0) {
				return true;
			}
		}
		return false;
	}

	/** The counts, so the page can lead with the one line that matters. */
	public static function summarise(array $rows) : array {
		$counts = array('total' => 0, 'ok' => 0, 'unrouted' => 0, 'elsewhere' => 0,
			'unplanned' => 0, 'other-service' => 0);
		foreach ($rows as $row) {
			$counts['total']++;
			$verdict = $row['verdict'] ?? '';
			if (isset($counts[$verdict])) {
				$counts[$verdict]++;
			}
		}
		$counts['findings'] = $counts['unrouted'] + $counts['elsewhere'] + $counts['unplanned'];
		return $counts;
	}

	/** Internal routes (non-DID extensions) — listed so their absence is a fact, not a guess. */
	public static function internalRoutes(array $routes) : array {
		$internal = array();
		foreach ($routes as $route) {
			if (!self::isDid((string) ($route['extension'] ?? ''))) {
				$internal[] = $route;
			}
		}
		return $internal;
	}

	// ── what the page renders ────────────────────────────────────────────────

	/** Everything the view needs, in one array — the page does no work of its own. */
	public function report() : array {
		$settings = $this->settings();
		$plan = $this->plan();
		$routes = $this->inboundRoutes();
		$accounts = ($plan['ok'] ?? false) && isset($plan['accounts']) ? $plan['accounts'] : array();
		$rows = self::classify($accounts, $routes, (array) $settings['voice_plane_destinations']);
		return array(
			'settings' => $settings,
			'portal_configured' => $this->portalConfigured(),
			'plan' => $plan,
			'rows' => $rows,
			'counts' => self::summarise($rows),
			'internal' => self::internalRoutes($routes),
			'channels' => $this->liveChannels(),
			'voice_screen_url' => $settings['portal_url'] . '/dashboard/voice',
		);
	}
}
