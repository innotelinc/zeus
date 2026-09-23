<?php
/**
 * Zeus Voice Plane — the page handler.
 *
 * One display, no form: the module is a reading of two other systems, so there
 * is nothing here to submit and deliberately no `doConfigPageInit()` on the
 * class for the framework to route a POST into. `?view=` is accepted only
 * because every FreePBX page is asked for it; it changes nothing.
 *
 * See `Voiceplane.class.php` for why this is read-only, and `README.md` for how
 * the two halves are gathered.
 */
if (!defined('FREEPBX_IS_AUTH')) {
	die('No direct script access allowed');
}

$vp = \FreePBX::Voiceplane();
$report = $vp->report();
$helptext = _(
	'A read-only view of the voice plane: the routing plan the portal publishes, ' .
	'what this PBX actually routes for each of those DIDs, and the channels live ' .
	'right now. Routing is authored in the portal and applied by the platform\'s ' .
	'own tools — nothing on this page can change it.'
);
?>
<div class="container-fluid">
	<h1><?php echo _('Zeus Voice Plane') ?></h1>
	<div class="well well-info">
		<?php echo $helptext ?>
	</div>
	<div class="row">
		<div class="col-sm-12">
			<div class="fpbx-container">
				<div class="display no-border">
					<?php echo load_view(__DIR__ . '/views/voiceplane/main.php', array('report' => $report)) ?>
				</div>
			</div>
		</div>
	</div>
</div>
