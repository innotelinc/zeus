<?php
/**
 * Tests for the voice-plane module's pure half, and for its one promise.
 *
 *   php pbx/freepbx-modules/voiceplane/tests/reconcile_test.php
 *
 * No FreePBX, no PBX and no network: the two base symbols the class needs are
 * stubbed below, so the join between a plan and a route table can be judged on
 * any machine with PHP — the same posture as `pbx/patch-freepbx-trunk-next-id.py`
 * ("the pure functions are unit-tested without a PBX").
 *
 * What is asserted, and why each one is not a style check:
 *
 *   * the verdicts, on the shapes this estate actually has (a DID routed to
 *     `zeus-ai-router,s,1`, an agent extension routed to `dograh-inbound,8007,1`,
 *     a number routed `from-did-direct,…`) — a plan-only view calls three of
 *     those four healthy;
 *   * that an extension is not a DID, which is what stops every new agent
 *     extension from reading as a routing finding;
 *   * that a route into the voice plane the plan does not name is a *finding*
 *     (the plan is the authority) while somebody else's phone service is not;
 *   * the counts, because the page leads with them;
 *   * and, structurally, that the module cannot write: no `doConfigPageInit()`
 *     for the framework to route a POST into, and no write verb in any request
 *     it makes. The read-only claim is the module's whole justification, so it
 *     is asserted rather than described.
 */

// ── stubs: the two symbols the module class extends/implements ──────────────
interface BMO {}
class FreePBX_Helpers
{
	public $FreePBX;
}

require_once __DIR__ . '/../Voiceplane.class.php';

use FreePBX\modules\Voiceplane;

$failures = 0;
$checks = 0;

function test(string $name, callable $body)
{
	global $failures, $checks;
	$checks++;
	try {
		$body();
		echo "  ok   {$name}\n";
	} catch (\Throwable $e) {
		$failures++;
		echo "  FAIL {$name}\n       {$e->getMessage()}\n";
	}
}

function assertSame($expected, $actual, string $what = 'value')
{
	if ($expected !== $actual) {
		throw new \Exception(sprintf('%s: expected %s, got %s',
			$what, var_export($expected, true), var_export($actual, true)));
	}
}

function assertTrue($actual, string $what = 'value')
{
	assertSame(true, $actual, $what);
}

function assertFalse($actual, string $what = 'value')
{
	assertSame(false, $actual, $what);
}

/**
 * The route rows, in the shapes this PBX really has (see `incoming` on the live
 * box): DIDs on the router, an agent extension on `dograh-inbound`, a number
 * sent straight to an extension, and one service that is nobody's voice plane.
 */
function routes(): array
{
	return array(
		array('extension' => '3025551002', 'cidnum' => '', 'description' => 'Zeus AI router (ava_routes)', 'destination' => 'zeus-ai-router,s,1'),
		array('extension' => '4132643964', 'cidnum' => '', 'description' => '', 'destination' => 'zeus-ai-router,s,1'),
		array('extension' => '4138808180', 'cidnum' => '', 'description' => '', 'destination' => 'from-did-direct,4132912045,1'),
		array('extension' => '5550001111', 'cidnum' => '', 'description' => 'Partner desk', 'destination' => 'ext-group,600,1'),
		array('extension' => '7745057135', 'cidnum' => '', 'description' => '', 'destination' => 'zeus-ai-router,s,1'),
		array('extension' => '8007', 'cidnum' => '', 'description' => 'Get Out The Vote Poll', 'destination' => 'dograh-inbound,8007,1'),
		array('extension' => '', 'cidnum' => '', 'description' => '', 'destination' => 'dograh-inbound,8003,1'),
	);
}

/**
 * The plan's shape, as `GET /api/admin/voice-routing` publishes it — one DID per
 * verdict, so a failure names the rule that broke rather than a fixture.
 */
function plan(): array
{
	return array(
		array('did' => '4132643964', 'account' => 'u1', 'agent' => 'reception', 'capstone_addon' => true, 'capstone_target' => 'interview', 'provider' => 'voipms'),
		array('did' => '4138808180', 'account' => 'u2', 'agent' => 'desk', 'capstone_addon' => false, 'provider' => 'cloudonix'),
		array('did' => '8579901777', 'account' => 'u3', 'agent' => 'outreach', 'capstone_addon' => true, 'capstone_target' => 'outreach'),
		array('did' => '9995551234', 'account' => 'u4', 'agent' => 'idle', 'capstone_addon' => false),
	);
}

