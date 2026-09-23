<?php
/**
 * The voice-plane view: the plan next to the routes, and what is live.
 *
 * Every state the two halves can be in is rendered as a sentence rather than a
 * blank cell — an unreachable portal, an unconfigured one, an entitlement gate
 * refusing to publish, no credentials for ARI. A monitoring page whose empty
 * state looks the same as its healthy state is the thing this page exists to
 * replace, so "no data" always says which "no data" it is.
 *
 * @var array $report  from Voiceplane::report()
 */
if (!defined('FREEPBX_IS_AUTH')) {
	die('No direct script access allowed');
}

$e = function ($value) {
	return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
};

// ARI reports an unknown caller as an empty string, not as a missing key, so
// `?? '—'` would render a blank cell where the page means "unknown".
$show = function ($value) use ($e) {
	$value = trim((string) $value);
	return $value === '' ? '<span class="text-muted">—</span>' : $e($value);
};

$plan = $report['plan'];
$counts = $report['counts'];
$rows = $report['rows'];
$channels = $report['channels'];

// The verdicts that are findings, and how they read to an operator. Ordered so
// the loudest is first; `ok` is not in here on purpose (a healthy row is a row).
$verdicts = array(
	'unrouted' => array('danger', 'No inbound route', 'The plan names this DID; this PBX has nothing answering it.'),
	'elsewhere' => array('warning', 'Routed elsewhere', 'The route exists but does not reach the voice plane — it still answers a call, as the wrong thing.'),
	'unplanned' => array('warning', 'Not in the plan', 'This PBX sends it into the voice plane, but the portal does not name it — the plan is the routing authority.'),
	'other-service' => array('default', 'Other service', 'Not the voice plane and not the plan: somebody else\'s phone service.'),
	'ok' => array('success', 'Reaches the voice plane', ''),
);

$plan_state = array(
	'not-configured' => array('warning', 'No portal configured',
		'Set the portal URL and the sync token (the installer writes config.json, or set VOICEPLANE_PORTAL_URL / VOICEPLANE_PBX_SYNC_TOKEN in the container environment). The route table below is still this PBX\'s own answer.'),
	'unreachable' => array('danger', 'Portal unreachable', 'The route table below is still this PBX\'s own answer; the plan half is missing.'),
	'unauthorised' => array('danger', 'Portal rejected the token',
		'The bearer token does not match the portal\'s PBX_SYNC_TOKEN — the same value the zeus-pbx-sync timer uses.'),
	'refused' => array('warning', 'Portal refused to publish a plan',
		'An indecisive entitlement gate (a rejected Magnate token, usually). The portal publishes nothing rather than a plan that reads as "not entitled" for every account, so the PBX keeps its last good fragment.'),
	'unreadable' => array('danger', 'Portal answered something unexpected', ''),
);
?>

<div class="row">
	<div class="col-sm-12">
		<h3 style="margin-top:0">
			<?php echo _('Routing') ?>
			<span class="label label-success"><?php echo (int) $counts['ok'] ?> <?php echo _('routed') ?></span>
			<?php if ($counts['findings'] > 0): ?>
				<span class="label label-danger"><?php echo (int) $counts['findings'] ?> <?php echo _('finding(s)') ?></span>
			<?php else: ?>
				<span class="label label-success"><?php echo _('no findings') ?></span>
			<?php endif; ?>
			<small class="text-muted">
				<?php echo sprintf(_('%d DID(s) across the plan and this PBX\'s routes'), (int) $counts['total']) ?>
			</small>
		</h3>
	</div>
</div>

