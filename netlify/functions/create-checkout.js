const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  pro_monthly: {
    price: process.env.STRIPE_PRICE_PRO_MONTHLY,
    name: "Pro Monthly",
  },
  pro_yearly: {
    price: process.env.STRIPE_PRICE_PRO_YEARLY,
    name: "Pro Yearly",
  },
  elite_monthly: {
    price: process.env.STRIPE_PRICE_ELITE_MONTHLY,
    name: "Elite Monthly",
  },
  elite_yearly: {
    price: process.env.STRIPE_PRICE_ELITE_YEARLY,
    name: "Elite Yearly",
  },
};

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { plan, email } = JSON.parse(event.body || "{}");

    if (!plan || !PLANS[plan]) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid plan. Use: " + Object.keys(PLANS).join(", ") }),
      };
    }

    const priceId = PLANS[plan].price;
    if (!priceId) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Price ID not configured for this plan. Set STRIPE_PRICE_" + plan.toUpperCase() + " in Netlify env vars." }),
      };
    }

    const origin = event.headers.origin || event.headers.referer || "https://apextrade-proxy.netlify.app";
    const baseUrl = origin.replace(/\/+$/, "");

    const sessionParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { plan: plan },
      },
      success_url: `${baseUrl}/app.html?session_id={CHECKOUT_SESSION_ID}&welcome=1`,
      cancel_url: `${baseUrl}/#pricing`,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      tax_id_collection: { enabled: true },
    };

    // Pre-fill email if provided
    if (email) {
      sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url, sessionId: session.id }),
    };
  } catch (err) {
    console.error("Checkout error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
