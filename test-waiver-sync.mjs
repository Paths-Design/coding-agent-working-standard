const WaiversManager = require('./packages/caws-cli/dist/waivers-manager.js');

const testWaiver = {
  id: 'WV-DIRECT-TEST',
  title: 'Direct Test Waiver',
  reason: 'emergency_hotfix',
  description: 'Direct test',
  gates: ['budget_limit'],
  expires_at: '2025-12-31T23:59:59Z',
  approved_by: '@test',
  impact_level: 'low',
  mitigation_plan: 'Test mitigation',
  created_at: new Date().toISOString(),
};

async function test() {
  try {
    console.log('Creating WaiversManager...');
    const wm = new WaiversManager();
    console.log('Loading active waivers...');
    const activeWaivers = await wm.loadActiveWaivers();
    console.log(`Loaded ${activeWaivers.length} waivers`);

    const normalizedWaiver = {
      id: testWaiver.id,
      title: testWaiver.title,
      reason: testWaiver.reason,
      description: testWaiver.description,
      gates: testWaiver.gates,
      expires_at: testWaiver.expires_at,
      approved_by: testWaiver.approved_by,
      created_at: testWaiver.created_at,
      risk_assessment: {
        impact_level: testWaiver.impact_level,
        mitigation_plan: testWaiver.mitigation_plan,
      },
      metadata: {},
    };

    activeWaivers.push(normalizedWaiver);
    console.log(`Saving ${activeWaivers.length} waivers...`);
    await wm.saveActiveWaivers(activeWaivers);
    console.log('✅ Success!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

test();
