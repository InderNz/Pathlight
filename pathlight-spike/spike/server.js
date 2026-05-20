const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// Load manifest on startup — used throughout the server
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'pathlight-manifest.json'), 'utf8')
);

// In-memory run state
const runState = {
  runId:       'run_001',
  status:      'pending',
  startedAt:   null,
  finishedAt:  null,
  testResults: {}
};

// SSE clients and event buffer
const sseClients  = new Set();
const eventBuffer = [];
const EVENT_BUFFER_MAX = 100;
let eventCounter = 0;

// Create reports directory on startup
fs.mkdirSync(path.join('reports', 'run_001', 'artifacts'), { recursive: true });

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function broadcast(event) {
  const data = 'id: ' + event.eventId + '\ndata: ' +
    JSON.stringify(event) + '\n\n';
  sseClients.forEach(function(client) {
    client.write(data);
  });
  // Append to events.jsonl — only reporter-sourced events
  fs.appendFileSync('events.jsonl', JSON.stringify(event) + '\n');
  // Keep buffer
  eventBuffer.push(event);
  if (eventBuffer.length > EVENT_BUFFER_MAX) eventBuffer.shift();
}

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/manifest', function(req, res) {
  res.json(manifest);
});

app.get('/api/run', function(req, res) {
  res.json({
    runId:       runState.runId,
    status:      runState.status,
    testResults: runState.testResults
  });
});

app.get('/api/stream', function(req, res) {
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Replay missed events using last-event-id header
  var lastEventId = req.headers['last-event-id'];
  if (lastEventId) {
    var lastIdx = eventBuffer.findIndex(function(e) {
      return e.eventId === lastEventId;
    });
    if (lastIdx !== -1) {
      eventBuffer.slice(lastIdx + 1).forEach(function(event) {
        res.write('id: ' + event.eventId + '\ndata: ' +
          JSON.stringify(event) + '\n\n');
      });
    }
  } else {
    // New client — replay all buffered events to restore state
    eventBuffer.forEach(function(event) {
      res.write('id: ' + event.eventId + '\ndata: ' +
        JSON.stringify(event) + '\n\n');
    });
  }

  sseClients.add(res);
  console.log('[pathlight] SSE client connected — total: ' +
    sseClients.size);

  // Heartbeat every 15 seconds
  var heartbeat = setInterval(function() {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', function() {
    sseClients.delete(res);
    clearInterval(heartbeat);
    console.log('[pathlight] SSE client disconnected — total: ' +
      sseClients.size);
  });
});

app.post('/api/events', function(req, res) {
  var event = req.body;

  // Validate required fields
  if (!event.eventId || !event.runId || !event.type || !event.timestamp) {
    return res.status(400).json({ error: 'Missing required event fields' });
  }

  // Increment server-side counter for synthetic events
  eventCounter++;

  // Update run state
  switch (event.type) {

    case 'run.started':
      runState.status    = 'running';
      runState.startedAt = event.timestamp;
      console.log('[pathlight] Run started — ' + event.runId);
      break;

    case 'test.started':
      if (event.payload && event.payload.testId) {
        runState.testResults[event.payload.testId] = { status: 'running' };
      }
      console.log('[pathlight] Test started — ' +
        (event.payload && event.payload.testId));
      break;

    case 'test.passed':
      if (event.payload && event.payload.testId) {
        runState.testResults[event.payload.testId] = {
          status:   'passed',
          duration: event.payload.duration
        };
      }
      console.log('[pathlight] Test passed — ' +
        (event.payload && event.payload.testId) +
        ' (' + (event.payload && event.payload.duration) + 'ms)');
      break;

    case 'test.failed':
      if (event.payload && event.payload.testId) {
        runState.testResults[event.payload.testId] = {
          status:   'failed',
          duration: event.payload.duration,
          error:    event.payload.error
        };
      }
      console.log('[pathlight] Test FAILED — ' +
        (event.payload && event.payload.testId) + ': ' +
        (event.payload && event.payload.error));
      break;

    case 'run.finished':
      runState.status      = 'completed';
      runState.finishedAt  = event.timestamp;
      console.log('[pathlight] Run finished — ' +
        (event.payload && event.payload.passed) + '/' +
        (event.payload && event.payload.total) + ' passed');
      // Generate report after 500ms to ensure all events are flushed
      setTimeout(function() {
        generateReport(event.payload);
      }, 500);
      break;
  }

  // Broadcast to all SSE clients and write to events.jsonl
  broadcast(event);

  res.status(202).json({ received: true });
});

