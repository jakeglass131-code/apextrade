// Claude API proxy for market predictions
// Keeps the API key server-side instead of exposing it in the browser

// Allowed origins — anything else is rejected so random callers can't burn credits.
// Override in Netlify env var ALLOWED_ORIGINS (comma-separated) if you add a custom domain.
var DEFAULT_ALLOWED_ORIGINS = [
  'https://apextrade-proxy.netlify.app',
  'https://apextrade.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000',
  'http://127.0.0.1:8888'
];

function getAllowedOrigins() {
  var env = (process.env.ALLOWED_ORIGINS || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  return env.length ? env : DEFAULT_ALLOWED_ORIGINS;
}

function pickOrigin(event) {
  var origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  var allowed = getAllowedOrigins();
  return allowed.indexOf(origin) !== -1 ? origin : '';
}

exports.handler = async function(event) {
  var allowOrigin = pickOrigin(event);
  var H = {
    'Access-Control-Allow-Origin': allowOrigin || 'null',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: H, body: '' };
  }

  // Reject callers from non-allowlisted origins
  if (!allowOrigin) {
    return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Origin not allowed' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'POST required' }) };
  }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      headers: H,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on server' })
    };
  }

  try {
    var body = JSON.parse(event.body || '{}');
    var prompt = body.prompt;
    if (!prompt || typeof prompt !== 'string') {
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'prompt required' }) };
    }

    // Cap max_tokens to prevent abuse
    var maxTokens = Math.min(body.max_tokens || 1500, 2000);

    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      var errText = await resp.text();
      return {
        statusCode: resp.status,
        headers: H,
        body: JSON.stringify({ error: 'Claude API error: ' + resp.status, detail: errText })
      };
    }

    var data = await resp.json();
    return { statusCode: 200, headers: H, body: JSON.stringify(data) };
  } catch (err) {
    return {
      statusCode: 500,
      headers: H,
      body: JSON.stringify({ error: err.message })
    };
  }
};
