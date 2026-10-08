import {
  NAMESPACE, DEPLOYMENT, fingerprint, checkOnlyCommand, attestationArgs, verifyReleaseProof,
  validateState, buildPatch, checkProjectedDeployment, validateImageInventory,
} from './application-promotion-contract.mjs';
import { checkRemoteAgentProviderConfig } from './check-remote-agent-provider-config.mjs';

function requireThat(condition, message) { if (!condition) throw new Error(`Application promotion refused: ${message}`); }

// All cluster/CLI I/O is injected. Tests use synthetic in-memory state, never production credentials.
export async function promoteApplication({
  mode, baseline, approvedBaselineHash, release, approvedReleaseHash, env = {}, readState, readTools, run,
  writeReceipt, readImageInventory, receipt, restoreOriginalStartup = false, verifyProvider = checkRemoteAgentProviderConfig,
}) {
  requireThat(['dry-run', 'apply', 'rollback'].includes(mode), 'unsupported mode');
  requireThat(approvedBaselineHash === fingerprint(baseline), 'reviewed baseline hash differs');
  requireThat(approvedReleaseHash === fingerprint(release), 'reviewed release hash differs');
  const identity = verifyReleaseProof(release);
  const rollback = mode === 'rollback';
  requireThat(!restoreOriginalStartup || rollback, 'startup restoration is rollback-only');
  if (mode !== 'dry-run') {
    requireThat(env.ALLOW_PROD_WRITE === 'yes' && env.HUMAN_APPROVED === 'yes'
      && /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(env.CHANGE_TICKET ?? ''), 'explicit production approval and ticket required');
  }
  if (restoreOriginalStartup) {
    requireThat(env.ACKNOWLEDGE_STARTUP_UPGRADE === 'yes', 'restoring automatic upgrades needs separate acknowledgement');
  }
  if (rollback) {
    requireThat(receipt?.version === 1 && receipt.baselineHash === approvedBaselineHash
      && receipt.releaseHash === fingerprint(release) && ['applied', 'needs-verification'].includes(receipt.status), 'matching applied receipt required');
  }

  // The same real verifier is mandatory for dry-run, apply and rollback. No bypass flag exists.
  await run('gh', attestationArgs(release));
  const imageReferences = [...new Set([baseline.app.image, ...Object.values(baseline.init).map((i) => i.image), release.image])];
  const checkInventory = async () => validateImageInventory(await readImageInventory(imageReferences), baseline, release);
  await checkInventory();
  const phase = rollback ? 'after' : 'before';
  const checkProvider = (state) => {
    try { verifyProvider(state.provider.data['providers.yaml'], { sourceName: 'mounted immutable provider snapshot' }); }
    catch { throw new Error('Application promotion refused: mounted provider contract failed; values suppressed'); }
  };
  const check = (state) => {
    validateState(state, baseline, release, phase);
    checkProvider(state);
  };
  const before = await readState();
  check(before);
  const tools = await readTools(before);
  requireThat(tools.geminiExecutable === true && tools.geminiAuthPresent === true
    && tools.kimiExecutable === true && tools.kimiPythonExecutable === true
    && tools.kimiVersion === baseline.kimiVersion, 'installed tools or auth-presence prerequisites changed');
  const patch = buildPatch(before, baseline, release, { rollback, restoreOriginalStartup });
  const args = ['-n', NAMESPACE, 'patch', 'deployment', DEPLOYMENT, '--type=json', '--patch', JSON.stringify(patch)];
  const projected = JSON.parse(await run('kubectl', [...args, '--dry-run=server', '-o', 'json']));
  checkProjectedDeployment(projected, before.deployment, patch);

  // Re-read all mutable observations after admission/dry-run, immediately before applying.
  const fresh = await readState();
  check(fresh);
  requireThat(fresh.deployment.metadata.resourceVersion === before.deployment.metadata.resourceVersion,
    'deployment changed after dry-run');
  requireThat(fingerprint(await readTools(fresh)) === fingerprint(tools), 'tool state changed after dry-run');
  await checkInventory();
  if (mode === 'dry-run') return { decision: 'dry_run_pass', image: identity.image, baselineHash: approvedBaselineHash };

  const record = {
    version: 1, baselineHash: approvedBaselineHash, releaseHash: fingerprint(release),
    targetImage: identity.image, targetImageId: identity.imageId, sourceCommit: identity.sourceCommit,
    ticket: env.CHANGE_TICKET, status: 'needs-verification', action: mode,
    rollbackStartupPolicy: restoreOriginalStartup ? 'original-auto-upgrade' : 'check-only',
    pvcRestorationClaimed: false,
  };
  // Retain a bounded, value-free receipt before mutation so an interrupted client is recoverable.
  await writeReceipt(record);
  const observed = JSON.parse(await run('kubectl', [...args, '-o', 'json']));
  checkProjectedDeployment(observed, before.deployment, patch);
  await run('kubectl', ['-n', NAMESPACE, 'rollout', 'status', `deployment/${DEPLOYMENT}`, '--timeout=300s']);
  const after = await readState();
  validateState(after, baseline, release, rollback
    ? (restoreOriginalStartup ? 'rollback-original' : 'rollback-preserve') : 'after');
  checkProvider(after);
  requireThat(fingerprint(await readTools(after)) === fingerprint(tools), 'tool state changed during rollout; PVC was not restored');
  await checkInventory();
  record.status = rollback ? 'rolled-back' : 'applied';
  await writeReceipt(record);
  return { decision: record.status, image: rollback ? baseline.app.image : identity.image,
    startupPolicy: rollback && restoreOriginalStartup ? 'original-auto-upgrade' : 'check-only', pvcRestorationClaimed: false };
}

export { checkOnlyCommand };