function rowFor(array $rows, string $did): array
{
	foreach ($rows as $row) {
		if ($row['did'] === $did) {
			return $row;
		}
	}
	throw new \Exception("no row for {$did}");
}

echo "voiceplane module — pure half\n";

// ── what counts as a DID ────────────────────────────────────────────────────
test('a 10-digit number is a DID', function () {
	assertTrue(Voiceplane::isDid('4132643964'));
});

test('an agent extension is not a DID', function () {
	assertFalse(Voiceplane::isDid('8007'), '8007');
	assertFalse(Voiceplane::isDid('413'), '413');
	assertFalse(Voiceplane::isDid(''), 'empty');
});

test('surrounding whitespace does not change what a DID is', function () {
	assertTrue(Voiceplane::isDid(' 4132643964 '));
});

test('an implausibly long digit string is not a DID', function () {
	assertFalse(Voiceplane::isDid('1234567890123456'), '16 digits');
});

// ── the destinations that are the voice plane ───────────────────────────────
test('the router destination is the voice plane', function () {
	assertTrue(Voiceplane::isVoicePlane('zeus-ai-router,s,1'));
});

test('a dograh agent context is the voice plane, extension and all', function () {
	assertTrue(Voiceplane::isVoicePlane('dograh-inbound,8007,1'));
});

test('a direct-to-extension route is not the voice plane', function () {
	assertFalse(Voiceplane::isVoicePlane('from-did-direct,4132912045,1'));
	assertFalse(Voiceplane::isVoicePlane(''), 'empty');
});

// ── the join ────────────────────────────────────────────────────────────────
test('a planned DID routed to the router is ok', function () {
	assertSame('ok', rowFor(Voiceplane::classify(plan(), routes()), '4132643964')['verdict']);
});

test('a planned DID with no inbound route is a finding', function () {
	$row = rowFor(Voiceplane::classify(plan(), routes()), '8579901777');
	assertSame('unrouted', $row['verdict']);
	assertSame(null, $row['route'], 'route');
});

test('a planned DID routed somewhere else is a finding', function () {
	assertSame('elsewhere', rowFor(Voiceplane::classify(plan(), routes()), '4138808180')['verdict']);
});

test('a DID that reaches the voice plane without being in the plan is a finding', function () {
	$rows = Voiceplane::classify(plan(), routes());
	assertSame('unplanned', rowFor($rows, '3025551002')['verdict']);
	assertSame('unplanned', rowFor($rows, '7745057135')['verdict']);
});

test('a route into neither the plan nor the voice plane is somebody else\'s phone service', function () {
	$row = rowFor(Voiceplane::classify(plan(), routes()), '5550001111');
	assertSame('other-service', $row['verdict']);
	assertSame(false, $row['on_voice_plane'], 'on_voice_plane');
});

test('an extension route never becomes a DID row', function () {
	$rows = Voiceplane::classify(plan(), routes());
	foreach ($rows as $row) {
		if ($row['did'] === '8007') {
			throw new \Exception('an agent extension was judged against the plan');
		}
	}
	// The union of both sides: 3025551002, 4132643964, 4138808180, 5550001111,
	// 7745057135, 8579901777, 9995551234 — nothing dropped in either direction.
	assertSame(7, count($rows), 'rows');
});

test('a DID is a string in every row, whatever PHP made of the array key', function () {
	foreach (Voiceplane::classify(plan(), routes()) as $row) {
		assertTrue(is_string($row['did']), 'did type for ' . var_export($row['did'], true));
	}
});

test('the rows are ordered by DID', function () {
	$dids = array_column(Voiceplane::classify(plan(), routes()), 'did');
	$sorted = $dids;
	sort($sorted, SORT_NATURAL);
	assertSame($sorted, $dids);
});

test('a DID with two inbound routes is named, and the first is shown', function () {
	$routes = routes();
	$routes[] = array('extension' => '4132643964', 'cidnum' => '', 'description' => 'duplicate', 'destination' => 'app-blackhole,hangup,1');
	$row = rowFor(Voiceplane::classify(plan(), $routes), '4132643964');
	assertSame(2, $row['route_count'], 'route_count');
	assertSame('zeus-ai-router,s,1', $row['destination'], 'destination');
});

// ── the counts the page leads with ──────────────────────────────────────────
test('the summary counts the three findings and not the fourth', function () {
	$counts = Voiceplane::summarise(Voiceplane::classify(plan(), routes()));
	assertSame(1, $counts['ok'], 'ok');
	assertSame(2, $counts['unrouted'], 'unrouted');
	assertSame(1, $counts['elsewhere'], 'elsewhere');
	assertSame(2, $counts['unplanned'], 'unplanned');
	assertSame(1, $counts['other-service'], 'other-service');
	assertSame(5, $counts['findings'], 'findings');
	assertSame(7, $counts['total'], 'total');
});

