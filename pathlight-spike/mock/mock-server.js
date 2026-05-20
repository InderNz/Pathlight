const http = require('http');

// In-memory store of registered emails for this session
const registeredEmails = new Set();

const server = http.createServer(function(req, res) {

  if (req.method === 'POST' && req.url === '/api/waitlist') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var email = data.email ? data.email.toLowerCase() : null;

        if (!email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Email is required' }));
        }

        if (registeredEmails.has(email)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: 'Email already registered'
          }));
        }

        registeredEmails.add(email);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: 'Registered successfully',
          email: email
        }));

      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });

  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(3000, function() {
  console.log('[mock] ZovKu mock server running on http://localhost:3000');
  console.log('[mock] POST /api/waitlist');
  console.log('[mock]   first call with a given email  → 201 Created');
  console.log('[mock]   second call with same email     → 409 Conflict');
});