<div class="panel panel-default">
	<div class="panel-heading">
		<strong><?php echo _('The plan (the portal\'s own answer)') ?></strong>
	</div>
	<div class="panel-body">
		<?php if ($plan['ok'] ?? false): ?>
			<p class="text-muted" style="margin-bottom:6px">
				<?php echo sprintf(
					_('Generated %s · entitlement gate: %s (%s) · %d account(s)'),
					$e($plan['generated_at'] ?? _('unknown')),
					$e($plan['gate']['mode'] ?? _('unknown')),
					$e($plan['gate']['reason'] ?? ''),
					count($plan['accounts'] ?? array())
				) ?>
			</p>
			<?php if (!empty($plan['capstone_not_enabled'])): ?>
				<p class="text-muted" style="margin-bottom:0">
					<?php echo _('Not entitled to the Capstone hand-off (its line still answers, on the AVA agent):') ?>
					<?php echo $e(implode(', ', array_map(function ($row) {
						return $row['did'] ?? '';
					}, $plan['capstone_not_enabled']))) ?>
				</p>
			<?php endif; ?>
		<?php else: ?>
			<?php
			$state = $plan_state[$plan['reason'] ?? 'unreadable'] ?? reset($plan_state);
			?>
			<p class="text-<?php echo $e($state[0]) ?>" style="margin-bottom:6px">
				<strong><?php echo $e($state[1]) ?></strong>
				<?php echo $e($state[2]) ?>
			</p>
			<?php if (!empty($plan['detail'])): ?>
				<p class="text-muted" style="margin-bottom:0"><code><?php echo $e($plan['detail']) ?></code></p>
			<?php endif; ?>
		<?php endif; ?>
	</div>
</div>

<div class="table-responsive">
	<table class="table table-striped table-condensed">
		<thead>
			<tr>
				<th><?php echo _('DID') ?></th>
				<th><?php echo _('This PBX routes it to') ?></th>
				<th><?php echo _('Agent') ?></th>
				<th><?php echo _('Capstone hand-off') ?></th>
				<th><?php echo _('Verdict') ?></th>
			</tr>
		</thead>
		<tbody>
			<?php if (empty($rows)): ?>
				<tr>
					<td colspan="5" class="text-muted">
						<?php echo _('No DID is named by the plan or routed by this PBX. Nothing to compare yet.') ?>
					</td>
				</tr>
			<?php endif; ?>
			<?php foreach ($rows as $row): ?>
				<?php
				$account = $row['plan'];
				$verdict = $verdicts[$row['verdict']] ?? $verdicts['other-service'];
				$addon = $account === null
					? ''
					: (($account['capstone_addon'] ?? false)
						? ((string) ($account['capstone_target'] ?? '') !== ''
							? sprintf(_('yes → %s'), $e($account['capstone_target']))
							: _('yes'))
						: _('no — AVA answers'));
				?>
				<tr>
					<td>
						<strong><?php echo $e($row['did']) ?></strong>
						<?php if ((int) $row['route_count'] > 1): ?>
							<br><small class="text-danger">
								<?php echo sprintf(_('%d inbound routes for this DID'), (int) $row['route_count']) ?>
							</small>
						<?php endif; ?>
					</td>
					<td>
						<?php if ($row['route'] === null): ?>
							<span class="text-muted"><?php echo _('— no inbound route —') ?></span>
						<?php else: ?>
							<code><?php echo $e($row['destination']) ?></code>
							<?php if (trim((string) ($row['route']['description'] ?? '')) !== ''): ?>
								<br><small class="text-muted"><?php echo $e($row['route']['description']) ?></small>
							<?php endif; ?>
						<?php endif; ?>
					</td>
					<td>
						<?php if ($account === null): ?>
							<span class="text-muted"><?php echo _('not in the plan') ?></span>
						<?php else: ?>
							<?php echo $show($account['agent'] ?? '') ?>
							<?php if (trim((string) ($account['provider'] ?? '')) !== ''): ?>
								<br><small class="text-muted"><?php echo $e($account['provider']) ?></small>
							<?php endif; ?>
						<?php endif; ?>
					</td>
					<td><?php echo $addon ?></td>
					<td>
						<span class="label label-<?php echo $e($verdict[0]) ?>"><?php echo $e($verdict[1]) ?></span>
						<?php if ($verdict[2] !== '' && $row['verdict'] !== 'ok'): ?>
							<br><small class="text-muted"><?php echo $e($verdict[2]) ?></small>
						<?php endif; ?>
					</td>
				</tr>
			<?php endforeach; ?>
		</tbody>
	</table>