function generateReport(payload) {
  var reportDir = path.join('reports', 'run_001');
  fs.mkdirSync(reportDir, { recursive: true });

  // Use manifest.id — never hardcode the node ID
  var testId     = manifest.id;
  var testResult = runState.testResults[testId] || { status: 'unknown' };
  var passed     = testResult.status === 'passed';
  var finishedAt = new Date().toLocaleString('en-NZ');
  var duration   = testResult.duration
    ? testResult.duration + 'ms'
    : '—';

  var statusColour = passed ? '#1D9E75' : '#E24B4A';
  var statusBg     = passed ? '#EAF3DE' : '#FCEBEB';
  var statusLabel  = passed ? 'PASSED'  : 'FAILED';

  var errorHtml = testResult.error
    ? '<div class="error-block"><strong>Error:</strong> ' +
        escapeHtml(testResult.error) + '</div>'
    : '';

  var businessRulesHtml = manifest.businessRules.map(function(rule) {
    return '<div class="br-row">\u2713 ' + escapeHtml(rule) + '</div>';
  }).join('');

  var html = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>Pathlight Run Report \u2014 ' + runState.runId + '</title>\n' +
'<style>\n' +
'* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;\n' +
'  background: #F1EFE8; color: #2C2C2A; padding: 32px; }\n' +
'.wrap { max-width: 760px; margin: 0 auto; }\n' +
'.logo { font-size: 11px; font-weight: 600; color: #2B6CB0;\n' +
'  letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }\n' +
'h1 { font-size: 22px; font-weight: 500; color: #1A3C5E; margin-bottom: 4px; }\n' +
'.meta { font-size: 12px; color: #888780; margin-bottom: 24px; }\n' +
'.card { background: #fff; border: 0.5px solid rgba(44,44,42,.12);\n' +
'  border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; }\n' +
'.card-title { font-size: 13px; font-weight: 500; color: #1A3C5E; margin-bottom: 12px; }\n' +
'.badge { display: inline-block; padding: 5px 16px; border-radius: 20px;\n' +
'  font-size: 13px; font-weight: 600;\n' +
'  background: ' + statusBg + '; color: ' + statusColour + '; }\n' +
'.metrics { display: grid; grid-template-columns: repeat(4,1fr);\n' +
'  gap: 12px; margin: 16px 0; }\n' +
'.metric { background: #F5F3EC; border-radius: 8px; padding: 14px; text-align: center; }\n' +
'.metric-num { font-size: 28px; font-weight: 500; }\n' +
'.metric-lbl { font-size: 11px; color: #888780; margin-top: 4px; }\n' +
'table { width: 100%; border-collapse: collapse; font-size: 13px; }\n' +
'th { padding: 8px 12px; text-align: left; font-weight: 500;\n' +
'  color: #888780; font-size: 11px; background: #F5F3EC; }\n' +
'td { padding: 8px 12px; border-top: 0.5px solid #E2E8F0; }\n' +
'code { font-family: "Courier New", monospace; font-size: 11px; }\n' +
'.s-pass { color: #1D9E75; font-weight: 500; }\n' +
'.s-fail { color: #E24B4A; font-weight: 500; }\n' +
'.error-block { margin-top: 12px; padding: 12px 16px;\n' +
'  background: #FFF5F5; border: 0.5px solid #E24B4A;\n' +
'  border-radius: 8px; font-size: 12px; color: #9B2335;\n' +
'  font-family: "Courier New", monospace; }\n' +
'.br-row { font-size: 13px; color: #4A5568; padding: 6px 0;\n' +
'  border-bottom: 0.5px solid #E2E8F0; }\n' +
'.footer { text-align: center; font-size: 11px; color: #888780; margin-top: 24px; }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="wrap">\n' +
'  <div class="logo">Pathlight \u00b7 Test Intelligence Platform</div>\n' +
'  <h1>Run Report \u2014 ' + runState.runId + '</h1>\n' +
'  <div class="meta">' + manifest.projectKey + ' \u00b7 ' +
    manifest.stage + ' \u00b7 ' + finishedAt + '</div>\n' +
'\n' +
'  <div class="card">\n' +
'    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">\n' +
'      <div>\n' +
'        <div style="font-size:15px;font-weight:500;color:#1A3C5E">Stage 1 \u2014 Landing + Waitlist</div>\n' +
'        <div style="font-size:12px;color:#888780;margin-top:3px">Spike run \u00b7 Single test \u00b7 Assumptions A1\u2013A4</div>\n' +
'      </div>\n' +
'      <span class="badge">' + statusLabel + '</span>\n' +
'    </div>\n' +
'    <div class="metrics">\n' +
'      <div class="metric">\n' +
'        <div class="metric-num">' + (payload && payload.total || 1) + '</div>\n' +
'        <div class="metric-lbl">Total</div>\n' +
'      </div>\n' +
'      <div class="metric">\n' +
'        <div class="metric-num" style="color:#1D9E75">' +
          (payload && payload.passed || 0) + '</div>\n' +
'        <div class="metric-lbl">Passed</div>\n' +
'      </div>\n' +
'      <div class="metric">\n' +
'        <div class="metric-num" style="color:' +
          ((payload && payload.failed > 0) ? '#E24B4A' : '#888780') + '">' +
          (payload && payload.failed || 0) + '</div>\n' +
'        <div class="metric-lbl">Failed</div>\n' +
'      </div>\n' +
'      <div class="metric">\n' +
'        <div class="metric-num" style="color:#2B6CB0">' + duration + '</div>\n' +
'        <div class="metric-lbl">Duration</div>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <div class="card">\n' +
'    <div class="card-title">Test Result</div>\n' +
'    <table>\n' +
'      <thead><tr>\n' +
'        <th>Manifest Node ID</th>\n' +
'        <th>Label</th>\n' +
'        <th>Branch Type</th>\n' +
'        <th>Status</th>\n' +
'        <th>Duration</th>\n' +
'      </tr></thead>\n' +
'      <tbody><tr>\n' +
'        <td><code>' + escapeHtml(testId) + '</code></td>\n' +
'        <td>' + escapeHtml(manifest.label) + '</td>\n' +
'        <td>' + escapeHtml(manifest.branchType) + '</td>\n' +
'        <td class="' + (passed ? 's-pass' : 's-fail') + '">' +
          escapeHtml(testResult.status || '\u2014') + '</td>\n' +
'        <td>' + duration + '</td>\n' +
'      </tr></tbody>\n' +
'    </table>\n' +
'    ' + errorHtml + '\n' +
'  </div>\n' +
'\n' +
'  <div class="card">\n' +
'    <div class="card-title">Business Rules Covered</div>\n' +
'    ' + businessRulesHtml + '\n' +
'  </div>\n' +
'\n' +
'  <div class="footer">\n' +
'    Pathlight Spike \u00b7 ' + manifest.projectKey +
      ' \u00b7 Run ' + runState.runId + ' \u00b7 ' + finishedAt + '<br>\n' +
'    <small>Spike output \u2014 throwaway code \u2014 not production.</small>\n' +
'  </div>\n' +
'</div>\n' +
'</body>\n' +
'</html>\n';

  fs.writeFileSync(path.join(reportDir, 'report.html'), html);

  var summary = {
    runId:       runState.runId,
    projectKey:  manifest.projectKey,
    stage:       manifest.stage,
    finishedAt:  finishedAt,
    total:       payload && payload.total   || 1,
    passed:      payload && payload.passed  || 0,
    failed:      payload && payload.failed  || 0,
    duration:    payload && payload.duration || 0,
    testResults: runState.testResults
  };
  fs.writeFileSync(
    path.join(reportDir, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log('[pathlight] Report ready — ' +
    path.join(reportDir, 'report.html'));

  // Broadcast report.ready event to browser
  // This event is NOT written to events.jsonl — it is server-generated
  eventCounter++;
  var reportEvent = {
    eventId:   'evt_' + String(eventCounter).padStart(4, '0'),
    runId:     runState.runId,
    type:      'report.ready',
    timestamp: new Date().toISOString(),
    payload:   { path: path.join(reportDir, 'report.html') }
  };
  var sseData = 'id: ' + reportEvent.eventId + '\ndata: ' +
    JSON.stringify(reportEvent) + '\n\n';
  sseClients.forEach(function(client) {
    client.write(sseData);
  });
}

process.on('uncaughtException', function(err) {
  console.error('[pathlight] Uncaught exception:', err.message);
});

app.listen(4242, function() {
  console.log('[pathlight] Server ready — http://localhost:4242');
  console.log('[pathlight] Manifest loaded — ' +
    manifest.id + ': ' + manifest.label);
});
