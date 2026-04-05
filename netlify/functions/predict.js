// Claude API proxy for market predictions
// Keeps the API key server-side instead of exposing it in the browser

exports.handler = async function(event) {
  var H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: H, body: '' };
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