test('an empty plan over an empty route table is not an error', function () {
	$counts = Voiceplane::summarise(Voiceplane::classify(array(), array()));
	assertSame(0, $counts['total'], 'total');
	assertSame(0, $counts['findings'], 'findings');
});

// ── the internal half ───────────────────────────────────────────────────────
test('internal routes are the non-DID rows', function () {
	$internal = Voiceplane::internalRoutes(routes());
	assertSame(2, count($internal), 'internal count');
	assertSame('8007', $internal[0]['extension'], 'first extension');
});

// ── ARI credentials, against a fixture ─────────────────────────────────────
// The rule that matters is Asterisk's own: a section is a user, so `[pbxportal]`
// with only a `password` key *is* the credentials. Measured on the live PBX,
// where a parser that waited for a `username` key read a correctly-configured
// ARI as "no credentials" — so the section's own shape is the fixture.
function ariFixture(string $content): string
{
	$path = tempnam(sys_get_temp_dir(), 'ari') . '.conf';
	file_put_contents($path, $content);
	return $path;
}

test('a section with only a password is a user, named by the section', function () {
	$path = ariFixture("[general]\nenabled = yes\n\n[pbxportal]\npassword = s3cr3t-her3\nread_only = no\npassword_format = plain\n");
	$credentials = (new Voiceplane(null))->ariCredentials('pbxportal', $path);
	unlink($path);
	assertSame('pbxportal', $credentials['username'], 'username');
	assertSame('s3cr3t-her3', $credentials['password'], 'password');
});

test('an explicit username key wins over the section name', function () {
	$path = ariFixture("[pbxportal]\nusername = portal-ari\npassword = other\n");
	$credentials = (new Voiceplane(null))->ariCredentials('pbxportal', $path);
	unlink($path);
	assertSame('portal-ari', $credentials['username'], 'username');
});

test('password_format is not read as the password', function () {
	$path = ariFixture("[pbxportal]\npassword_format = plain\npassword = real-secret\n");
	$credentials = (new Voiceplane(null))->ariCredentials('pbxportal', $path);
	unlink($path);
	assertSame('real-secret', $credentials['password'], 'password');
});

test('another section is not this user', function () {
	$path = ariFixture("[dograh]\npassword = dograh-secret\n[general]\nenabled = yes\n");
	$credentials = (new Voiceplane(null))->ariCredentials('pbxportal', $path);
	unlink($path);
	assertSame(null, $credentials, 'credentials');
});

test('a section with no password is not usable credentials', function () {
	$path = ariFixture("[pbxportal]\nread_only = yes\n");
	$credentials = (new Voiceplane(null))->ariCredentials('pbxportal', $path);
	unlink($path);
	assertSame(null, $credentials, 'credentials');
});

test('a missing file is null, not a fatal', function () {
	assertSame(null, (new Voiceplane(null))->ariCredentials('pbxportal', '/nonexistent/ari.conf'));
});

// ── the promise: this module cannot write ───────────────────────────────────
test('the module has no POST path for the framework to route into', function () {
	$class = file_get_contents(__DIR__ . '/../Voiceplane.class.php');
	// The *method* must not exist. A comment naming it is the point of the
	// comment, so the check is for a definition, not for the string.
	assertFalse((bool) preg_match('/function\s+doConfigPageInit/', $class),
		'doConfigPageInit must not be defined — it is where a FreePBX module handles a POST');
});

test('the module only ever GETs', function () {
	$class = file_get_contents(__DIR__ . '/../Voiceplane.class.php');
	foreach (array('CURLOPT_POST', 'CURLOPT_CUSTOMREQUEST', 'curl_setopt($handle, CURLOPT_PUT', 'CURLOPT_UPLOAD') as $verb) {
		assertFalse(strpos($class, $verb) !== false, $verb . ' must not appear');
	}
	assertTrue(strpos($class, 'CURLOPT_RETURNTRANSFER') !== false, 'the one GET it makes');
});

test('the page has no form to submit', function () {
	$view = file_get_contents(__DIR__ . '/../page.voiceplane.php')
		. file_get_contents(__DIR__ . '/../views/voiceplane/main.php');
	assertFalse(strpos($view, '<form') !== false, 'no <form> in the page');
});

echo "\n{$checks} check(s), {$failures} failure(s)\n";
exit($failures === 0 ? 0 : 1);
