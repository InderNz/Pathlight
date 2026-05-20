const http = require('http');

function extractManifestNodeId(testTitle) {
  const match = testTitle.match(/@pathlight:([^\s]+)/);
  return match ? match[1] : null;
}

function postEvent(event) {
  return new Promise((resolve) => {
    const body = JSON.stringify(event);
    const options = {
      hostname: 'localhost',
      port: 4242,
      path: '/api/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = http.request(options, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', (err) => {
      process.stderr.write(
        `[pathlight-reporter] Server unreachable: ${err.message}\n`
      );
      resolve(); // Never reject — must not affect the test run
    });
    req.setTimeout(2000, () => {
      process.stderr.write(
        '[pathlight-reporter] Server timeout — skipping event\n'
      );
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

class PathlightReporter {

  constructor(options) {
    this.serverUrl  = (options && options.serverUrl) || 'http://localhost:4242';
    this.runId      = (options && options.runId)      || 'run_001';
    this.eventCount = 0;
    this.runStartTime  = null;
    // Track counts manually — FullResult.stats is not reliable
    this.totalTests  = 0;
    this.passedTests = 0;
    this.failedTests = 0;
  }

  buildEvent(type, payload) {
    this.eventCount++;
    const event = {
      eventId:   'evt_' + String(this.eventCount).padStart(4, '0'),
      runId:     this.runId,
      type:      type,
      timestamp: new Date().toISOString()
    };
    if (payload) {
      event.payload = payload;
    }
    return event;
  }

  async onBegin(config, suite) {
    this.runStartTime = Date.now();
    const event = this.buildEvent('run.started');
    await postEvent(event);
  }

  async onTestBegin(test, result) {
    const testId = extractManifestNodeId(test.title);
    if (!testId) {
      process.stderr.write(
        `[pathlight-reporter] No @pathlight: tag found in: ${test.title}\n`
      );
      return;
    }
    const event = this.buildEvent('test.started', { testId: testId });
    await postEvent(event);
  }

  async onTestEnd(test, result) {
    const testId = extractManifestNodeId(test.title);
    if (!testId) return;

    const duration = result.duration;

    // Increment counts here — do not rely on FullResult.stats
    this.totalTests++;

    if (result.status === 'passed') {
      this.passedTests++;
      const event = this.buildEvent('test.passed', {
        testId:   testId,
        duration: duration
      });
      await postEvent(event);
    } else {
      this.failedTests++;
      const errorMessage = (result.error && result.error.message)
        ? result.error.message
        : result.status;
      const event = this.buildEvent('test.failed', {
        testId:   testId,
        duration: duration,
        error:    errorMessage
      });
      await postEvent(event);
    }
  }

  async onEnd(result) {
    const duration = Date.now() - this.runStartTime;
    // Use manually tracked counts — not result.stats
    const event = this.buildEvent('run.finished', {
      total:    this.totalTests,
      passed:   this.passedTests,
      failed:   this.failedTests,
      duration: duration
    });
    await postEvent(event);
  }

  onStdOut(chunk, test, result) {}
  onStdErr(chunk, test, result) {}
}

module.exports = PathlightReporter;
