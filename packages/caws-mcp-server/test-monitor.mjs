#!/usr/bin/env node

import { CawsMonitor } from './src/monitoring/index.js';

async function testMonitor() {
  console.log('Testing CAWS Monitor...');

  const monitor = new CawsMonitor({
    pollingInterval: 5000,
    watchPaths: ['.caws'],
  });

  try {
    await monitor.start();
    console.log('✅ Monitor started successfully');

    // Wait a bit for initialization
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get status
    const status = monitor.getStatus();
    console.log('📊 Current Status:');
    console.log(JSON.stringify(status, null, 2));

    // Stop monitor
    await monitor.stop();
    console.log('✅ Monitor stopped successfully');
  } catch (error) {
    console.error('❌ Monitor test failed:', error.message);
    console.error(error.stack);
  }
}

testMonitor();