</div>

<div class="panel panel-default">
	<div class="panel-heading">
		<strong><?php echo _('Live channels') ?></strong>
		<?php if ($channels['ok'] ?? false): ?>
			<span class="label label-<?php echo count($channels['channels']) > 0 ? 'warning' : 'success' ?>">
				<?php echo sprintf(_('%d active'), count($channels['channels'])) ?>
			</span>
		<?php endif; ?>
	</div>
	<div class="panel-body">
		<?php if (!($channels['ok'] ?? false)): ?>
			<p class="text-muted" style="margin-bottom:0">
				<?php
				$reason = $channels['reason'] ?? 'unreachable';
				if ($reason === 'no-credentials') {
					echo sprintf(_('No ARI credentials: %s has no readable [%s] section, so the channel list cannot be read.'),
							$e($report['settings']['ari_config']), $e($report['settings']['ari_user']));
				} elseif ($reason === 'unauthorised') {
					echo _('Asterisk refused the ARI credentials (401). The engine and the PBX disagree about the ARI secret — run pbx/ava_ari_check.py.');
				} else {
					echo sprintf(_('Asterisk\'s ARI is not answering at %s.'), $e($report['settings']['ari_url']));
				}
				?>
			</p>
		<?php elseif (empty($channels['channels'])): ?>
			<p class="text-muted" style="margin-bottom:0"><?php echo _('No channels are up.') ?></p>
		<?php else: ?>
			<table class="table table-condensed" style="margin-bottom:0">
				<thead>
					<tr>
						<th><?php echo _('Channel') ?></th>
						<th><?php echo _('State') ?></th>
						<th><?php echo _('Caller') ?></th>
						<th><?php echo _('Connected to') ?></th>
					</tr>
				</thead>
				<tbody>
					<?php foreach ($channels['channels'] as $channel): ?>
						<tr>
							<td><code><?php echo $e($channel['name'] ?? '') ?></code></td>
							<td><?php echo $show($channel['state'] ?? '') ?></td>
							<td><?php echo $show($channel['caller']['number'] ?? '') ?></td>
							<td><?php echo $show($channel['connected']['number'] ?? '') ?></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
	</div>
</div>

<?php if (!empty($report['internal'])): ?>
	<div class="panel panel-default">
		<div class="panel-heading">
			<strong><?php echo _('Internal routes (not DIDs)') ?></strong>
			<span class="label label-default"><?php echo count($report['internal']) ?></span>
		</div>
		<div class="panel-body">
			<p class="text-muted">
				<?php echo _('Extensions, not numbers: a plan is per DID, so these are listed rather than compared — an agent extension added tomorrow must not read as a routing finding.') ?>
			</p>
			<table class="table table-condensed" style="margin-bottom:0">
				<tbody>
					<?php foreach ($report['internal'] as $route): ?>
						<tr>
							<td><?php echo $e(trim((string) ($route['extension'] ?? '')) !== '' ? $route['extension'] : _('(any)')) ?></td>
							<td><code><?php echo $e($route['destination'] ?? '') ?></code></td>
							<td class="text-muted"><?php echo $e($route['description'] ?? '') ?></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		</div>
	</div>
<?php endif; ?>

<p class="text-muted">
	<?php echo _('This page only ever GETs: it has no form and no POST handler, so it cannot re-route a call. Routing is authored in the portal\'s voice screen') ?>
	<?php if ($report['portal_configured']): ?>
		— <a href="<?php echo $e($report['voice_screen_url']) ?>" target="_blank" rel="noopener">
			<?php echo $e($report['voice_screen_url']) ?>
		</a>
	<?php endif; ?>
	<?php echo _('— and applied by the platform\'s own tools (pbx/ava_routes.py, Capstone\'s sync).') ?>
</p>
